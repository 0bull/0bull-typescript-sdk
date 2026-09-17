import {
  compact,
  type Operation,
  type RestRequest,
  sleep,
  type Transport,
  toBlob,
} from "./core.js";
import { APIConnectionError, APITimeoutError, errorFromStatus, ZeroBullError } from "./errors.js";
import { VERSION } from "./version.js";

export interface ClientOptions {
  /** Defaults to the `ZEROBULL_API_TOKEN` environment variable. */
  apiToken?: string;
  /** Defaults to `ZEROBULL_BASE_URL`, then `https://0bull.net/api`. */
  baseURL?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeout?: number;
  /** Retries for REST `429` responses, honoring `Retry-After`. Default 2. */
  maxRetries?: number;
  /** Custom fetch implementation, e.g. for proxies or tests. */
  fetch?: typeof fetch;
}

const env = (name: string): string | undefined => globalThis.process?.env?.[name];

function retryAfterSeconds(response: Response): number {
  const delay = Number(response.headers.get("retry-after") ?? "1");
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 60) : 1;
}

function readBody(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return undefined;
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toQuery(query: RestRequest["query"]): string {
  const entries = Object.entries(compact(query)).map(([key, value]) => [key, String(value)]);
  return entries.length ? `?${new URLSearchParams(entries)}` : "";
}

/** Executes operations over REST with bearer auth and bounded 429 retries. */
export class HttpTransport implements Transport {
  readonly supportsRest = true;
  readonly baseURL: string;
  readonly #token: string;
  readonly #timeout: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const token = options.apiToken ?? env("ZEROBULL_API_TOKEN");
    if (!token) {
      throw new ZeroBullError("An API token is required: pass apiToken or set ZEROBULL_API_TOKEN");
    }
    this.#token = token;
    this.baseURL = (options.baseURL ?? env("ZEROBULL_BASE_URL") ?? "https://0bull.net/api").replace(
      /\/+$/,
      "",
    );
    this.#timeout = options.timeout ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async execute<T>(operation: Operation<T>): Promise<T> {
    const rest = operation.rest;
    if (!rest) throw new ZeroBullError(`${operation.socket?.fun} is not available over HTTP`);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}` };
    let body: BodyInit | undefined;
    if (rest.form || rest.file) {
      const form = new FormData();
      for (const [key, value] of Object.entries(compact(rest.form))) {
        form.append(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
      }
      if (rest.file) {
        const { blob, name } = await toBlob(rest.file.source);
        form.append(rest.file.field, blob, name);
      }
      body = form;
    } else if (rest.json) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(compact(rest.json, rest.keepNulls));
    }
    const url = `${this.baseURL}${rest.path}${toQuery(rest.query)}`;
    const response = await this.send(url, { method: rest.method, headers, body });
    return operation.parseRest({
      status: response.status,
      bytes: response.bytes,
      json: () =>
        response.bytes.length ? JSON.parse(new TextDecoder().decode(response.bytes)) : undefined,
    });
  }

  /** POST a file to a signed upload URL, without the API token. */
  async upload(url: string, source: Parameters<typeof toBlob>[0]): Promise<unknown> {
    const { blob, name } = await toBlob(source);
    const form = new FormData();
    form.append("video", blob, name);
    const response = await this.send(url, { method: "POST", body: form });
    return readBody(response.bytes);
  }

  private async send(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: BodyInit | undefined },
  ): Promise<{ status: number; bytes: Uint8Array }> {
    const headers = {
      Accept: "application/json",
      "User-Agent": `0bull-typescript/${VERSION}`,
      ...init.headers,
    };
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let bytes: Uint8Array;
      try {
        response = await this.#fetch(url, {
          ...init,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(this.#timeout),
        });
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new APITimeoutError("API request timed out", { cause: error });
        }
        throw new APIConnectionError("API connection failed", { cause: error });
      }
      if (response.status === 429 && attempt < this.#maxRetries) {
        await sleep(retryAfterSeconds(response) * 1000);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw errorFromStatus(
          response.status,
          readBody(bytes),
          response.status === 429 ? retryAfterSeconds(response) : undefined,
        );
      }
      return { status: response.status, bytes };
    }
  }
}
