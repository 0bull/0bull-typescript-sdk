import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APITimeoutError,
  RateLimitError,
  ValidationError,
  VERSION,
  ZeroBull,
  ZeroBullError,
} from "../src/index.js";
import { mockApi } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("HttpTransport", () => {
  it("sends auth, accept, and user-agent headers", async () => {
    const api = mockApi();
    api.add("GET", "/user", { json: { data: { id: 1 } } });
    await api.client.user.get();
    const request = api.last();
    expect(request.url).toBe("https://api.test/user");
    expect(request.headers.get("authorization")).toBe("Bearer test");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.get("user-agent")).toBe(`0bull-typescript/${VERSION}`);
  });

  it("requires a token and reads config from the environment", () => {
    vi.stubEnv("ZEROBULL_API_TOKEN", "");
    expect(() => new ZeroBull()).toThrow(ZeroBullError);
    vi.stubEnv("ZEROBULL_API_TOKEN", "env-token");
    vi.stubEnv("ZEROBULL_BASE_URL", "https://env.test/api/");
    expect(() => new ZeroBull()).not.toThrow();
  });

  it("maps error replies", async () => {
    const api = mockApi();
    api.add("GET", "/user", { status: 422, json: { message: "nope", errors: { a: ["b"] } } });
    const error = await api.client.user.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual({ a: ["b"] });
  });

  it("retries 429 after Retry-After, then gives up", async () => {
    const api = mockApi();
    api.add("GET", "/user", { status: 429, headers: { "retry-after": "0" } });
    api.add("GET", "/user", { status: 429, headers: { "retry-after": "junk" } });
    api.add("GET", "/user", { json: { data: { id: 7 } } });
    vi.useFakeTimers();
    const user = api.client.user.get();
    await vi.runAllTimersAsync();
    expect((await user).id).toBe(7);
    expect(api.requests).toHaveLength(3);

    const limited = mockApi();
    limited.add("GET", "/user", { status: 429, headers: { "retry-after": "2" } });
    const client = new ZeroBull({
      apiToken: "t",
      baseURL: "https://api.test",
      fetch: limited.fetch,
      maxRetries: 0,
    });
    const error = await client.user.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(2);
  });

  it("maps network failures and timeouts", async () => {
    const failing = new ZeroBull({
      apiToken: "t",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(failing.user.get()).rejects.toBeInstanceOf(APIConnectionError);

    const slow = new ZeroBull({
      apiToken: "t",
      timeout: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    });
    await expect(slow.user.get()).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("rejects a missing data envelope", async () => {
    const api = mockApi();
    api.add("GET", "/user", { json: { id: 1 } });
    await expect(api.client.user.get()).rejects.toThrow("data field");
  });
});
