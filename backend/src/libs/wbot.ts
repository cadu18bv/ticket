import * as Sentry from "@sentry/node";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { FindOptions } from "sequelize/types";
import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger";
import { useMultiFileAuthState } from "../helpers/useMultiFileAuthState";
import { Boom } from "@hapi/boom";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import cacheLayer from "../libs/cache";
import ImportWhatsAppMessageService from "../services/WhatsappService/ImportWhatsAppMessageService";
import { add } from "date-fns";
import moment from "moment";
import { getTypeMessage, isValidMsg } from "../services/WbotServices/wbotMessageListener";
import { addLogs } from "../helpers/addLogs";
import NodeCache from 'node-cache';
import { Op } from "sequelize";
import Contact from "../models/Contact";
import Ticket from "../models/Ticket";

const loggerBaileys = MAIN_LOGGER.child({});
loggerBaileys.level = "error";

type Session = WASocket & {
  id?: number;
};

const sessions: Session[] = [];

const retriesQrCodeMap = new Map<number, number>();

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }
  return sessions[sessionIndex];
};

export const restartWbot = async (
  companyId: number,
  session?: any
): Promise<void> => {
  try {
    const options: FindOptions = {
      where: {
        companyId,
      },
      attributes: ["id"],
    }

    const whatsapp = await Whatsapp.findAll(options);

    whatsapp.map(async c => {
      const sessionIndex = sessions.findIndex(s => s.id === c.id);
      if (sessionIndex !== -1) {
        sessions[sessionIndex].ws.close();
      }

    });

  } catch (err) {
    logger.error(err);
  }
};

export const removeWbot = async (
  whatsappId: number,
  isLogout = true
): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        sessions[sessionIndex].logout();
        sessions[sessionIndex].ws.close();
      }

      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

export var dataMessages: any = {};

export const initWASocket = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise(async (resolve, reject) => {
    try {
      (async () => {
        const io = getIO();

        const whatsappUpdate = await Whatsapp.findOne({
          where: { id: whatsapp.id }
        });

        if (!whatsappUpdate) return;

        const { id, name, provider } = whatsappUpdate;

        const { version, isLatest } = await fetchLatestBaileysVersion();

        logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
        logger.info(`Starting session ${name}`);
        let retriesQrCode = 0;

        let wsocket: Session = null;

        const { state, saveCreds } = await useMultiFileAuthState(whatsapp);

        const msgRetryCounterCache = new NodeCache();

        wsocket = makeWASocket({
          logger: loggerBaileys,
          printQRInTerminal: false,
          browser: Browsers.appropriate("Desktop"),
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
          },
          version: [2,3000,1021180439] ,
          defaultQueryTimeoutMs: 60000,
          // retryRequestDelayMs: 250,
          // keepAliveIntervalMs: 1000 * 60 * 10 * 3,
          msgRetryCounterCache,
          shouldIgnoreJid: jid => isJidBroadcast(jid),
        });



        ////////////////////////////////////////////////////////////////

        const processMessages = async (whatsapp) => {
          const wpp = await Whatsapp.findByPk(whatsapp.id);
          if (!wpp || wpp.status !== "CONNECTED" || !wpp.importOldMessages) return;

          const dateOldLimit = new Date(wpp.importOldMessages).getTime();
          const dateRecentLimit = new Date(wpp.importRecentMessages).getTime();

          // addLogs({
          //   fileName: `preparingImportMessagesWppId${whatsapp.id}.txt`,
          //   forceNewFile: true,
          //   text: `Aguardando conexão para iniciar a importação de mensagens:
          //   Whatsapp Nome: ${wpp.name}
          //   Whatsapp ID: ${wpp.id}
          //   Criação do arquivo de logs: ${moment().format("DD/MM/YYYY HH:mm:ss")}
          //   Data de Início da Importação: ${moment(dateOldLimit).format("DD/MM/YYYY HH:mm:ss")}
          //   Data Final da Importação: ${moment(dateRecentLimit).format("DD/MM/YYYY HH:mm:ss")}
          //   `
          // });

          await wpp.update({ statusImportMessages: Date.now() });

          wsocket.ev.on("messaging-history.set", async (messageSet) => {
            console.log("Evento");
            console.log(!messageSet?.messages?.length);

            if (!messageSet?.messages?.length) return;

            const whatsappId = whatsapp.id;
            const filteredDateMessages = filterMessages(messageSet.messages, wpp, dateOldLimit, dateRecentLimit);

            // if (!dataMessages[whatsappId]) {
            //   dataMessages[whatsappId] = [];
            // }
            // dataMessages[whatsappId].unshift(...filteredDateMessages);

            notifyClient(wpp);

            setTimeout(() => checkAndStartImport(wpp, filteredDateMessages), 45000);
          });
        };

        const filterMessages = (messages, wpp, dateOldLimit, dateRecentLimit) => {
          return messages.filter(msg => {
            const timestampMsg = Math.floor(msg.messageTimestamp?.low * 1000);
            if (!isValidMsg(msg) || timestampMsg < dateOldLimit || timestampMsg > dateRecentLimit) return false;

            const isGroupMessage = msg.key?.remoteJid?.endsWith("@g.us");
            if (isGroupMessage && !wpp.importOldMessagesGroups) return false;

            // addLogs({
            //   fileName: `preparingImportMessagesWppId${wpp.id}.txt`,
            //   text: `Adicionando mensagem para pós-processamento:
            //   ${isGroupMessage ? "Mensagem de GRUPO" : "Não é Mensagem de GRUPO"}
            //   Data e Hora: ${moment(timestampMsg).format("DD/MM/YYYY HH:mm:ss")}
            //   Contato: ${msg.key?.remoteJid}
            //   Tipo: ${getTypeMessage(msg)}
            //   `
            // });

            return true;
          });
        };

        const notifyClient = (wpp) => {
          io.emit(`importMessages-${wpp.companyId}`, { action: "update", status: { this: -1, all: -1 } });
          io.emit("whatsappSession", { action: "update", session: wpp });
        };

        const checkAndStartImport = async (wpp, filteredDateMessages) => {
          const updatedWpp = await Whatsapp.findByPk(wpp.id);
          if (!updatedWpp?.importOldMessages) return;

          const lastStatusTimestamp = parseInt(updatedWpp.statusImportMessages);
          if (!lastStatusTimestamp || isNaN(lastStatusTimestamp)) return;

          const dataLimite = add(lastStatusTimestamp, { seconds: 45 }).getTime();
          if (dataLimite < Date.now()) {
            ImportWhatsAppMessageService(updatedWpp.id, filteredDateMessages);
            await updatedWpp.update({ statusImportMessages: "Running" });
          }

          io.emit("whatsappSession", { action: "update", session: updatedWpp });
        };

        setTimeout(() => processMessages(whatsapp), 2500);



        ///////////////////////////////////////////////////////////////


        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            logger.info(
              `Socket  ${name} Connection Update ${connection || ""} ${lastDisconnect || ""
              }`
            );

            if (connection === "close") {
              if ((lastDisconnect?.error as Boom)?.output?.statusCode === 403) {
                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);
                await cacheLayer.delFromPattern(`sessions:${whatsapp.id}:*`);
                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
              }
              if (
                (lastDisconnect?.error as Boom)?.output?.statusCode !==
                DisconnectReason.loggedOut
              ) {
                removeWbot(id, false);
                setTimeout(
                  () => StartWhatsAppSession(whatsapp, whatsapp.companyId),
                  2000
                );
              } else {
                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);
                await cacheLayer.delFromPattern(`sessions:${whatsapp.id}:*`);
                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
                setTimeout(
                  () => StartWhatsAppSession(whatsapp, whatsapp.companyId),
                  2000
                );
              }
            }

            if (connection === "open") {
              await whatsapp.update({
                status: "CONNECTED",
                qrcode: "",
                retries: 0,
                number:
                  wsocket.type === "md"
                    ? jidNormalizedUser((wsocket as WASocket).user.id).split("@")[0]
                    : "-"
              });

              io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                action: "update",
                session: whatsapp
              });

              const sessionIndex = sessions.findIndex(
                s => s.id === whatsapp.id
              );
              if (sessionIndex === -1) {
                wsocket.id = whatsapp.id;
                sessions.push(wsocket);
              }

              resolve(wsocket);
            }

            if (qr !== undefined) {
              if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id) >= 3) {
                await whatsappUpdate.update({
                  status: "DISCONNECTED",
                  qrcode: ""
                });
                await DeleteBaileysService(whatsappUpdate.id);
                await cacheLayer.delFromPattern(`sessions:${whatsapp.id}:*`);
                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsappUpdate
                });
                wsocket.ev.removeAllListeners("connection.update");
                wsocket.ws.close();
                wsocket = null;
                retriesQrCodeMap.delete(id);
              } else {
                logger.info(`Session QRCode Generate ${name}`);
                retriesQrCodeMap.set(id, (retriesQrCode += 1));

                await whatsapp.update({
                  qrcode: qr,
                  status: "qrcode",
                  retries: 0,
                  number: ""
                });
                const sessionIndex = sessions.findIndex(
                  s => s.id === whatsapp.id
                );

                if (sessionIndex === -1) {
                  wsocket.id = whatsapp.id;
                  sessions.push(wsocket);
                }

                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
              }
            }
          }
        );
        wsocket.ev.on("creds.update", saveCreds);

        wsocket.ev.on(
          "presence.update",
          async ({ id: remoteJid, presences }) => {


            try {
              logger.debug(
                { remoteJid, presences },
                "Received contact presence"
              );
              if (!presences[remoteJid]?.lastKnownPresence) {
                console.debug("Received invalid presence");
                return;
              }
              const contact = await Contact.findOne({
                where: {
                  number: remoteJid.replace(/\D/g, ""),
                  companyId: whatsapp.companyId
                }
              });
              if (!contact) {
                return;
              }



              const ticket = await Ticket.findOne({
                where: {
                  contactId: contact.id,
                  whatsappId: whatsapp.id,
                  status: {
                    [Op.or]: ["open", "pending"]
                  }
                }
              });

              if (ticket) {

                io.to(ticket.id.toString())
                  .to(ticket.status)
                  .emit(`company-${whatsapp.companyId}-presence`, {
                    action: "update-presence",
                    ticketId: ticket.id,
                    presence: presences[remoteJid].lastKnownPresence
                  });

              }
            } catch (error) {
              logger.error(
                { remoteJid, presences },
                "presence.update: error processing"
              );
              if (error instanceof Error) {
                logger.error(`Error: ${error.name} ${error.message}`);
              } else {
                logger.error(`Error was object of type: ${typeof error}`);
              }
            }
          }
        );

      })();
    } catch (error) {
      Sentry.captureException(error);
      console.log(error);
      reject(error);
    }
  });
};
