[![0bull](https://0bull.net/images/brand/og-image.jpg)](https://0bull.net)

# 0bull TypeScript SDK

A typed TypeScript client for the [0bull API](https://docs.0bull.net): manage posting accounts,
publish videos, and control phones from Node. See [0bull.net](https://0bull.net) for the product
and [docs.0bull.net](https://docs.0bull.net) for the full API reference.

## Install

```bash
npm install 0bull
```

The package is published as `0bull`, ESM only, and requires Node 22+. It has zero runtime
dependencies (it uses the global `fetch`, `FormData`, `Blob`, and `WebSocket`).

```ts
import { ZeroBull } from "0bull";
```

Methods are camelCase (`runMacro`); fields sent to or returned by the API keep the API's
snake_case names (`account_id`, `video_url`), so the types mirror the API docs directly. Durations
(`timeout`, `interval`, `callTimeout`, ...) are always milliseconds.

## Authentication

Create a token at [0bull.net/settings/api-tokens](https://0bull.net/settings/api-tokens), scoped
to the abilities your code needs:

| Ability | Grants |
|---|---|
| `phones:read` | List phones, snapshots, OCR |
| `phones:control` | Tap, swipe, hotkey, type, runs |
| `accounts` | List, create, update, delete posting accounts |
| `submissions` | List, create, cancel, delete submissions; uploads |
| `billing` | Billing summary, rentals, phone count requests |

Pass the token explicitly or set `ZEROBULL_API_TOKEN`:

```ts
import { ZeroBull } from "0bull";

const client = new ZeroBull({ apiToken: "..." });
// or, with ZEROBULL_API_TOKEN set in the environment:
const client = new ZeroBull();
```

A request made with a token missing the required ability throws `PermissionDeniedError`.

## Quickstart

The SDK is async-only. `ZeroBull` is the REST client; `client.socket()` returns a `Socket` for the
WebSocket (see [The socket and events](#the-socket-and-events)).

```ts
import { ZeroBull } from "0bull";

const client = new ZeroBull();

const phones = await client.phones.list();
const phone = phones[0];
if (phone) console.log(`${phone.slot}: ${phone.name}`);
```

## Phones and runs

Coordinates for `tap`, `swipe`, and `runCommand`'s brightness `level` are 0-1 fractions of the
screen; `snapshot` and `ocr` accept an optional `width` between 120 and 2000.

```ts
const phones = await client.phones.list();
const slot = phones[0]!.slot;

const jpeg: Uint8Array = await client.phones.snapshot(slot, { width: 600 });
const text: string = await client.phones.ocr(slot);

await client.phones.tap(slot, { fx: 0.5, fy: 0.9 });
await client.phones.swipe(slot, { fx1: 0.5, fy1: 0.8, fx2: 0.5, fy2: 0.2, steps: 30 });
await client.phones.type(slot, "hello");
await client.phones.hotkey(slot, "enter");
```

Commands, macros, and agent tasks all queue a `Run`:

```ts
let run = await client.phones.runCommand(slot, "brightness", { level: 0.5 });
run = await client.phones.runMacro(slot, { workflow: "post-to-story", params: { caption: "hi" } });
run = await client.phones.runAgent(slot, "Open Settings and turn on Wi-Fi");

run = await client.runs.wait(run, { timeout: 300_000 });
console.log(run.status, run.result);

for await (const run of await client.runs.list(slot)) {
  console.log(run.id, run.status);
}
```

`wait()` polls until the run reaches a terminal status (`succeeded`, `failed`, `cancelled`) and
throws `WaitTimeoutError` if `timeout` elapses first.

## Accounts

```ts
const account = await client.accounts.create({ handle: "@me", platform: "tiktok", slot });
// google_email is required for, and only valid on, youtube accounts; slot is required for tiktok

await client.accounts.update(account.id, { notes: "test" });
await client.accounts.delete(account.id);

for await (const account of await client.accounts.list()) {
  console.log(account.id, account.handle);
}
```

## Submissions and uploads

```ts
const submission = await client.submissions.create({
  account_id: account.id,
  video: "clip.mp4", // a local path, a Uint8Array, or a Blob
  caption: "hi",
});
// or video_url: "https://...", or upload_id from client.uploads.upload(...)

const finished = await client.submissions.wait(submission, { timeout: 900_000 });
await client.submissions.cancel(submission.id);
await client.submissions.delete(submission.id);
```

`submissions.create` takes exactly one of `video` (a local file, `Uint8Array`, or `Blob`, MP4/MOV),
`video_url`, or `upload_id`. `submissions.wait()` polls until a terminal status (`published`,
`drafted`, `failed`, `cancelled`).

`.list()` returns a `Page`; see [Pagination](#pagination) for walking every page.

Upload a video once and reuse the resulting id, for example to submit the same video to several
accounts:

```ts
const uploadId = await client.uploads.upload("clip.mp4");
const submission = await client.submissions.create({
  account_id: account.id,
  upload_id: uploadId,
  caption: "hi",
});
```

Over REST, a local `video` is sent as multipart form data directly. Over the socket, which can't
carry file bytes, the SDK uploads it through a signed URL first and sends the resulting
`upload_id` instead — no code change needed on your end.

## Billing

```ts
const summary = await client.billing.summary();
const rental = await client.billing.startRental({ accept_terms: true, phones: 5, country: "US" });
const change = await client.billing.requestPhoneCount({ accept_terms: true, add: 2 });
const request = await client.billing.getRequest(change.request_id);
```

`accept_terms: true` confirms the caller has shown the user the
[terms](https://0bull.net/terms) and [privacy policy](https://0bull.net/privacy), including that
the rental renews monthly, before the charge is made.

## The socket and events

`client.socket()` returns an unconnected `Socket` exposing the same resource methods as the REST
client (except `user` and `session`, which are REST-only), over a connection that reconnects
automatically:

```ts
import { TERMINAL_RUN_STATUSES, ZeroBull } from "0bull";

const client = new ZeroBull();
await using socket = client.socket(); // closed when the scope exits
await socket.connect();

const run = await socket.phones.runMacro(slot, { workflow: "post-to-story" });
for await (const event of socket.events()) {
  if (event.type === "run" && event.run.id === run.id && TERMINAL_RUN_STATUSES.has(event.run.status)) {
    break;
  }
}
```

`await using` needs TypeScript 5.2+ with `lib: "esnext"`, or Node 24+. In plain JavaScript on Node 22, call
`socket.close()` in a `finally` block instead.

`events()` yields a discriminated union on `type`: `{ type: "run", run }`,
`{ type: "submission", submission }`, `{ type: "billing_request", request }`.

On an unexpected disconnect, the socket reconnects with a fresh session URL and exponential
backoff, up to `maxReconnectAttempts`; calls in flight at the time of the disconnect throw
`SocketClosedError` rather than being resent.

### `socket.call()`

Use `socket.call(fun, data)` to invoke a WebSocket function the SDK doesn't model yet. It gets the
same error mapping as every other call:

```ts
const result = await socket.call("/app/some/new-fun", { foo: "bar" });
```

## Errors

All exceptions the SDK throws on purpose subclass `ZeroBullError`.

| Condition | Exception |
|---|---|
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 422 | `ValidationError` (with `.errors`) |
| 429 | `RateLimitError` (after retries, with `.retryAfter`) |
| 502, 503 | `UnavailableError` |
| ≥ 500 otherwise | `InternalServerError` |
| any other status | `APIStatusError` (base of all status errors) |
| network failure | `APIConnectionError` |
| request or call timeout | `APITimeoutError` |
| socket closed with calls in flight | `SocketClosedError` |
| `wait()` timeout | `WaitTimeoutError` |

```ts
import { APIStatusError, ValidationError } from "0bull";

try {
  await client.submissions.create({
    account_id: account.id,
    video_url: "https://example.com/missing.mp4",
    caption: "hi",
  });
} catch (error) {
  if (error instanceof ValidationError) {
    console.log(error.errors);
  } else if (error instanceof APIStatusError) {
    console.log(error.status, error.message);
  } else {
    throw error;
  }
}
```

Arguments the SDK can validate locally, such as a missing `google_email` on a YouTube account,
throw a plain `TypeError` before any request is sent; only a request that reaches the server can
raise `ValidationError` or another `APIStatusError`.

A REST `429` is retried automatically, honoring `Retry-After`, up to `maxRetries` before
`RateLimitError` is thrown. Nothing else is retried automatically.

## Pagination

`list()` methods return a `Page`. `for await` over a page walks it and every page after it:

```ts
for await (const account of await client.accounts.list()) {
  console.log(account.id, account.handle);
}
```

Or page manually with `nextPage()` (`null` on the last page):

```ts
let page = await client.accounts.list();
while (page) {
  for (const account of page.items) console.log(account.id);
  page = await page.nextPage();
}
```

`page.currentPage`, `page.lastPage`, `page.perPage`, and `page.total` describe the current page.

## Waiting

`runs.wait(run, { timeout, interval })` and `submissions.wait(submissionOrId, { timeout, interval })`
poll until the run or submission reaches a terminal status, throwing `WaitTimeoutError` once
`timeout` elapses. Defaults: runs 300000ms timeout / 2000ms interval; submissions 900000ms
timeout / 5000ms interval.

## Configuration

`ZeroBull`:

| Option | Default | Environment |
|---|---|---|
| `apiToken` | required | `ZEROBULL_API_TOKEN` |
| `baseURL` | `https://0bull.net/api` | `ZEROBULL_BASE_URL` |
| `timeout` | 30000ms | |
| `maxRetries` (REST `429`) | 2 | |
| `fetch` | global `fetch` | |

`client.socket()`:

| Option | Default |
|---|---|
| `callTimeout` | 60000ms |
| `autoReconnect` | `true` |
| `maxReconnectAttempts` | 5 |

## Versioning and support

This SDK follows [semantic versioning](https://semver.org/). Before `1.0.0`, minor versions may
include breaking changes. See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## Development

```bash
npm ci
npm run lint       # fix: npm run format
npm run typecheck
npm test
npm run build
```

## License

MIT
