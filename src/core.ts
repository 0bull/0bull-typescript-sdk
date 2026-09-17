import { WaitTimeoutError } from "./errors.js";

export type Data = Record<string, unknown>;

/** A REST request. `undefined` values are always dropped; `null` too unless `keepNulls`. */
export interface RestRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Data;
  json?: Data;
  /** Multipart form fields. Setting this (even to `{}`) sends multipart. */
  form?: Data;
  file?: { field: string; source: FileSource };
  keepNulls?: boolean;
}

export interface SocketFun {
  fun: string;
  data?: Data;
  keepNulls?: boolean;
}

export interface RestResponse {
  status: number;
  bytes: Uint8Array;
  json(): unknown;
}

/** One API call, described for both transports. Either side may be absent. */
export interface Operation<T> {
  rest?: RestRequest;
  socket?: SocketFun;
  parseRest: (response: RestResponse) => T;
  parseSocket?: (data: unknown) => T;
}

export interface Transport {
  readonly supportsRest: boolean;
  execute<T>(operation: Operation<T>): Promise<T>;
}

/** A local file path (Node), or in-memory bytes. */
export type FileSource = string | Blob | Uint8Array;

export function compact(data: Data | undefined, keepNulls = false): Data {
  return Object.fromEntries(
    Object.entries(data ?? {}).filter(
      ([, value]) => value !== undefined && (keepNulls || value !== null),
    ),
  );
}

export function pathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Throw for a client-side argument error. */
export function invalid(message: string): never {
  throw new TypeError(message);
}

export function requireRange(name: string, value: number | undefined, low: number, high: number) {
  if (value !== undefined && !(value >= low && value <= high)) {
    invalid(`${name} must be between ${low} and ${high}`);
  }
}

function isObject(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove the REST `{ data: ... }` envelope. */
export function unwrap(response: RestResponse): unknown {
  const body = response.json();
  if (!isObject(body) || !("data" in body)) {
    throw new TypeError("Expected a response with a data field");
  }
  return body.data;
}

export const noContent = (): void => undefined;

export function asObject<T>(data: unknown): T {
  if (!isObject(data)) throw new TypeError("Expected an object in the API response");
  return data as T;
}

export interface PageData<T> {
  items: T[];
  current_page: number;
  last_page: number;
  per_page: number;
  total: number;
}

/** Parse `{ data: [...], meta: {...} }`, the page shape on both transports. */
export function parsePage<T>(body: unknown): PageData<T> {
  if (!isObject(body) || !Array.isArray(body.data) || !isObject(body.meta)) {
    throw new TypeError("Expected page data and meta");
  }
  const { current_page, last_page, per_page, total } = body.meta;
  for (const value of [current_page, last_page, per_page, total]) {
    if (typeof value !== "number") throw new TypeError("Expected numeric page meta");
  }
  return { items: body.data as T[], current_page, last_page, per_page, total } as PageData<T>;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll `fetch` until `done`, throwing WaitTimeoutError once `timeout` ms have passed. */
export async function waitUntil<T>(
  fetch: () => Promise<T>,
  done: (value: T) => boolean,
  { interval, timeout, what }: { interval: number; timeout: number; what: string },
): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await fetch();
    if (done(value)) return value;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new WaitTimeoutError(`Timed out waiting for ${what}`);
    await sleep(Math.min(interval, remaining));
  }
}

const CONTENT_TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime" };

/** Resolve a file source to a Blob and filename, reading paths lazily from disk. */
export async function toBlob(source: FileSource): Promise<{ blob: Blob; name: string }> {
  if (source instanceof Blob) {
    return { blob: source, name: (source as File).name || "video" };
  }
  if (typeof source !== "string") {
    return {
      blob: new Blob([source as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }),
      name: "video",
    };
  }
  const [{ openAsBlob }, { basename, extname }] = await Promise.all([
    import("node:fs"),
    import("node:path"),
  ]);
  const type = CONTENT_TYPES[extname(source).slice(1).toLowerCase()] ?? "application/octet-stream";
  return { blob: await openAsBlob(source, { type }), name: basename(source) };
}
