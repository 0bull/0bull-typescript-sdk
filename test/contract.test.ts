// Contract test: the SDK's REST operations and response types against the vendored
// OpenAPI spec (test/fixtures/openapi.json, copied from the published API docs).
//
// Every implemented resource method is called once with valid sample args through a
// recording Transport, so the paths and fields under test come from the SDK itself
// rather than being duplicated by hand. Each recorded call is checked against the
// spec: the method + path template exists, and every query/JSON/multipart field the
// SDK sends is a documented parameter/property.
//
// Response interfaces in src/types.ts are checked the same way: each key list below
// is typed `satisfies Record<keyof X, true>` so the compiler forces it to match the
// interface, and the test asserts every key exists in the matching spec schema
// (an optional interface field may be absent from the spec's `required`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compact, type Operation, type RestRequest, type Transport } from "../src/core.js";
import { HttpTransport } from "../src/http.js";
import { Accounts } from "../src/resources/accounts.js";
import { Billing } from "../src/resources/billing.js";
import { Phones } from "../src/resources/phones.js";
import { Runs } from "../src/resources/runs.js";
import { SessionResource } from "../src/resources/session.js";
import { Submissions } from "../src/resources/submissions.js";
import { Uploads } from "../src/resources/uploads.js";
import { UserResource } from "../src/resources/user.js";
import type {
  Account,
  BillingLine,
  BillingRequest,
  BillingSummary,
  ControllerSession,
  PendingOrder,
  Phone,
  PhoneCountChange,
  Rental,
  RentalItem,
  Run,
  SessionPhone,
  Submission,
  SubmissionFailure,
  UploadURL,
  User,
} from "../src/types.js";
import { HOTKEYS } from "../src/types.js";

interface SpecSchema {
  type?: string | string[];
  properties?: Record<string, SpecSchema>;
  items?: SpecSchema;
  required?: string[];
  enum?: unknown[];
}

interface SpecParameter {
  name: string;
  in: string;
}

interface SpecOperation {
  parameters?: SpecParameter[];
  requestBody?: { content?: Record<string, { schema?: SpecSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: SpecSchema }> }>;
}

interface Spec {
  paths: Record<string, Record<string, SpecOperation>>;
  components: { schemas: Record<string, SpecSchema> };
}

const SPEC: Spec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "openapi.json"), "utf8"),
);

/** Match a concrete method + path to a spec operation by path segment. */
function findSpecOp(method: string, path: string): SpecOperation {
  const actual = path.split("/").filter((segment) => segment !== "");
  for (const [template, operations] of Object.entries(SPEC.paths)) {
    const operation = operations[method.toLowerCase()];
    if (!operation) continue;
    const parts = template.split("/").filter((segment) => segment !== "");
    if (parts.length !== actual.length) continue;
    if (parts.every((part, index) => part.startsWith("{") || part === actual[index])) {
      return operation;
    }
  }
  throw new Error(`no spec route matches ${method} ${path}`);
}

function documentedQueryParams(operation: SpecOperation): Set<string> {
  return new Set((operation.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name));
}

function documentedBodyProperties(operation: SpecOperation): Set<string> {
  const properties = new Set<string>();
  for (const content of Object.values(operation.requestBody?.content ?? {})) {
    for (const name of Object.keys(content.schema?.properties ?? {})) properties.add(name);
  }
  return properties;
}

/** Fields the SDK sends, mirroring HttpTransport: `compact` drops `undefined` (and `null`
 * unless `keepNulls`); a form or file sends multipart. */
function sentQueryKeys(rest: RestRequest): string[] {
  return Object.keys(compact(rest.query));
}

function sentBodyKeys(rest: RestRequest): string[] {
  if (rest.form !== undefined || rest.file !== undefined) {
    const fields = Object.keys(compact(rest.form));
    if (rest.file !== undefined) fields.push(rest.file.field);
    return fields;
  }
  if (rest.json !== undefined) return Object.keys(compact(rest.json, rest.keepNulls));
  return [];
}

type Shape = "unwrapped" | "wrapped" | "list";

/** Every success-response schema for an operation, unwrapped to the model shape
 * (`wrapped` reads `data`, `list` reads `data.items`) and descended into nested
 * models; the union covers endpoints with several success shapes. */
function responseSchemas(
  operation: SpecOperation,
  shape: Shape,
  descend: readonly string[],
): SpecSchema[] {
  const schemas: SpecSchema[] = [];
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!/^\d+$/.test(status) || Number(status) >= 300) continue;
    const schema = response.content?.["application/json"]?.schema;
    if (!schema) continue;
    let node = schema;
    if (shape === "wrapped") node = node.properties?.data ?? {};
    else if (shape === "list") node = node.properties?.data?.items ?? {};
    for (const key of descend) {
      const child = node.properties?.[key];
      if (!child) {
        node = {};
        break;
      }
      const types = Array.isArray(child.type) ? child.type : [child.type];
      node = types.includes("array") ? (child.items ?? {}) : child;
    }
    schemas.push(node);
  }
  return schemas;
}

function missingKeys(keys: readonly string[], schemas: readonly SpecSchema[]): string[] {
  const documented = new Set(schemas.flatMap((s) => Object.keys(s.properties ?? {})));
  return keys.filter((key) => !documented.has(key));
}

// --- operations under test ---------------------------------------------------

/** A Transport that records the REST request instead of sending it. `reply` is what
 * `execute` resolves with; composite helpers like `wait` need a terminal reply so
 * they finish after one recorded call. */
function recording(
  reply: unknown = {
    items: [],
    current_page: 1,
    last_page: 1,
    per_page: 50,
    total: 0,
  },
) {
  const calls: RestRequest[] = [];
  const transport: Transport = {
    supportsRest: true,
    execute<T>(operation: Operation<T>): Promise<T> {
      if (!operation.rest) throw new Error("contract test records REST operations only");
      calls.push(operation.rest);
      return Promise.resolve(reply as T);
    },
  };
  const http = new HttpTransport({ apiToken: "contract" });
  return {
    calls,
    transport,
    http,
    accounts: new Accounts(transport, http),
    billing: new Billing(transport, http),
    phones: new Phones(transport, http),
    runs: new Runs(transport, http),
    user: new UserResource(transport, http),
    session: new SessionResource(transport, http),
    submissions: new Submissions(transport, http),
    uploads: new Uploads(transport, http),
  };
}

interface Case {
  name: string;
  /** The `area.method` this case covers; the coverage test counts these. */
  method: string;
  reply?: unknown;
  run: (resources: ReturnType<typeof recording>) => Promise<unknown>;
}

const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const BILLING_REQUEST_ID = "33333333-3333-3333-3333-333333333333";
const SLOT = "slot-1";

// One representative call per implemented resource method, with valid sample args.
const CASES: Case[] = [
  {
    name: "accounts.list",
    method: "accounts.list",
    run: (r) => r.accounts.list({ page: 1, platform: "tiktok" }),
  },
  { name: "accounts.get", method: "accounts.get", run: (r) => r.accounts.get(ACCOUNT_ID) },
  {
    name: "accounts.create",
    method: "accounts.create",
    run: (r) =>
      r.accounts.create({ handle: "@me", platform: "tiktok", slot: "slot-1", notes: "note" }),
  },
  {
    name: "accounts.update",
    method: "accounts.update",
    run: (r) =>
      r.accounts.update(ACCOUNT_ID, {
        handle: "@new",
        slot: null,
        notes: null,
        google_email: null,
      }),
  },
  {
    name: "accounts.delete",
    method: "accounts.delete",
    run: (r) => r.accounts.delete(ACCOUNT_ID),
  },
  { name: "billing.summary", method: "billing.summary", run: (r) => r.billing.summary() },
  {
    name: "billing.startRental with phones",
    method: "billing.startRental",
    run: (r) => r.billing.startRental({ accept_terms: true, phones: 5, country: "US" }),
  },
  {
    name: "billing.startRental with items",
    method: "billing.startRental",
    run: (r) =>
      r.billing.startRental({ accept_terms: true, items: [{ country: "US", quantity: 2 }] }),
  },
  {
    name: "billing.requestPhoneCount with phones",
    method: "billing.requestPhoneCount",
    run: (r) => r.billing.requestPhoneCount({ accept_terms: true, phones: 5 }),
  },
  {
    name: "billing.requestPhoneCount with add",
    method: "billing.requestPhoneCount",
    run: (r) => r.billing.requestPhoneCount({ accept_terms: true, add: 2 }),
  },
  {
    name: "billing.getRequest",
    method: "billing.getRequest",
    run: (r) => r.billing.getRequest(BILLING_REQUEST_ID),
  },
  { name: "phones.list", method: "phones.list", run: (r) => r.phones.list() },
  {
    name: "phones.snapshot",
    method: "phones.snapshot",
    run: (r) => r.phones.snapshot(SLOT, { width: 600 }),
  },
  { name: "phones.ocr", method: "phones.ocr", run: (r) => r.phones.ocr(SLOT, { width: 600 }) },
  {
    name: "phones.tap",
    method: "phones.tap",
    run: (r) => r.phones.tap(SLOT, { fx: 0.5, fy: 0.5 }),
  },
  {
    name: "phones.swipe",
    method: "phones.swipe",
    run: (r) => r.phones.swipe(SLOT, { fx1: 0.1, fy1: 0.1, fx2: 0.9, fy2: 0.9, steps: 10 }),
  },
  {
    name: "phones.hotkey",
    method: "phones.hotkey",
    run: (r) => r.phones.hotkey(SLOT, "home"),
  },
  {
    name: "phones.type",
    method: "phones.type",
    run: (r) => r.phones.type(SLOT, "hello"),
  },
  {
    name: "phones.runCommand",
    method: "phones.runCommand",
    run: (r) => r.phones.runCommand(SLOT, "brightness", { level: 0.5 }),
  },
  {
    name: "phones.runMacro",
    method: "phones.runMacro",
    run: (r) => r.phones.runMacro(SLOT, { workflow: "post-to-story", params: { caption: "hi" } }),
  },
  {
    name: "phones.runAgent",
    method: "phones.runAgent",
    run: (r) => r.phones.runAgent(SLOT, "open settings"),
  },
  {
    name: "runs.list",
    method: "runs.list",
    run: (r) => r.runs.list(SLOT, { page: 1 }),
  },
  { name: "runs.get", method: "runs.get", run: (r) => r.runs.get(SLOT, RUN_ID) },
  {
    name: "runs.wait",
    method: "runs.wait",
    reply: { id: RUN_ID, slot: SLOT, status: "succeeded" },
    run: (r) => r.runs.wait({ slot: SLOT, id: RUN_ID } as Run, { timeout: 1000, interval: 1 }),
  },
  { name: "user.get", method: "user.get", run: (r) => r.user.get() },
  { name: "session.create", method: "session.create", run: (r) => r.session.create() },
  {
    name: "submissions.list",
    method: "submissions.list",
    run: (r) => r.submissions.list({ page: 1, platform: "tiktok" }),
  },
  {
    name: "submissions.get",
    method: "submissions.get",
    run: (r) => r.submissions.get(123),
  },
  {
    name: "submissions.create with video",
    method: "submissions.create",
    run: (r) =>
      r.submissions.create({
        account_id: ACCOUNT_ID,
        video: new Uint8Array([1]),
        caption: "hi",
        draft: false,
      }),
  },
  {
    name: "submissions.create with video_url",
    method: "submissions.create",
    run: (r) =>
      r.submissions.create({
        account_id: ACCOUNT_ID,
        platform: "tiktok",
        video_url: "https://example.com/video.mp4",
      }),
  },
  {
    name: "submissions.create with upload_id",
    method: "submissions.create",
    run: (r) => r.submissions.create({ account_id: ACCOUNT_ID, upload_id: "upload-1" }),
  },
  {
    name: "submissions.cancel",
    method: "submissions.cancel",
    run: (r) => r.submissions.cancel(123),
  },
  {
    name: "submissions.delete",
    method: "submissions.delete",
    run: (r) => r.submissions.delete(123),
  },
  {
    name: "submissions.wait",
    method: "submissions.wait",
    reply: { id: 123, status: "published" },
    run: (r) => r.submissions.wait(123, { timeout: 1000, interval: 1 }),
  },
  { name: "uploads.create", method: "uploads.create", run: (r) => r.uploads.create() },
  {
    name: "uploads.upload",
    method: "uploads.upload",
    // The second step posts bytes to the signed URL, outside the API contract.
    run: (r) =>
      new Uploads(r.transport, {
        upload: async () => undefined,
      } as unknown as HttpTransport).upload(new Uint8Array([1])),
  },
];

async function recordedRest(kase: Case): Promise<RestRequest> {
  const resources = recording(kase.reply);
  await kase.run(resources);
  expect(resources.calls).toHaveLength(1);
  const rest = resources.calls[0];
  if (!rest) throw new Error(`${kase.name} sent no REST request`);
  return rest;
}

const RESOURCES: Record<string, { prototype: object }> = {
  accounts: Accounts,
  billing: Billing,
  phones: Phones,
  runs: Runs,
  session: SessionResource,
  submissions: Submissions,
  uploads: Uploads,
  user: UserResource,
};

// --- response interfaces under test ------------------------------------------

// Each key list must match its interface key-for-key (enforced by the compiler);
// each entry points at the spec response that documents it.
const userKeys = {
  id: true,
  name: true,
  email: true,
  email_verified_at: true,
} satisfies Record<keyof User, true>;
const accountKeys = {
  id: true,
  platform: true,
  handle: true,
  slot: true,
  notes: true,
  google_email: true,
  created_at: true,
  updated_at: true,
} satisfies Record<keyof Account, true>;
const phoneKeys = {
  slot: true,
  name: true,
  video_live: true,
  input_present: true,
  can_control: true,
  model: true,
  os_version: true,
} satisfies Record<keyof Phone, true>;
const runKeys = {
  id: true,
  slot: true,
  kind: true,
  status: true,
  label: true,
  result: true,
  error: true,
  started_at: true,
  finished_at: true,
  created_at: true,
} satisfies Record<keyof Run, true>;
const submissionFailureKeys = {
  step: true,
  message: true,
} satisfies Record<keyof SubmissionFailure, true>;
const submissionKeys = {
  id: true,
  platform: true,
  account_id: true,
  caption: true,
  draft: true,
  status: true,
  attempts: true,
  failure: true,
  started_at: true,
  finished_at: true,
  created_at: true,
  updated_at: true,
} satisfies Record<keyof Submission, true>;
const uploadURLKeys = {
  upload_id: true,
  upload_url: true,
  expires_at: true,
} satisfies Record<keyof UploadURL, true>;
const pendingOrderKeys = {
  id: true,
  country: true,
  phones: true,
  availability: true,
  placed_at: true,
} satisfies Record<keyof PendingOrder, true>;
const billingLineKeys = {
  id: true,
  status: true,
  cancelling: true,
  renews_at: true,
} satisfies Record<keyof BillingLine, true>;
const billingSummaryKeys = {
  subscribed: true,
  phones: true,
  price_per_phone: true,
  monthly: true,
  on_grace_period: true,
  pending_orders: true,
  lines: true,
  hint: true,
} satisfies Record<keyof BillingSummary, true>;
const rentalItemKeys = {
  country: true,
  quantity: true,
} satisfies Record<keyof RentalItem, true>;
const rentalKeys = {
  checkout_url: true,
  phones: true,
  items: true,
  next: true,
} satisfies Record<keyof Rental, true>;
const phoneCountChangeKeys = {
  applied: true,
  request_id: true,
  from_phones: true,
  to_phones: true,
  next: true,
  approval_url: true,
  charge_now: true,
  charge_on_assignment: true,
  monthly_after: true,
  pricing_unavailable: true,
  expires_at: true,
} satisfies Record<keyof PhoneCountChange, true>;
const billingRequestKeys = {
  request_id: true,
  status: true,
  to_phones: true,
  approval_url: true,
  expires_at: true,
  resolved_at: true,
} satisfies Record<keyof BillingRequest, true>;
const sessionPhoneKeys = {
  id: true,
  name: true,
  video_live: true,
  input_present: true,
  can_control: true,
  model: true,
  os_version: true,
} satisfies Record<keyof SessionPhone, true>;
const controllerSessionKeys = {
  phones: true,
  socket_url: true,
  farm_online: true,
} satisfies Record<keyof ControllerSession, true>;

interface Model {
  label: string;
  keys: Record<string, true>;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  shape: Shape;
  descend?: readonly string[];
}

const MODELS: Model[] = [
  { label: "User", keys: userKeys, method: "GET", path: "/user", shape: "wrapped" },
  {
    label: "Account",
    keys: accountKeys,
    method: "GET",
    path: "/v1/accounts/{account}",
    shape: "wrapped",
  },
  { label: "Phone", keys: phoneKeys, method: "GET", path: "/v1/phones", shape: "list" },
  {
    label: "Run",
    keys: runKeys,
    method: "POST",
    path: "/v1/phones/{slot}/commands",
    shape: "wrapped",
  },
  {
    label: "Run (page)",
    keys: runKeys,
    method: "GET",
    path: "/v1/phones/{slot}/runs",
    shape: "list",
  },
  {
    label: "Submission",
    keys: submissionKeys,
    method: "GET",
    path: "/v1/submissions/{submission}",
    shape: "wrapped",
  },
  {
    label: "Submission (page)",
    keys: submissionKeys,
    method: "GET",
    path: "/v1/submissions",
    shape: "list",
  },
  {
    label: "SubmissionFailure",
    keys: submissionFailureKeys,
    method: "GET",
    path: "/v1/submissions/{submission}",
    shape: "wrapped",
    descend: ["failure"],
  },
  {
    label: "UploadURL",
    keys: uploadURLKeys,
    method: "POST",
    path: "/v1/uploads",
    shape: "unwrapped",
  },
  {
    label: "BillingSummary",
    keys: billingSummaryKeys,
    method: "GET",
    path: "/v1/billing",
    shape: "unwrapped",
  },
  {
    label: "PendingOrder",
    keys: pendingOrderKeys,
    method: "GET",
    path: "/v1/billing",
    shape: "unwrapped",
    descend: ["pending_orders"],
  },
  {
    label: "BillingLine",
    keys: billingLineKeys,
    method: "GET",
    path: "/v1/billing",
    shape: "unwrapped",
    descend: ["lines"],
  },
  {
    label: "Rental",
    keys: rentalKeys,
    method: "POST",
    path: "/v1/billing/rentals",
    shape: "unwrapped",
  },
  {
    label: "RentalItem",
    keys: rentalItemKeys,
    method: "POST",
    path: "/v1/billing/rentals",
    shape: "unwrapped",
    descend: ["items"],
  },
  {
    label: "PhoneCountChange",
    keys: phoneCountChangeKeys,
    method: "POST",
    path: "/v1/billing/requests",
    shape: "unwrapped",
  },
  {
    label: "BillingRequest",
    keys: billingRequestKeys,
    method: "GET",
    path: "/v1/billing/requests/{billingRequest}",
    shape: "unwrapped",
  },
  {
    label: "ControllerSession",
    keys: controllerSessionKeys,
    method: "GET",
    path: "/v1/phone-controller",
    shape: "unwrapped",
  },
  {
    label: "SessionPhone",
    keys: sessionPhoneKeys,
    method: "GET",
    path: "/v1/phone-controller",
    shape: "unwrapped",
    descend: ["phones"],
  },
];

// --- tests -------------------------------------------------------------------

describe("contract", () => {
  it("covers every public resource method with a case", () => {
    const actual = new Set<string>();
    for (const [area, cls] of Object.entries(RESOURCES)) {
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name !== "constructor" && !name.startsWith("_")) actual.add(`${area}.${name}`);
      }
    }
    const covered = new Set(CASES.map((kase) => kase.method));
    const uncovered = [...actual].filter((name) => !covered.has(name));
    expect(uncovered, `add a contract case for: ${uncovered.join(", ")}`).toEqual([]);
    const stale = [...covered].filter((name) => !actual.has(name));
    expect(stale, `stale contract cases for removed methods: ${stale.join(", ")}`).toEqual([]);
  });

  for (const kase of CASES) {
    it(`${kase.name} hits a documented route`, async () => {
      const rest = await recordedRest(kase);
      expect(() => findSpecOp(rest.method, rest.path)).not.toThrow();
    });

    it(`${kase.name} sends only documented fields`, async () => {
      const rest = await recordedRest(kase);
      const operation = findSpecOp(rest.method, rest.path);
      const query = sentQueryKeys(rest).filter((key) => !documentedQueryParams(operation).has(key));
      const body = sentBodyKeys(rest).filter(
        (key) => !documentedBodyProperties(operation).has(key),
      );
      expect(query, `${kase.name}: undocumented query params`).toEqual([]);
      expect(body, `${kase.name}: undocumented body fields`).toEqual([]);
    });
  }

  for (const model of MODELS) {
    it(`${model.label} matches the spec response`, () => {
      const operation = findSpecOp(model.method, model.path);
      const schemas = responseSchemas(operation, model.shape, model.descend ?? []);
      expect(schemas.length, `${model.label}: no documented success response`).toBeGreaterThan(0);
      const missing = missingKeys(Object.keys(model.keys), schemas);
      expect(missing, `${model.label} fields missing from the spec`).toEqual([]);
    });
  }

  it("tracks the spec's hotkey enum exactly", () => {
    const key = SPEC.components.schemas.PhoneInputRequest?.properties?.key;
    expect(new Set(HOTKEYS)).toEqual(new Set(key?.enum));
  });

  it("flags an interface field the spec does not document", () => {
    const schemas: SpecSchema[] = [
      { type: "object", properties: { id: { type: "string" }, platform: { type: "string" } } },
    ];
    expect(missingKeys(["id", "platfrom"], schemas)).toEqual(["platfrom"]);
  });
});
