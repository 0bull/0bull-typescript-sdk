import { describe, expect, it } from "vitest";
import { HttpTransport } from "../src/http.js";
import { Phones } from "../src/resources/phones.js";
import { type CommandOp, HOTKEYS } from "../src/types.js";
import { fakeSocketTransport, mockApi } from "./helpers.js";

const phone = {
  slot: "phone-1",
  name: "Phone",
  video_live: true,
  input_present: false,
  can_control: true,
  model: null,
  os_version: null,
};

const run = {
  id: "run-1",
  slot: "phone-1",
  kind: "command",
  status: "queued",
  label: null,
  result: null,
  error: null,
  started_at: null,
  finished_at: null,
  created_at: "2026-09-16T00:00:00Z",
};

const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

function socketPhones(reply: unknown) {
  const fake = fakeSocketTransport(reply);
  return { phones: new Phones(fake.transport, new HttpTransport({ apiToken: "t" })), ...fake };
}

describe("phones over REST", () => {
  it("lists visible phones", async () => {
    const api = mockApi();
    api.add("GET", "/v1/phones", { json: { data: [phone] } });
    expect(await api.client.phones.list()).toEqual([phone]);
  });

  it("throws when the phones response isn't an array", async () => {
    const api = mockApi();
    api.add("GET", "/v1/phones", { json: { data: "oops" } });
    await expect(api.client.phones.list()).rejects.toThrow("Expected an array");
  });

  it("captures a snapshot as raw bytes, with and without width", async () => {
    const api = mockApi();
    api.add("GET", "/v1/phones/phone-1/snapshot", { body: JPEG });
    expect(await api.client.phones.snapshot("phone-1")).toEqual(JPEG);
    expect(new URL(api.last().url).search).toBe("");

    api.add("GET", "/v1/phones/phone-1/snapshot", { body: JPEG });
    await api.client.phones.snapshot("phone-1", { width: 200 });
    expect(new URL(api.last().url).search).toBe("?width=200");
  });

  it("rejects out-of-range width for snapshot and ocr", () => {
    const { client, requests } = mockApi();
    expect(() => client.phones.snapshot("phone-1", { width: 119 })).toThrow("width must be");
    expect(() => client.phones.snapshot("phone-1", { width: 2001 })).toThrow("width must be");
    expect(() => client.phones.ocr("phone-1", { width: 119 })).toThrow("width must be");
    expect(() => client.phones.ocr("phone-1", { width: 2001 })).toThrow("width must be");
    expect(requests).toHaveLength(0);
  });

  it("reads on-screen text, not enveloped", async () => {
    const api = mockApi();
    api.add("GET", "/v1/phones/phone-1/ocr", { json: { text: "hello" } });
    expect(await api.client.phones.ocr("phone-1", { width: 2000 })).toBe("hello");
    expect(new URL(api.last().url).search).toBe("?width=2000");
  });

  it("taps, swipes, sends hotkeys, and types", async () => {
    const api = mockApi();
    api.add("POST", "/v1/phones/phone-1/input", { json: { op: "tap" } });
    await api.client.phones.tap("phone-1", { fx: 0, fy: 1 });
    expect(await api.last().json()).toEqual({ op: "tap", fx: 0, fy: 1 });

    api.add("POST", "/v1/phones/phone-1/input", { json: { op: "swipe" } });
    await api.client.phones.swipe("phone-1", { fx1: 0, fy1: 1, fx2: 1, fy2: 0, steps: 500 });
    expect(await api.last().json()).toEqual({
      op: "swipe",
      fx1: 0,
      fy1: 1,
      fx2: 1,
      fy2: 0,
      steps: 500,
    });

    api.add("POST", "/v1/phones/phone-1/input", { json: { op: "hotkey" } });
    for (const key of HOTKEYS) {
      await api.client.phones.hotkey("phone-1", key);
      expect(await api.last().json()).toEqual({ op: "hotkey", key });
    }

    api.add("POST", "/v1/phones/phone-1/input", { json: { op: "type" } });
    await api.client.phones.type("phone-1", "hello");
    expect(await api.last().json()).toEqual({ op: "type", text: "hello" });
  });

  it("validates tap, swipe, and hotkey ranges before sending", () => {
    const { client, requests } = mockApi();
    expect(() => client.phones.tap("phone-1", { fx: -0.1, fy: 0.5 })).toThrow("fx must be");
    expect(() => client.phones.tap("phone-1", { fx: 0.5, fy: 1.1 })).toThrow("fy must be");
    expect(() => client.phones.tap("phone-1", { fx: Number.NaN, fy: 0.5 })).toThrow("fx must be");
    expect(() => client.phones.swipe("phone-1", { fx1: -1, fy1: 0.5, fx2: 0.5, fy2: 0.5 })).toThrow(
      "fx1 must be",
    );
    expect(() => client.phones.swipe("phone-1", { fx1: 0.5, fy1: -1, fx2: 0.5, fy2: 0.5 })).toThrow(
      "fy1 must be",
    );
    expect(() => client.phones.swipe("phone-1", { fx1: 0.5, fy1: 0.5, fx2: -1, fy2: 0.5 })).toThrow(
      "fx2 must be",
    );
    expect(() => client.phones.swipe("phone-1", { fx1: 0.5, fy1: 0.5, fx2: 0.5, fy2: -1 })).toThrow(
      "fy2 must be",
    );
    expect(() =>
      client.phones.swipe("phone-1", { fx1: 0.5, fy1: 0.5, fx2: 0.5, fy2: 0.5, steps: 0 }),
    ).toThrow("steps must be");
    expect(() =>
      client.phones.swipe("phone-1", { fx1: 0.5, fy1: 0.5, fx2: 0.5, fy2: 0.5, steps: 501 }),
    ).toThrow("steps must be");
    expect(() => client.phones.hotkey("phone-1", "unknown" as never)).toThrow("Unknown hotkey");
    expect(requests).toHaveLength(0);
  });

  it("queues commands for every op and requires their fields", async () => {
    const api = mockApi();
    const cases: [CommandOp, object][] = [
      ["clipboard_set", { text: "" }],
      ["clipboard_get", {}],
      ["open_url", { url: "https://example.com" }],
      ["reboot", {}],
      ["clear_photos", {}],
      ["get_ip", {}],
      ["brightness", { level: 0 }],
      ["wifi", { on: false }],
      ["airplane", { on: true }],
      ["cellular", { on: false }],
      ["flashlight", { on: true }],
    ];
    for (const [op, params] of cases) {
      api.add("POST", "/v1/phones/phone-1/commands", { json: { data: run } });
      const result = await api.client.phones.runCommand("phone-1", op, params);
      expect(result.id).toBe("run-1");
      expect(await api.last().json()).toEqual({ op, ...params });
    }
  });

  it("normalizes an empty result list to null", async () => {
    const api = mockApi();
    api.add("POST", "/v1/phones/phone-1/commands", { json: { data: { ...run, result: [] } } });
    const result = await api.client.phones.runCommand("phone-1", "get_ip");
    expect(result.result).toBeNull();
  });

  it("validates run_command before sending", () => {
    const { client, requests } = mockApi();
    expect(() => client.phones.runCommand("phone-1", "unknown" as never)).toThrow(
      "Unknown command op",
    );
    expect(() => client.phones.runCommand("phone-1", "clipboard_set")).toThrow(
      "clipboard_set requires text",
    );
    expect(() => client.phones.runCommand("phone-1", "open_url")).toThrow("open_url requires url");
    expect(() => client.phones.runCommand("phone-1", "brightness")).toThrow(
      "brightness requires level",
    );
    expect(() => client.phones.runCommand("phone-1", "wifi")).toThrow("wifi requires on");
    expect(() => client.phones.runCommand("phone-1", "airplane")).toThrow("airplane requires on");
    expect(() => client.phones.runCommand("phone-1", "cellular")).toThrow("cellular requires on");
    expect(() => client.phones.runCommand("phone-1", "flashlight")).toThrow(
      "flashlight requires on",
    );
    expect(() => client.phones.runCommand("phone-1", "brightness", { level: -1 })).toThrow(
      "level must be",
    );
    expect(() => client.phones.runCommand("phone-1", "brightness", { level: 2 })).toThrow(
      "level must be",
    );
    expect(requests).toHaveLength(0);
  });

  it("queues macros with a workflow and params, or with steps", async () => {
    const api = mockApi();
    api.add("POST", "/v1/phones/phone-1/macros", { json: { data: run } });
    await api.client.phones.runMacro("phone-1", {
      workflow: "story",
      params: { caption: "hi", n: 1, x: 0.5, b: false },
    });
    expect(await api.last().json()).toEqual({
      workflow: "story",
      params: { caption: "hi", n: 1, x: 0.5, b: false },
    });

    api.add("POST", "/v1/phones/phone-1/macros", { json: { data: run } });
    await api.client.phones.runMacro("phone-1", { steps: [{ action: "tap", fx: 0.5 }] });
    expect(await api.last().json()).toEqual({ steps: [{ action: "tap", fx: 0.5 }] });
  });

  it("validates run_macro before sending", () => {
    const { client, requests } = mockApi();
    expect(() => client.phones.runMacro("phone-1")).toThrow("Provide exactly one");
    expect(() =>
      client.phones.runMacro("phone-1", { workflow: "a", steps: [{ action: "x" }] }),
    ).toThrow("Provide exactly one");
    expect(() => client.phones.runMacro("phone-1", { steps: [], params: {} })).toThrow(
      "params requires workflow",
    );
    expect(() =>
      client.phones.runMacro("phone-1", { workflow: "a", params: { x: null as never } }),
    ).toThrow("params values must be");
    expect(() =>
      client.phones.runMacro("phone-1", { workflow: "a", params: { x: [1] as never } }),
    ).toThrow("params values must be");
    expect(() => client.phones.runMacro("phone-1", { steps: [{}] })).toThrow(
      "Each step requires a string action",
    );
    expect(() => client.phones.runMacro("phone-1", { steps: [{ action: 1 }] })).toThrow(
      "Each step requires a string action",
    );
    expect(() =>
      client.phones.runMacro("phone-1", { steps: Array(201).fill({ action: "tap" }) }),
    ).toThrow("at most 200");
    expect(requests).toHaveLength(0);
  });

  it("queues an agent task and validates its length", async () => {
    const api = mockApi();
    api.add("POST", "/v1/phones/phone-1/agent-runs", { json: { data: run } });
    await api.client.phones.runAgent("phone-1", "Open Settings");
    expect(await api.last().json()).toEqual({ task: "Open Settings" });

    const { client, requests } = mockApi();
    expect(() => client.phones.runAgent("phone-1", "")).toThrow("1-2000 characters");
    expect(() => client.phones.runAgent("phone-1", "x".repeat(2001))).toThrow("1-2000 characters");
    expect(requests).toHaveLength(0);
  });
});

describe("phones over the socket", () => {
  it("maps every call to its fun and data", async () => {
    const { phones, calls } = socketPhones(run);
    await phones.tap("phone-1", { fx: 0.5, fy: 0.5 });
    await phones.swipe("phone-1", { fx1: 0, fy1: 0, fx2: 1, fy2: 1 });
    await phones.hotkey("phone-1", "home");
    await phones.type("phone-1", "hi");
    await phones.runCommand("phone-1", "get_ip");
    await phones.runMacro("phone-1", { workflow: "story" });
    await phones.runAgent("phone-1", "task");
    expect(calls).toEqual([
      { fun: "/app/phones/input", data: { slot: "phone-1", op: "tap", fx: 0.5, fy: 0.5 } },
      {
        fun: "/app/phones/input",
        data: { slot: "phone-1", op: "swipe", fx1: 0, fy1: 0, fx2: 1, fy2: 1 },
      },
      { fun: "/app/phones/input", data: { slot: "phone-1", op: "hotkey", key: "home" } },
      { fun: "/app/phones/input", data: { slot: "phone-1", op: "type", text: "hi" } },
      { fun: "/app/phones/commands", data: { slot: "phone-1", op: "get_ip" } },
      { fun: "/app/phones/macros", data: { slot: "phone-1", workflow: "story" } },
      { fun: "/app/phones/agent-runs", data: { slot: "phone-1", task: "task" } },
    ]);
  });

  it("lists phones from a raw array", async () => {
    const { phones } = socketPhones([phone]);
    expect(await phones.list()).toEqual([phone]);
  });

  it("decodes a base64 snapshot and parses ocr text", async () => {
    const image = Buffer.from(JPEG).toString("base64");
    const { phones: snapPhones } = socketPhones({ image, content_type: "image/jpeg" });
    expect(Array.from(await snapPhones.snapshot("phone-1", { width: 200 }))).toEqual(
      Array.from(JPEG),
    );

    const { phones: ocrPhones } = socketPhones({ text: "hello" });
    expect(await ocrPhones.ocr("phone-1")).toBe("hello");
  });

  it("normalizes an empty result list to null", async () => {
    const { phones } = socketPhones({ ...run, result: [] });
    const result = await phones.runCommand("phone-1", "get_ip");
    expect(result.result).toBeNull();
  });
});
