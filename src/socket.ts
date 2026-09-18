import { compact, type Data, noContent, type Operation, type Transport } from "./core.js";
import {
  APIConnectionError,
  APITimeoutError,
  errorFromStatus,
  SocketClosedError,
  ZeroBullError,
} from "./errors.js";
import type { HttpTransport } from "./http.js";
import { Accounts } from "./resources/accounts.js";
import { Billing } from "./resources/billing.js";
import { Phones } from "./resources/phones.js";
import { Runs } from "./resources/runs.js";
import { SessionResource } from "./resources/session.js";
import { Submissions } from "./resources/submissions.js";
import { Uploads } from "./resources/uploads.js";
import type { BillingRequest, Event, Run, Submission } from "./types.js";

// Declared so the published types compile without `lib: "esnext"`; a consumer only needs that
// lib to use `await using` itself.
declare global {
  interface SymbolConstructor {
    readonly asyncDispose: unique symbol;
  }
}

export interface SocketOptions {
  /** Milliseconds to wait for a call's reply, including any reconnect wait. Default 60000. */
  callTimeout?: number;
  /** Reconnect with a fresh session URL after an unexpected close. Default true. */
  autoReconnect?: boolean;
  /** Default 5. */
  maxReconnectAttempts?: number;
}

type Frame = Record<string, unknown>;
type EventItem = Event | SocketClosedError | typeof END;
type SocketWaiter = { resolve: () => void; reject: (error: SocketClosedError) => void };
type Pending = { resolve: (frame: Frame) => void; reject: (error: SocketClosedError) => void };

const END = Symbol("socket events ended");

function isObject(value: unknown): value is Frame {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasFields(value: Frame, fields: readonly string[]): boolean {
  return fields.every((field) => field in value);
}

function parseFrame(data: unknown): Frame | undefined {
  if (typeof data !== "string") return;
  try {
    const value: unknown = JSON.parse(data);
    return isObject(value) ? value : undefined;
  } catch {
    return;
  }
}

function parseEvent(frame: Frame): Event | undefined {
  const data = frame.data;
  if (!isObject(data)) return;
  switch (frame.event) {
    case "run":
      if (hasFields(data, ["id", "slot", "kind", "status"])) {
        return { type: "run", run: data as unknown as Run };
      }
      return;
    case "submission":
      if (hasFields(data, ["id", "platform", "status", "attempts"])) {
        return { type: "submission", submission: data as unknown as Submission };
      }
      return;
    case "billing_request":
      if (hasFields(data, ["request_id", "status", "to_phones"])) {
        return { type: "billing_request", request: data as unknown as BillingRequest };
      }
      return;
    default:
      return;
  }
}

/** Executes operations over one multiplexed WebSocket connection. */
export class SocketTransport implements Transport {
  readonly supportsRest = false;
  readonly #http: HttpTransport;
  readonly #callTimeout: number;
  readonly #autoReconnect: boolean;
  readonly #maxReconnectAttempts: number;
  readonly #pending = new Map<string, Pending>();
  readonly #waiters = new Set<SocketWaiter>();
  readonly #events: EventItem[] = [];
  readonly #eventWaiters = new Set<(item: EventItem) => void>();
  #socket: WebSocket | undefined;
  #session: Awaited<ReturnType<SessionResource["create"]>> | undefined;
  #connectPromise: Promise<void> | undefined;
  /** Cancels an in-progress connection attempt or reconnect backoff, so close() is immediate. */
  #abort: (() => void) | undefined;
  #counter = 0;
  #everConnected = false;
  #reconnecting = false;
  #closed = false;
  #ended = false;

  constructor(http: HttpTransport, options: SocketOptions = {}) {
    this.#http = http;
    this.#callTimeout = options.callTimeout ?? 60_000;
    this.#autoReconnect = options.autoReconnect ?? true;
    this.#maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  }

  get session() {
    if (!this.#session) throw new SocketClosedError("Socket has not connected");
    return this.#session;
  }

  async connect(): Promise<void> {
    if (this.#closed || this.#ended) throw new SocketClosedError("Socket is closed");
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connectPromise) return this.#connectPromise;
    const promise = this.#openConnection();
    const tracked = promise.finally(() => {
      if (this.#connectPromise === tracked) this.#connectPromise = undefined;
    });
    this.#connectPromise = tracked;
    return tracked;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ended = true;
    this.#reconnecting = false;
    const socket = this.#socket;
    this.#disconnect();
    this.#rejectWaiters(new SocketClosedError("Socket is closed"));
    this.#enqueue(END);
    this.#abort?.();
    try {
      socket?.close();
    } catch {
      // The socket may already be closed by the peer.
    }
  }

  async execute<T>(operation: Operation<T>): Promise<T> {
    if (!operation.socket || !operation.parseSocket) {
      const name = operation.rest?.path ?? operation.socket?.fun ?? "Operation";
      throw new ZeroBullError(`${name} is not available over WebSocket`);
    }
    const deadline = performance.now() + this.#callTimeout;
    const socket = await this.#waitForSocket(deadline);
    const msgid = String(++this.#counter);
    const reply = new Promise<Frame>((resolve, reject) => {
      this.#pending.set(msgid, { resolve, reject });
    });
    try {
      socket.send(
        JSON.stringify({
          fun: operation.socket.fun,
          msgid,
          data: compact(operation.socket.data, operation.socket.keepNulls),
        }),
      );
      const frame = await this.#withDeadline(reply, deadline);
      const status = frame.status;
      if (typeof status !== "number" || !Number.isInteger(status)) {
        throw new APIConnectionError("Invalid socket reply status");
      }
      if (status < 200 || status >= 300) {
        throw errorFromStatus(status, { message: frame.message, errors: frame.errors });
      }
      return operation.parseSocket(frame.data);
    } finally {
      this.#pending.delete(msgid);
    }
  }

  events(options: { timeout?: number } = {}): AsyncIterable<Event> {
    return this.#iterateEvents(options.timeout);
  }

  async *#iterateEvents(timeout: number | undefined): AsyncIterableIterator<Event> {
    while (true) {
      let item: EventItem;
      try {
        item = await this.#nextEvent(timeout);
      } catch (error) {
        if (error instanceof APITimeoutError) return;
        throw error;
      }
      if (item === END) {
        this.#enqueue(END);
        return;
      }
      if (item instanceof SocketClosedError) {
        this.#enqueue(item);
        if (!this.#closed) throw item;
        return;
      }
      yield item;
    }
  }

  async #openConnection(): Promise<void> {
    const session = await new SessionResource(this.#http, this.#http).create();
    if (this.#closed) throw new SocketClosedError("Socket is closed");
    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      let opened = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.#abort = undefined;
        if (timer) clearTimeout(timer);
        reject(error);
      };
      try {
        socket = new WebSocket(session.socket_url);
      } catch (error) {
        fail(new APIConnectionError("Socket connection failed", { cause: error }));
        return;
      }
      const onClose = () => {
        if (!opened) {
          fail(new APIConnectionError("Socket connection failed"));
        } else {
          this.#handleClose(socket);
        }
      };
      socket.addEventListener("message", (event) => this.#handleMessage(socket, event.data));
      socket.addEventListener("error", () => {
        if (!opened) fail(new APIConnectionError("Socket connection failed"));
      });
      socket.addEventListener("close", onClose);
      this.#abort = () => {
        // Reject first: closing a connecting socket fires its error listener synchronously.
        fail(new SocketClosedError("Socket is closed"));
        try {
          socket.close();
        } catch {
          // A socket still connecting may refuse close; the caller already has its rejection.
        }
      };
      socket.addEventListener("open", () => {
        if (this.#closed) {
          try {
            socket.close();
          } catch {
            // The close race is already represented by SocketClosedError.
          }
          fail(new SocketClosedError("Socket is closed"));
          return;
        }
        opened = true;
        settled = true;
        this.#abort = undefined;
        if (timer) clearTimeout(timer);
        this.#socket = socket;
        this.#session = session;
        this.#everConnected = true;
        this.#reconnecting = false;
        this.#resolveWaiters();
        resolve();
      });
      timer = setTimeout(
        () => {
          try {
            socket.close();
          } catch {
            // The timeout is the useful error for the caller.
          }
          fail(new APITimeoutError("Socket connection timed out"));
        },
        Math.max(0, this.#callTimeout),
      );
    });
  }

  #handleMessage(socket: WebSocket, data: unknown): void {
    if (this.#socket !== socket) return;
    const frame = parseFrame(data);
    if (!frame) return;
    const msgid = frame.msgid;
    if (typeof msgid === "string") {
      const pending = this.#pending.get(msgid);
      if (pending) {
        this.#pending.delete(msgid);
        pending.resolve(frame);
        return;
      }
    }
    const event = parseEvent(frame);
    if (event) this.#enqueue(event);
  }

  #handleClose(socket: WebSocket): void {
    if (this.#socket !== socket || this.#closed) return;
    this.#disconnect();
    if (!this.#autoReconnect) {
      this.#finish(new SocketClosedError("Socket connection closed"));
      return;
    }
    this.#reconnecting = true;
    void this.#reconnect();
  }

  #disconnect(): void {
    this.#socket = undefined;
    const error = new SocketClosedError("Socket connection closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #reconnect(): Promise<void> {
    for (let attempt = 0; attempt < this.#maxReconnectAttempts; attempt++) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(500 * 2 ** attempt, 10_000));
        this.#abort = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#abort = undefined;
      if (this.#closed) return;
      try {
        await this.#openConnection();
        return;
      } catch {
        if (this.#closed) return;
      }
    }
    if (!this.#closed) {
      this.#reconnecting = false;
      this.#finish(new SocketClosedError("Socket connection closed"));
    }
  }

  #finish(error: SocketClosedError): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#rejectWaiters(error);
    this.#enqueue(error);
  }

  #resolveWaiters(): void {
    for (const waiter of this.#waiters) waiter.resolve();
    this.#waiters.clear();
  }

  #rejectWaiters(error: SocketClosedError): void {
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  async #waitForSocket(deadline: number): Promise<WebSocket> {
    if (this.#closed || this.#ended || !this.#everConnected) {
      throw new SocketClosedError("Socket is not connected");
    }
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    if (!this.#reconnecting) throw new SocketClosedError("Socket is not connected");
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: SocketWaiter = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          this.#waiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          this.#waiters.delete(waiter);
          reject(error);
        },
      };
      this.#waiters.add(waiter);
      timer = setTimeout(
        () => {
          this.#waiters.delete(waiter);
          reject(new APITimeoutError("Socket call timed out"));
        },
        Math.max(0, deadline - performance.now()),
      );
    });
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new SocketClosedError("Socket is not connected");
    }
    return socket;
  }

  async #withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remaining = Math.max(0, deadline - performance.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new APITimeoutError("Socket call timed out")), remaining);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #enqueue(item: EventItem): void {
    const waiter = this.#eventWaiters.values().next().value;
    if (waiter) {
      this.#eventWaiters.delete(waiter);
      waiter(item);
    } else {
      this.#events.push(item);
    }
  }

  async #nextEvent(timeout: number | undefined): Promise<EventItem> {
    const item = this.#events.shift();
    if (item) return item;
    return new Promise<EventItem>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (value: EventItem) => {
        if (timer) clearTimeout(timer);
        this.#eventWaiters.delete(waiter);
        resolve(value);
      };
      this.#eventWaiters.add(waiter);
      if (timeout !== undefined) {
        timer = setTimeout(
          () => {
            this.#eventWaiters.delete(waiter);
            reject(new APITimeoutError("Socket events timed out"));
          },
          Math.max(0, timeout),
        );
      }
    });
  }
}

/** WebSocket resources and typed push events. */
export class Socket {
  readonly accounts: Accounts;
  readonly uploads: Uploads;
  readonly submissions: Submissions;
  readonly phones: Phones;
  readonly runs: Runs;
  readonly billing: Billing;
  readonly #transport: SocketTransport;

  constructor(
    readonly http: HttpTransport,
    readonly options: SocketOptions = {},
  ) {
    this.#transport = new SocketTransport(http, options);
    this.accounts = new Accounts(this.#transport, http);
    this.uploads = new Uploads(this.#transport, http);
    this.submissions = new Submissions(this.#transport, http);
    this.phones = new Phones(this.#transport, http);
    this.runs = new Runs(this.#transport, http);
    this.billing = new Billing(this.#transport, http);
  }

  get session() {
    return this.#transport.session;
  }

  connect(): Promise<void> {
    return this.#transport.connect();
  }

  close(): void {
    this.#transport.close();
  }

  events(options: { timeout?: number } = {}): AsyncIterable<Event> {
    return this.#transport.events(options);
  }

  call(fun: string, data?: Data): Promise<unknown> {
    return this.#transport.execute({
      socket: { fun, data },
      parseRest: noContent,
      parseSocket: (value) => value,
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}
