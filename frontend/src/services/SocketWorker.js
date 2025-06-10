import io from "socket.io-client";

class SocketWorker {
  constructor(companyId, userId) {
    if (!SocketWorker.instance) {
      this.companyId = companyId
      this.userId = userId
      this.socket = null;
      this.configureSocket();
      this.eventListeners = {}; // Armazena os ouvintes de eventos registrados
      SocketWorker.instance = this;

    }

    return SocketWorker.instance;
  }

  configureSocket() {
    const publicToken = localStorage.getItem("public-token")
    if (!publicToken) {
      return
    }

    this.socket = io(`${process.env.REACT_APP_BACKEND_URL}/${this?.companyId}`, {
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      query: { userId: this.userId, token: publicToken }
    });

    this.socket.on("connect", () => {
     // console.log("Conectado ao servidor Socket.IO, companyId: ", this.companyId, "userId: ", this.userId);
    });

    this.socket.on("disconnect", (reason ) => {
    //  console.log("Desconectado do servidor Socket.IO", reason);
      if (!localStorage.getItem("public-token")) {
        return;
      }
      if (this.socket?.connected === false) {
        this.reconnectAfterDelay();
      }
    });
  }

  // Adiciona um ouvinte de eventos
  on(event, callback) {
    if (!localStorage.getItem("public-token")) {
      return;
    }
    this.connect();
    this.socket.on(event, callback);

    // Armazena o ouvinte no objeto de ouvintes
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  // Emite um evento
  emit(event, data) {
    if (!localStorage.getItem("public-token")) {
      return;
    }
    this.connect();
    this.socket.emit(event, data);
  }

  // Desconecta um ou mais ouvintes de eventos
  off(event, callback) {
    if (!localStorage.getItem("public-token")) {
      return;
    }
    this.connect();
    if (this.eventListeners[event]) {
      // console.log("Desconectando do servidor Socket.IO:", event, callback);
      if (callback) {
        // Desconecta um ouvinte específico
        this.socket.off(event, callback);
        this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
      } else {
        // console.log("DELETOU EVENTOS DO SOCKET:", this.eventListeners[event]);

        // Desconecta todos os ouvintes do evento
        this.eventListeners[event].forEach(cb => this.socket.off(event, cb));
        delete this.eventListeners[event];
      }
      // console.log("EVENTOS DO SOCKET:", this.eventListeners);
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null
      this.instance = null
      console.log("Socket desconectado manualmente");
    }
  }

  reconnectAfterDelay() {
    setTimeout(() => {
      if (!this.socket || !this.socket.connected) {
        const sessionToken = localStorage.getItem("public-token");
        if (!sessionToken) {
          return;
        } 
        this.socket.io.opts.query = { token: sessionToken, userId: this.userId, companyId: this.companyId };
        console.log("Tentando reconectar após desconexão");
        this.connect();
      }
    }, 1000);
  }

  // Garante que o socket esteja conectado
  connect() {
    if (!this.socket) {
      this.configureSocket();
    }
  }

  forceReconnect() {

  }
}

// const instance = (companyId, userId) => new SocketWorker(companyId,userId);
const instance = (companyId, userId) => new SocketWorker(companyId, userId);

export default instance;