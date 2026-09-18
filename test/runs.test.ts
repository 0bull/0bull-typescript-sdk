import { describe, expect, it } from "vitest";
import { WaitTimeoutError } from "../src/errors.js";
import { HttpTransport } from "../src/http.js";
import { Runs } from "../src/resources/runs.js";
import { fakeSocketTransport, mockApi } from "./helpers.js";

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
const meta = { current_page: 1, last_page: 2, per_page: 1, total: 2 };

function socketRuns(reply: unknown) {
  const fake = fakeSocketTransport(reply);
  return { runs: new Runs(fake.transport, new HttpTransport({ apiToken: "t" })), ...fake };
}

describe("runs over REST", () => {
  it("lists and walks every page", async () => {
    const api = mockApi();
    api.add("GET", "/v1/phones/phone-1/runs", { json: { data: [run], meta } });
    api.add("GET", "/v1/phones/phone-1/runs", {
      json: { data: [{ ...run, id: "run-2" }], meta: { ...meta, current_page: 2 } },
    });
    const page = await api.client.runs.list("phone-1");
    expect(new URL(api.last().url).search).toBe("");
    const ids: string[] = [];
    for await (const item of page) ids.push(item.id);
    expect(ids).toEqual(["run-1", "run-2"]);
    expect(new URL(api.last().url).search).toBe("?page=2");
  });

  it("gets one run", async () => {
    const api = mockApi();
    api.add("GET", "/v1/phones/phone-1/runs/run-1", { json: { data: run } });
    expect(await api.client.runs.get("phone-1", "run-1")).toEqual(run);
    expect(new URL(api.last().url).search).toBe("");
    expect(await api.last().text()).toBe("");
  });

  it("rejects page below 1 before sending", async () => {
    const { client, requests } = mockApi();
    await expect(client.runs.list("phone-1", { page: 0 })).rejects.toThrow(
      "page must be at least 1",
    );
    expect(requests).toHaveLength(0);
  });

  it("waits for a terminal status", async () => {
    const api = mockApi();
    api.add("GET", "/v1/phones/phone-1/runs/run-1", { json: { data: run } });
    api.add("GET", "/v1/phones/phone-1/runs/run-1", {
      json: { data: { ...run, status: "succeeded", result: { text: "done" } } },
    });
    const result = await api.client.runs.wait(run, { interval: 0, timeout: 5000 });
    expect(result.status).toBe("succeeded");
    expect(result.result).toEqual({ text: "done" });
  });

  it("times out waiting", async () => {
    const api = mockApi();
    api.add("GET", "/v1/phones/phone-1/runs/run-1", { json: { data: run } });
    await expect(api.client.runs.wait(run, { interval: 1, timeout: 0 })).rejects.toThrow(
      WaitTimeoutError,
    );
    await expect(api.client.runs.wait(run, { interval: 1, timeout: 0 })).rejects.toThrow(
      "run run-1",
    );
  });
});

describe("runs over the socket", () => {
  it("maps get to its fun and data", async () => {
    const { runs, calls } = socketRuns(run);
    await runs.get("phone-1", "run-1");
    expect(calls).toEqual([
      { fun: "/app/phones/runs/get", data: { slot: "phone-1", run: "run-1" } },
    ]);
  });

  it("maps list with a page", async () => {
    const { runs, calls } = socketRuns({ data: [run], meta: { ...meta, last_page: 1 } });
    await runs.list("phone-1", { page: 2 });
    expect(calls).toEqual([{ fun: "/app/phones/runs", data: { slot: "phone-1", page: 2 } }]);
  });

  it("parses socket pages", async () => {
    const { runs } = socketRuns({ data: [run], meta: { ...meta, last_page: 1 } });
    const page = await runs.list("phone-1");
    expect(page.items[0]).toEqual(run);
    expect(page.hasNextPage()).toBe(false);
  });
});
