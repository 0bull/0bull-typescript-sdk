import { asObject, invalid, pathSegment, requireRange } from "../core.js";
import type { BillingRequest, BillingSummary, PhoneCountChange, Rental } from "../types.js";
import { Resource } from "./resource.js";

export interface RentalItemParams {
  country: string;
  quantity: number;
}

export interface StartRentalParams {
  /** Must be `true`: show the user https://0bull.net/terms and https://0bull.net/privacy,
   * including that this renews monthly, before charging. */
  accept_terms: boolean;
  phones?: number;
  country?: string;
  items?: RentalItemParams[];
}

export interface RequestPhoneCountParams {
  /** Must be `true`: show the user https://0bull.net/terms and https://0bull.net/privacy,
   * including that this renews monthly, before charging. */
  accept_terms: boolean;
  phones?: number;
  add?: number;
}

const ACCEPT_TERMS_MESSAGE =
  "accept_terms must be true: show the user https://0bull.net/terms and " +
  "https://0bull.net/privacy, including that this renews monthly, before charging";

function requireAcceptTerms(acceptTerms: boolean): void {
  if (!acceptTerms) invalid(ACCEPT_TERMS_MESSAGE);
}

function requireCountry(country: string | undefined): void {
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) {
    invalid("country must be an ISO-3166 alpha-2 uppercase code");
  }
}

function checkItems(items: RentalItemParams[]): RentalItemParams[] {
  if (items.length < 1 || items.length > 10) {
    invalid("items must have between 1 and 10 entries");
  }
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) {
      invalid("each item's quantity must be between 1 and 50");
    }
  }
  return items;
}

const parseUnenveloped = <T>() => ({
  parseRest: (response: { json(): unknown }) => asObject<T>(response.json()),
  parseSocket: (data: unknown) => asObject<T>(data),
});

export class Billing extends Resource {
  /** Get the account's billing summary. Not enveloped on either transport. */
  summary(): Promise<BillingSummary> {
    return this.transport.execute({
      rest: { method: "GET", path: "/v1/billing" },
      socket: { fun: "/app/billing/summary" },
      ...parseUnenveloped<BillingSummary>(),
    });
  }

  /**
   * Start a rental checkout for more phones. Returns a Stripe Checkout link; no phones are
   * assigned until checkout completes and the order is fulfilled.
   */
  startRental(params: StartRentalParams): Promise<Rental> {
    requireAcceptTerms(params.accept_terms);
    requireCountry(params.country);
    if ((params.phones === undefined) === (params.items === undefined)) {
      invalid("Pass exactly one of phones or items");
    }
    if (params.phones !== undefined) requireRange("phones", params.phones, 1, 50);
    const items = params.items !== undefined ? checkItems(params.items) : undefined;
    const data = {
      phones: params.phones,
      country: params.country,
      items,
      accept_terms: params.accept_terms,
    };
    return this.transport.execute({
      rest: { method: "POST", path: "/v1/billing/rentals", json: data },
      socket: { fun: "/app/billing/rentals", data },
      ...parseUnenveloped<Rental>(),
    });
  }

  /** Request a change to the account's phone count. Applies immediately if within the standing
   * allowance, otherwise returns a pending approval request. */
  requestPhoneCount(params: RequestPhoneCountParams): Promise<PhoneCountChange> {
    requireAcceptTerms(params.accept_terms);
    if ((params.phones === undefined) === (params.add === undefined)) {
      invalid("Pass exactly one of phones or add");
    }
    if (params.phones !== undefined) requireRange("phones", params.phones, 1, 50);
    if (params.add !== undefined) requireRange("add", params.add, -49, 49);
    const data = { phones: params.phones, add: params.add, accept_terms: params.accept_terms };
    return this.transport.execute({
      rest: { method: "POST", path: "/v1/billing/requests", json: data },
      socket: { fun: "/app/billing/requests", data },
      ...parseUnenveloped<PhoneCountChange>(),
    });
  }

  /** Get a billing request by id. */
  getRequest(requestId: string): Promise<BillingRequest> {
    return this.transport.execute({
      rest: { method: "GET", path: `/v1/billing/requests/${pathSegment(requestId)}` },
      socket: { fun: "/app/billing/requests/get", data: { request_id: requestId } },
      ...parseUnenveloped<BillingRequest>(),
    });
  }
}
