import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { Data, Operation } from "../src/core.js";
import {
  APIConnectionError,
  APITimeoutError,
  SocketClosedError,
  ZeroBullError,
} from "../src/index.js";
import { SocketTransport } from "../src/socket.js";
import type { Event } from "../src/types.js";
import { mockApi } from "./helpers.js";

type Frame = { fun?: string; msgid?: string; data?: Data };
type Handler = (socket: WebSocket, frame: Frame) => void | Promise<void>;

class SocketServer {
  readonly server = new WebSocketServer({ port: 0 });
  readonly frames: Frame[] = [];
  readonly #handler: Handler;

  constructor(
    handler: Handler = (socket, frame) => {
      socket.send(JSON.stringify({ msgid: frame.msgid, status: 200, data: frame.data ?? null }));
    },
  ) {
    this.#handler = handler;
    this.server.on("connection", (socket) => {
      socket.on("message", (message) => {
        let frame: Frame;
        try {
          frame = JSON.parse(message.toString()) as Frame;
        } catch {
          return;
        }
        this.frames.push(frame);
        void this.#handler(socket, frame);
      });
    });
  }

  async start(): Promise<string> {
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    return `ws://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    if (this.server.address()) {
      this.server.close();
      await once(this.server, "close");
    }
  }
}

const session = (socket_url: string) => ({
  phones: [],
  socket_url,
  farm_online: true,
});

const run = {
  id: "run-1",
  slot: "phone-1",
  kind: "macro",
  status: "succeeded",
  label: null,
  result: null,
  error: null,
  started_at: null,
  finished_at: null,
  created_at: null,
};

const submission = {
  id: 1,
  platform: "tiktok",
  account_id: "account-1",
  caption: null,
  draft: false,
  status: "published",
  attempts: 1,
  failure: null,
  started_at: null,
  finished_at: null,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

const billingRequest = {
  request_id: "request-1",
  status: "approved",
  to_phones: 1,
  approval_url: "https://example.test/approve",
  expires_at: "2025-01-01T00:00:00Z",
  resolved_at: null,
};

const clients: SocketServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((server) => server.close()));
});

async function makeSocket(
  serverURL: string,
  options: ConstructorParameters<typeof SocketTransport>[1] = {},
) {
  const api = mockApi();
  api.add("GET", "/v1/phone-controller", { json: session(serverURL) });
  return { api, socket: api.client.socket({ callTimeout: 100, ...options }) };
}

describe("Socket", () => {
  it("matches concurrent replies by string msgid", async () => {
    const server = new SocketServer(async (socket, frame) => {
      await new Promise((resolve) => setTimeout(resolve, frame.data?.index === 0 ? 10 : 0));
      socket.send(JSON.stringify({ msgid: frame.msgid, status: 200, data: frame.data?.index }));
    });
    clients.push(server);
    const url = await server.start();
    const { socket } = await makeSocket(url);
    await socket.connect();

    await expect(
      Promise.all([socket.call("/echo", { index: 0 }), socket.call("/echo", { index: 1 })]),
    ).resolves.toEqual([0, 1]);
    expect(server.frames.map((frame) => frame.msgid)).toEqual(["1", "2"]);
    socket.close();
  });

  it("maps error replies and rejects REST-only operations", async () => {
    const server = new SocketServer((socket, frame) => {
      socket.send(
        JSON.stringify({
          msgid: frame.msgid,
          status: 422,
          message: "rejected",
          errors: { slot: ["bad"] },
        }),
      );
    });
    clients.push(server);
    const url = await server.start();
    const { api, socket } = await makeSocket(url);
    await socket.connect();
    await expect(socket.call("/error")).rejects.toMatchObject({
      message: "rejected",
      status: 422,
      errors: { slot: ["bad"] },
    });

    const operation: Operation<unknown> = {
      rest: { method: "GET", path: "/v1/session" },
      parseRest: (response) => response.json(),
    };
    const transport = new SocketTransport(api.http);
    await expect(transport.execute(operation)).rejects.toBeInstanceOf(ZeroBullError);
    await expect(transport.execute(operation)).rejects.toThrow("not available over WebSocket");
    await expect(
      transport.execute({ socket: { fun: "/missing-parser" }, parseRest: operation.parseRest }),
    ).rejects.toThrow("not available over WebSocket");
    socket.close();
  });

  it("times out a call", async () => {
    const server = new SocketServer();
    server.server.removeAllListeners("connection");
    server.server.on("connection", (socket) => socket.on("message", () => undefined));
    clients.push(server);
    const url = await server.start();
    const { socket } = await makeSocket(url, { callTimeout: 20 });
    await socket.connect();
    await expect(socket.call("/slow")).rejects.toBeInstanceOf(APITimeoutError);
    socket.close();
  });

  it("queues typed events and ignores non-application frames", async () => {
    const server = new SocketServer((socket, frame) => {
      socket.send(Buffer.from("binary"));
      socket.send("invalid json");
      socket.send("[]");
      socket.send(JSON.stringify({ event: "unknown", data: run }));
      socket.send(JSON.stringify({ event: "run", data: {} }));
      socket.send(JSON.stringify({ event: "submission", data: {} }));
      socket.send(JSON.stringify({ event: "billing_request", data: {} }));
      socket.send(JSON.stringify({ msgid: "unmatched", status: 200 }));
      for (const [event, data] of [
        ["run", run],
        ["submission", submission],
        ["billing_request", billingRequest],
      ] as const) {
        socket.send(JSON.stringify({ event, data }));
      }
      socket.send(JSON.stringify({ msgid: frame.msgid, status: 204, data: null }));
    });
    clients.push(server);
    const url = await server.start();
    const { socket } = await makeSocket(url);
    await socket.connect();
    await socket.call("/events");

    const events: Event[] = [];
    for await (const event of socket.events({ timeout: 20 })) events.push(event);
    expect(events).toEqual([
      { type: "run", run },
      { type: "submission", submission },
      { type: "billing_request", request: billingRequest },
    ]);
    socket.close();
  });

  it("reconnects with a fresh session URL and does not resend calls", async () => {
    const replacement = new SocketServer();
    clients.push(replacement);
    const replacementURL = await replacement.start();
    const original = new SocketServer((socket, frame) => {
      if (frame.fun === "/drop") void socket.close();
    });
    clients.push(original);
    const originalURL = await original.start();
    const { api, socket } = await makeSocket(originalURL, { callTimeout: 1_500 });
    api.add("GET", "/v1/phone-controller", { json: session(replacementURL) });
    await socket.connect();

    await expect(socket.call("/drop")).rejects.toBeInstanceOf(SocketClosedError);
    await expect(socket.call("/echo", { ok: true })).resolves.toEqual({ ok: true });
    expect(api.requests).toHaveLength(2);
    expect(original.frames).toHaveLength(1);
    expect(replacement.frames).toHaveLength(1);
    socket.close();
  });

  it("fails in-flight calls and ends event iteration on close", async () => {
    const received = new Promise<void>((resolve) => {
      const server = new SocketServer((_, frame) => {
        if (frame.fun === "/pending") resolve();
      });
      clients.push(server);
    });
    const server = clients.at(-1);
    if (!server) throw new Error("server missing");
    const url = await server.start();
    const { socket } = await makeSocket(url);
    await socket.connect();
    const call = socket.call("/pending");
    const nextEvent = socket.events()[Symbol.asyncIterator]().next();
    await received;
    socket.close();
    await expect(call).rejects.toBeInstanceOf(SocketClosedError);
    await expect(nextEvent).resolves.toEqual({ done: true, value: undefined });
  });

  it("reports exhausted reconnects to calls and events", async () => {
    const server = new SocketServer((socket) => void socket.close());
    clients.push(server);
    const url = await server.start();
    const { api, socket } = await makeSocket(url, { maxReconnectAttempts: 1, callTimeout: 1_500 });
    api.add("GET", "/v1/phone-controller", { status: 503 });
    await socket.connect();
    await expect(socket.call("/drop")).rejects.toBeInstanceOf(SocketClosedError);
    const readEvents = (async () => {
      for await (const _event of socket.events({ timeout: 1_500 })) {
        // The exhausted connection should produce no events.
      }
    })();
    await expect(readEvents).rejects.toBeInstanceOf(SocketClosedError);
    await expect(socket.call("/future")).rejects.toBeInstanceOf(SocketClosedError);
    await expect(socket.connect()).rejects.toBeInstanceOf(SocketClosedError);
    expect(api.requests).toHaveLength(2);
  });

  it("reports an unexpected close without reconnecting when disabled", async () => {
    const server = new SocketServer((socket) => void socket.close());
    clients.push(server);
    const url = await server.start();
    const { socket } = await makeSocket(url, { autoReconnect: false });
    await socket.connect();
    await expect(socket.call("/drop")).rejects.toBeInstanceOf(SocketClosedError);
    const events = (async () => {
      for await (const _event of socket.events()) {
        // The close marker is not an event.
      }
    })();
    await expect(events).rejects.toBeInstanceOf(SocketClosedError);
    socket.close();
  });

  it("bounds calls waiting for reconnect", async () => {
    const server = new SocketServer((socket) => void socket.close());
    clients.push(server);
    const url = await server.start();
    const { socket } = await makeSocket(url, { callTimeout: 20 });
    await socket.connect();
    await expect(socket.call("/drop")).rejects.toBeInstanceOf(SocketClosedError);
    await expect(socket.call("/during-reconnect")).rejects.toBeInstanceOf(APITimeoutError);
    const waiting = socket.call("/close-during-reconnect");
    socket.close();
    await expect(waiting).rejects.toBeInstanceOf(SocketClosedError);
  });

  it("allows a failed initial connection to be retried", async () => {
    const server = new SocketServer();
    clients.push(server);
    const url = await server.start();
    const api = mockApi();
    api.add("GET", "/v1/phone-controller", { json: session("ws://127.0.0.1:1") });
    api.add("GET", "/v1/phone-controller", { json: session(url) });
    const socket = api.client.socket({ callTimeout: 20, autoReconnect: false });
    await expect(socket.connect()).rejects.toBeInstanceOf(APIConnectionError);
    await socket.connect();
    await expect(socket.connect()).resolves.toBeUndefined();
    socket.close();
  });

  it("exposes the last session and throws before connecting", async () => {
    const server = new SocketServer();
    clients.push(server);
    const url = await server.start();
    const { socket } = await makeSocket(url, { autoReconnect: false });
    expect(() => socket.session).toThrow(SocketClosedError);
    await socket.connect();
    expect(socket.session.socket_url).toBe(url);
    socket.close();
    expect(socket.session.socket_url).toBe(url);
  });

  it("supports async disposal", async () => {
    const server = new SocketServer();
    clients.push(server);
    const url = await server.start();
    const { socket } = await makeSocket(url);
    await socket.connect();
    await socket[Symbol.asyncDispose]();
    await expect(socket.call("/closed")).rejects.toBeInstanceOf(SocketClosedError);
  });

  it("rejects non-integer reply statuses as connection errors", async () => {
    const server = new SocketServer((socket, frame) => {
      socket.send(JSON.stringify({ msgid: frame.msgid, status: 200.5, data: null }));
    });
    clients.push(server);
    const url = await server.start();
    const { socket } = await makeSocket(url, { autoReconnect: false });
    await socket.connect();
    await expect(socket.call("/bad-status")).rejects.toBeInstanceOf(APIConnectionError);
    socket.close();
  });
});
