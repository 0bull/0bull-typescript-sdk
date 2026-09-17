import { asObject, invalid, noContent, parsePage, pathSegment, unwrap } from "../core.js";
import { Page } from "../pagination.js";
import type { Account, Platform } from "../types.js";
import { Resource } from "./resource.js";

export interface AccountListParams {
  page?: number;
  platform?: Platform;
}

export interface AccountCreateParams {
  handle: string;
  /** Defaults to `tiktok` on the server. */
  platform?: Platform;
  /** Required for TikTok accounts. */
  slot?: string;
  notes?: string;
  /** Required for, and only valid on, YouTube accounts. */
  google_email?: string;
}

/** Omitted fields are left unchanged; `null` clears a field. */
export interface AccountUpdateParams {
  handle?: string;
  slot?: string | null;
  notes?: string | null;
  google_email?: string | null;
}

const parseAccount = {
  parseRest: (response: Parameters<typeof unwrap>[0]) => asObject<Account>(unwrap(response)),
  parseSocket: (data: unknown) => asObject<Account>(data),
};

export class Accounts extends Resource {
  /** List posting accounts, newest first. */
  async list(params: AccountListParams = {}): Promise<Page<Account>> {
    const data = { page: params.page, platform: params.platform };
    const page = await this.transport.execute({
      rest: { method: "GET", path: "/v1/accounts", query: data },
      socket: { fun: "/app/accounts/list", data },
      parseRest: (response) => parsePage<Account>(response.json()),
      parseSocket: (body) => parsePage<Account>(body),
    });
    return new Page(page, (next) => this.list({ ...params, page: next }));
  }

  /** Get one account by id. */
  get(accountId: string): Promise<Account> {
    return this.transport.execute({
      rest: { method: "GET", path: `/v1/accounts/${pathSegment(accountId)}` },
      socket: { fun: "/app/accounts/get", data: { account: accountId } },
      ...parseAccount,
    });
  }

  /** Link a new posting account. */
  create(params: AccountCreateParams): Promise<Account> {
    const platform = params.platform ?? "tiktok";
    if (params.google_email !== undefined && platform !== "youtube") {
      invalid("google_email is only valid for youtube accounts");
    }
    if (platform === "youtube" && params.google_email === undefined) {
      invalid("google_email is required for youtube accounts");
    }
    if (platform === "tiktok" && params.slot === undefined) {
      invalid("slot is required for tiktok accounts");
    }
    const data = {
      platform: params.platform,
      handle: params.handle,
      slot: params.slot,
      notes: params.notes,
      google_email: params.google_email,
    };
    return this.transport.execute({
      rest: { method: "POST", path: "/v1/accounts", json: data },
      socket: { fun: "/app/accounts/create", data },
      ...parseAccount,
    });
  }

  /** Update only the fields passed. */
  update(accountId: string, params: AccountUpdateParams): Promise<Account> {
    const fields = {
      handle: params.handle,
      slot: params.slot,
      notes: params.notes,
      google_email: params.google_email,
    };
    if (Object.values(fields).every((value) => value === undefined)) {
      invalid("At least one field is required to update an account");
    }
    return this.transport.execute({
      rest: {
        method: "PUT",
        path: `/v1/accounts/${pathSegment(accountId)}`,
        json: fields,
        keepNulls: true,
      },
      socket: {
        fun: "/app/accounts/update",
        data: { account: accountId, ...fields },
        keepNulls: true,
      },
      ...parseAccount,
    });
  }

  /** Delete an account. */
  delete(accountId: string): Promise<void> {
    return this.transport.execute({
      rest: { method: "DELETE", path: `/v1/accounts/${pathSegment(accountId)}` },
      socket: { fun: "/app/accounts/delete", data: { account: accountId } },
      parseRest: noContent,
      parseSocket: noContent,
    });
  }
}
