import openSocket from "socket.io-client";
import { isObject } from "lodash";
import SocketWorker from "./SocketWorker"

export function socketConnection(params) {
  const publicToken = localStorage.getItem("public-token")
  if (!publicToken || !isObject(params)) {
    return
  }
  return openSocket(process.env.REACT_APP_BACKEND_URL, {
    transports: ["websocket", "polling", "flashsocket"],
    pingTimeout: 18000,
    pingInterval: 18000,
    query: { ...params,token: publicToken },
  });
}
