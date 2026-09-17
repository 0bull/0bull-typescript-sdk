import type { HttpTransport } from "./http.js";

export interface SocketOptions {
  /** Milliseconds to wait for a call's reply, including any reconnect wait. Default 60000. */
  callTimeout?: number;
  /** Reconnect with a fresh session URL after an unexpected close. Default true. */
  autoReconnect?: boolean;
  /** Default 5. */
  maxReconnectAttempts?: number;
}

export class Socket {
  constructor(
    readonly http: HttpTransport,
    readonly options: SocketOptions = {},
  ) {}
}
