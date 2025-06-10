import { Server as SocketIO } from "socket.io";
import { Server } from "http";
import AppError from "../errors/AppError";
import { logger } from "../utils/logger";
import { userMonitor } from "../queues/userMonitor";
import User from '../models/User';

let io: SocketIO;

export const initIO = (httpServer: Server): SocketIO => {
  io = new SocketIO(httpServer, {
    allowRequest: (req, callback) => {
      const isOriginValid = req.headers.origin;
      callback(null, isOriginValid === process.env.FRONTEND_URL);
    },
    cors: {
      origin: [process.env.FRONTEND_URL]
    }
  });

 // const workspaces = io.of(/^\/\w+$/);

  io.on("connection", async socket => {


    const { token, userId } = socket.handshake.query;
    const ipAddress = socket.handshake.address;
    const realIpAddress = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    let decoded;

    if (!token || !userId || token === 'null' || userId === 'undefined') {
      // Log the IP address
      logger.info(`Connection from IP: ${ipAddress} - Real IP: ${realIpAddress} - Token: ${token} - UserId: ${userId} Disconnected`);

      socket.disconnect();
      return io;
    }

    User.findOne({ where: { publicToken: token.replace(/['"]/g, ''), id: userId } })
      .then(user => {
        decoded = user;

        if (!decoded) {
          logger.error(`Token or user ID not found: ${token} - ${userId}`);

          socket.disconnect();
          return io;
        }

        const companyId = decoded.companyId;

        //socket.join(`company-${companyId}-mainchannel`)
        socket.companyId = companyId;
        socket.userId = userId;
        return io;

      })

    socket.on("joinChatBox", (ticketId: string) => {
      logger.info("A client joined a ticket channel");
      socket.join(ticketId);
    });

    socket.on("joinNotification", () => {
      logger.info("A client joined notification channel");
      socket.join("notification");
    });

    socket.on("joinTickets", (status: string) => {
      logger.info(`A client joined to ${status} tickets channel.`);
      socket.join(status);
    });

    userMonitor.add(
      "UserConnection",
      {
        id: userId
      },
      {
        removeOnComplete: { age: 60 * 60, count: 10 },
        removeOnFail: { age: 60 * 60, count: 10 }
      }
    );

  });
  return io;
};

export const getIO = (): SocketIO => {
  if (!io) {
    throw new AppError("Socket IO not initialized");
  }
  return io;
};
