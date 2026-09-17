import { describe, expect, it } from "vitest";
import { HttpTransport } from "../src/http.js";
import { Accounts } from "../src/resources/accounts.js";
import { fakeSocketTransport, mockApi } from "./helpers.js";

const account = { id: "a1", platform: "tiktok", handle: "@me", slot: "s1" };
const meta = { current_page: 1, last_page: 2, per_page: 1, total: 2 };

function socketAccounts(reply: unknown) {
  const fake = fakeSocketTransport(reply);
  return { accounts: new Accounts(fake.transport, new HttpTransport({ apiToken: "t" })), ...fake };
}

describe("accounts over REST", () => {
  it("lists and walks every page", async () => {
    const api = mockApi();
    api.add("GET", "/v1/accounts", { json: { data: [account], meta: { ...meta, path: "x" } } });
    api.add("GET", "/v1/accounts", {
      json: { data: [{ ...account, id: "a2" }], meta: { ...meta, current_page: 2 } },
    });
    const page = await api.client.accounts.list({ platform: "tiktok" });
    expect(new URL(api.last().url).search).toBe("?platform=tiktok");
    const ids: string[] = [];
    for await (const item of page) ids.push(item.id);
    expect(ids).toEqual(["a1", "a2"]);
    expect(new URL(api.last().url).search).toBe("?page=2&platform=tiktok");
  });

  it("gets, creates, updates with nulls, and deletes", async () => {
    const api = mockApi();
    api.add("GET", "/v1/accounts/a%2F1", { json: { data: account } });
    api.add("POST", "/v1/accounts", { status: 201, json: { data: account } });
    api.add("PUT", "/v1/accounts/a1", { json: { data: account } });
    api.add("DELETE", "/v1/accounts/a1", { status: 204 });

    expect(await api.client.accounts.get("a/1")).toEqual(account);
    await api.client.accounts.create({ handle: "@me", slot: "s1" });
    expect(await api.last().json()).toEqual({ handle: "@me", slot: "s1" });
    await api.client.accounts.update("a1", { notes: null });
    expect(api.last().method).toBe("PUT");
    expect(await api.last().json()).toEqual({ notes: null });
    await expect(api.client.accounts.delete("a1")).resolves.toBeUndefined();
  });

  it("validates platform rules before sending", async () => {
    const { client, requests } = mockApi();
    expect(() => client.accounts.create({ handle: "h" })).toThrow("slot is required");
    expect(() => client.accounts.create({ handle: "h", platform: "youtube" })).toThrow(
      "google_email is required",
    );
    expect(() => client.accounts.create({ handle: "h", slot: "s", google_email: "g@x" })).toThrow(
      "only valid",
    );
    expect(() => client.accounts.update("a1", {})).toThrow("At least one field");
    expect(requests).toHaveLength(0);
  });
});

describe("accounts over the socket", () => {
  it("maps every call to its fun", async () => {
    const { accounts, calls } = socketAccounts(account);
    await accounts.get("a1");
    await accounts.create({ handle: "h", platform: "youtube", google_email: "g@x" });
    await accounts.update("a1", { slot: null });
    await accounts.delete("a1");
    expect(calls).toEqual([
      { fun: "/app/accounts/get", data: { account: "a1" } },
      {
        fun: "/app/accounts/create",
        data: { platform: "youtube", handle: "h", google_email: "g@x" },
      },
      {
        fun: "/app/accounts/update",
        data: { account: "a1", slot: null },
      },
      { fun: "/app/accounts/delete", data: { account: "a1" } },
    ]);
  });

  it("parses socket pages", async () => {
    const { accounts } = socketAccounts({ data: [account], meta: { ...meta, last_page: 1 } });
    const page = await accounts.list();
    expect(page.items).toEqual([account]);
    expect(page.hasNextPage()).toBe(false);
    expect(await page.nextPage()).toBeNull();
  });
});
