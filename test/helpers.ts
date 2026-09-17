import { compact, type Operation, type Transport } from "../src/core.js";
import { HttpTransport } from "../src/http.js";
import { ZeroBull } from "../src/index.js";

interface MockResponse {
  status?: number;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

/** A REST client whose fetch answers from registered routes and records every request. */
export function mockApi() {
  const routes = new Map<string, MockResponse[]>();
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    const queue = routes.get(`${request.method} ${url.pathname}`);
    const mock = (queue && queue.length > 1 ? queue.shift() : queue?.[0]) ?? { status: 599 };
    const body = mock.json !== undefined ? JSON.stringify(mock.json) : mock.body;
    return new Response(body ?? null, { status: mock.status ?? 200, headers: mock.headers });
  };
  const options = { apiToken: "test", baseURL: "https://api.test", fetch };
  return {
    client: new ZeroBull(options),
    http: new HttpTransport(options),
    requests,
    fetch,
    /** Register a reply for `METHOD /path`. Several calls queue replies in order. */
    add(method: string, path: string, response: MockResponse = {}) {
      const key = `${method} ${new URL(path, options.baseURL).pathname}`;
      routes.set(key, [...(routes.get(key) ?? []), response]);
    },
    last(): Request {
      const request = requests.at(-1);
      if (!request) throw new Error("no request was sent");
      return request;
    },
  };
}

/** A socket-side transport that records compacted calls, as sent, and replies with `reply` data. */
export function fakeSocketTransport(reply: unknown = {}) {
  const calls: { fun: string; data: Record<string, unknown> }[] = [];
  const transport: Transport = {
    supportsRest: false,
    async execute<T>(operation: Operation<T>): Promise<T> {
      if (!operation.socket || !operation.parseSocket) throw new Error("not a socket operation");
      calls.push({
        fun: operation.socket.fun,
        data: compact(operation.socket.data, operation.socket.keepNulls),
      });
      return operation.parseSocket(reply);
    },
  };
  return { transport, calls };
}
