import { asObject, invalid, parsePage, pathSegment, unwrap, waitUntil } from "../core.js";
import { Page } from "../pagination.js";
import type { Run } from "../types.js";
import { TERMINAL_RUN_STATUSES } from "../types.js";
import { Resource } from "./resource.js";

export interface RunListParams {
  /** One-based. */
  page?: number;
}

export interface RunWaitParams {
  /** Milliseconds. Default 300000. */
  timeout?: number;
  /** Milliseconds. Default 2000. */
  interval?: number;
}

/** Parses a single Run, unwrapped on REST, raw on the socket. */
export const parseRun = {
  parseRest: (response: Parameters<typeof unwrap>[0]) => asObject<Run>(unwrap(response)),
  parseSocket: (data: unknown) => asObject<Run>(data),
};

export class Runs extends Resource {
  /** Get a page of phone runs; walk `page` with `for await` for the full history. */
  async list(slot: string, params: RunListParams = {}): Promise<Page<Run>> {
    if (params.page !== undefined && params.page < 1) invalid("page must be at least 1");
    const page = await this.transport.execute({
      rest: {
        method: "GET",
        path: `/v1/phones/${pathSegment(slot)}/runs`,
        query: { page: params.page },
      },
      socket: { fun: "/app/phones/runs", data: { slot, page: params.page } },
      parseRest: (response) => parsePage<Run>(response.json()),
      parseSocket: (body) => parsePage<Run>(body),
    });
    return new Page(page, (next) => this.list(slot, { ...params, page: next }));
  }

  /** Get the current status and result of a phone run. */
  get(slot: string, runId: string): Promise<Run> {
    return this.transport.execute({
      rest: { method: "GET", path: `/v1/phones/${pathSegment(slot)}/runs/${pathSegment(runId)}` },
      socket: { fun: "/app/phones/runs/get", data: { slot, run: runId } },
      ...parseRun,
    });
  }

  /** Poll a run until terminal, throwing `WaitTimeoutError` after `timeout` ms. */
  wait(run: Run, params: RunWaitParams = {}): Promise<Run> {
    const { timeout = 300_000, interval = 2_000 } = params;
    return waitUntil(
      () => this.get(run.slot, run.id),
      (value) => TERMINAL_RUN_STATUSES.has(value.status),
      { timeout, interval, what: `run ${run.id}` },
    );
  }
}
