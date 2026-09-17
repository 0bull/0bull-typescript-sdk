import { describe, expect, it } from "vitest";
import { HttpTransport } from "../src/http.js";
import { Billing } from "../src/resources/billing.js";
import { fakeSocketTransport, mockApi } from "./helpers.js";

const summary = {
  subscribed: true,
  phones: 3,
  price_per_phone: 9.99,
  monthly: 29.97,
  on_grace_period: false,
  pending_orders: [
    { id: 1, country: "US", phones: 2, availability: "now", placed_at: "2026-01-01" },
  ],
  lines: [{ id: 10, status: "active", cancelling: false, renews_at: "2026-02-01" }],
  hint: "Renews soon",
};

const rental = {
  checkout_url: "https://checkout.stripe.com/abc",
  phones: 5,
  items: [{ country: "US", quantity: 5 }],
  next: "poll GET /v1/billing",
};

const changeApplied = {
  applied: true,
  request_id: "11111111-1111-1111-1111-111111111111",
  from_phones: 3,
  to_phones: 5,
  next: "poll GET /v1/billing",
};

const requestStatus = {
  request_id: "22222222-2222-2222-2222-222222222222",
  status: "pending",
  to_phones: 8,
  approval_url: "https://0bull.net/approve/2",
  expires_at: "2026-01-02",
  resolved_at: null,
};

function socketBilling(reply: unknown) {
  const fake = fakeSocketTransport(reply);
  return { billing: new Billing(fake.transport, new HttpTransport({ apiToken: "t" })), ...fake };
}

describe("billing over REST", () => {
  it("gets the summary, not enveloped", async () => {
    const api = mockApi();
    api.add("GET", "/v1/billing", { json: summary });
    expect(await api.client.billing.summary()).toEqual(summary);
  });

  it("starts a rental with phones, and with items", async () => {
    const api = mockApi();
    api.add("POST", "/v1/billing/rentals", { status: 201, json: rental });
    await api.client.billing.startRental({ accept_terms: true, phones: 5, country: "US" });
    expect(await api.last().json()).toEqual({ phones: 5, country: "US", accept_terms: true });

    api.add("POST", "/v1/billing/rentals", { status: 201, json: rental });
    const result = await api.client.billing.startRental({
      accept_terms: true,
      items: [
        { country: "US", quantity: 3 },
        { country: "CA", quantity: 2 },
      ],
    });
    expect(result).toEqual(rental);
    expect(await api.last().json()).toEqual({
      items: [
        { country: "US", quantity: 3 },
        { country: "CA", quantity: 2 },
      ],
      accept_terms: true,
    });
  });

  it("validates startRental before sending", async () => {
    const { client, requests } = mockApi();
    const cases: [Parameters<typeof client.billing.startRental>[0], string][] = [
      [{ accept_terms: false, phones: 5 }, "accept_terms"],
      [{ accept_terms: true }, "exactly one"],
      [{ accept_terms: true, phones: 5, items: [{ country: "US", quantity: 1 }] }, "exactly one"],
      [{ accept_terms: true, phones: 0 }, "phones"],
      [{ accept_terms: true, phones: 51 }, "phones"],
      [{ accept_terms: true, phones: 5, country: "us" }, "country"],
      [{ accept_terms: true, items: [] }, "items"],
      [{ accept_terms: true, items: Array(11).fill({ country: "US", quantity: 1 }) }, "items"],
      [{ accept_terms: true, items: [{ country: "US", quantity: 0 }] }, "quantity"],
    ];
    for (const [params, match] of cases) {
      expect(() => client.billing.startRental(params), JSON.stringify(params)).toThrow(match);
    }
    expect(requests).toHaveLength(0);
  });

  it("states the terms and privacy URLs when accept_terms is missing", () => {
    const { client } = mockApi();
    expect(() => client.billing.startRental({ accept_terms: false, phones: 1 })).toThrow(
      "https://0bull.net/terms",
    );
    expect(() => client.billing.requestPhoneCount({ accept_terms: false, phones: 1 })).toThrow(
      "https://0bull.net/privacy",
    );
  });

  it("requests a phone count change, applied and allowing a zero add", async () => {
    const api = mockApi();
    api.add("POST", "/v1/billing/requests", { status: 201, json: changeApplied });
    const result = await api.client.billing.requestPhoneCount({ accept_terms: true, phones: 5 });
    expect(result.applied).toBe(true);
    expect(await api.last().json()).toEqual({ phones: 5, accept_terms: true });

    api.add("POST", "/v1/billing/requests", { status: 201, json: changeApplied });
    await api.client.billing.requestPhoneCount({ accept_terms: true, add: 0 });
    expect(await api.last().json()).toEqual({ add: 0, accept_terms: true });
  });

  it("validates requestPhoneCount before sending", async () => {
    const { client, requests } = mockApi();
    const cases: [Parameters<typeof client.billing.requestPhoneCount>[0], string][] = [
      [{ accept_terms: false, phones: 5 }, "accept_terms"],
      [{ accept_terms: true }, "exactly one"],
      [{ accept_terms: true, phones: 5, add: 1 }, "exactly one"],
      [{ accept_terms: true, phones: 0 }, "phones"],
      [{ accept_terms: true, phones: 51 }, "phones"],
      [{ accept_terms: true, add: 50 }, "add"],
      [{ accept_terms: true, add: -50 }, "add"],
    ];
    for (const [params, match] of cases) {
      expect(() => client.billing.requestPhoneCount(params), JSON.stringify(params)).toThrow(match);
    }
    expect(requests).toHaveLength(0);
  });

  it("gets a billing request by id, not enveloped", async () => {
    const api = mockApi();
    api.add("GET", "/v1/billing/requests/22222222-2222-2222-2222-222222222222", {
      json: requestStatus,
    });
    const result = await api.client.billing.getRequest("22222222-2222-2222-2222-222222222222");
    expect(result).toEqual(requestStatus);
    const request = api.last();
    expect(request.method).toBe("GET");
  });
});

describe("billing over the socket", () => {
  it("maps every call to its fun", async () => {
    const { billing, calls } = socketBilling(summary);
    await billing.summary();
    expect(calls).toEqual([{ fun: "/app/billing/summary", data: {} }]);
  });

  it("sends rental and request data", async () => {
    const { billing, calls } = socketBilling(rental);
    await billing.startRental({ accept_terms: true, phones: 5, country: "US" });
    expect(calls).toEqual([
      { fun: "/app/billing/rentals", data: { phones: 5, country: "US", accept_terms: true } },
    ]);
  });

  it("sends phone-count request data", async () => {
    const { billing, calls } = socketBilling(changeApplied);
    await billing.requestPhoneCount({ accept_terms: true, add: 5 });
    expect(calls).toEqual([{ fun: "/app/billing/requests", data: { add: 5, accept_terms: true } }]);
  });

  it("gets a billing request with { request_id }", async () => {
    const { billing, calls } = socketBilling(requestStatus);
    const result = await billing.getRequest("abc");
    expect(result).toEqual(requestStatus);
    expect(calls).toEqual([{ fun: "/app/billing/requests/get", data: { request_id: "abc" } }]);
  });
});
