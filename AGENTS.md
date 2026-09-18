# 0bull TypeScript SDK

TypeScript client for the 0bull API, published to npm as `@0bull/sdk`.

- Product: https://0bull.net
- API docs (the contract): https://docs.0bull.net
- Sibling SDK with the same surface: `0bull` on PyPI

When the API docs are unclear or contradict observed API behavior, stop and ask.

## Stack and commands

Node ≥ 22, ESM only, **zero runtime dependencies** (global `fetch`, `FormData`, `Blob`, `WebSocket`).
Dev: TypeScript (strict), Vitest with v8 coverage (≥ 90% enforced), Biome, `ws` (test socket server only), `tsx`.

```
Install:    npm ci
Test:       npm test
Lint:       npm run lint        (fix: npm run format)
Typecheck:  npm run typecheck
Build:      npm run build
```

## Design

- Every API call is one `Operation<T>` (`src/core.ts`): the REST request, the WebSocket `fun` and
  `data`, and a parser for each. Resource classes in `src/resources/` build operations and run them
  on `this.transport`, which is the `HttpTransport` for `ZeroBull` or the socket transport for
  `Socket`. The same resource class backs both, so the two surfaces stay identical.
- REST-only calls (`user`, `session`) leave `socket` unset; the socket transport rejects them.
- Method names are camelCase (`runMacro`). Fields sent to or returned by the API keep the API's
  snake_case names (`account_id`, `video_url`), so types mirror the API docs with no mapping.
- Response types in `src/types.ts` are plain interfaces. Enum-like response fields are `string`;
  documented values are exported unions used for inputs.
- `undefined` means "not given" and is dropped from queries and payloads. `null` is dropped too,
  unless the operation sets `keepNulls` (e.g. clearing a field on update).
- Client-side validation only where the API documents a hard constraint (enums, ranges, mutually
  exclusive fields). It throws `TypeError` through `invalid()` / `requireRange()` before any request.
- Every API failure throws a `ZeroBullError` subclass (`src/errors.ts`); REST and socket share
  `errorFromStatus`. Only REST `429` is retried.
- Durations are milliseconds.

## Tests

- REST: `mockApi()` in `test/helpers.ts` (injected `fetch`; asserts on recorded `Request`s).
- Socket side of a resource: `fakeSocketTransport()` records `{ fun, data }` as sent.
- Socket transport: a local `ws` server.
- Live checks against production use `ZEROBULL_API_TOKEN` from the git-ignored `.env`
  (`npx tsx --env-file=.env script.ts`). Keep them read-only unless the user says otherwise:
  real phones and real billing sit behind that token. Never commit tokens or live test scripts.

## Rules

- Simplest thing that works; no new runtime dependencies.
- Comments explain why, never what. No dead code, debug output, or speculative abstractions.
- Never weaken a check to get green: no skipped tests, removed assertions, or new suppressions
  without a stated reason.
- Specs and plans (`SPEC.md`, `tasks/`) are local working files and are git-ignored.
- Conventional Commits: `<type>(<scope>): <description>`, lowercase imperative, ≤ 72 chars.

## Releasing

The package publishes through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/):
`.github/workflows/release.yml` gets a short-lived OIDC credential from GitHub on each run, so no
npm token exists anywhere. Never add one: a granular token expires every 90 days and, until it
does, can publish this package from anywhere.

A trusted publisher can only be configured on a package that already exists, so `0.1.0` is
published by hand, once:

1. `npm login`, then `npm publish` (enter the 2FA code). `prepublishOnly` builds `dist/`.
2. On npmjs.com → the package → Settings → Trusted publishers, add this repository, workflow
   `release.yml`, environment `npm`.

Every later release:

1. Bump `version` in `package.json` and add the version's section to `CHANGELOG.md`.
2. Land that on `main` with lint, typecheck, and tests green.
3. Publish a GitHub release tagged `v<version>`. The workflow checks the tag against
   `package.json`, runs the suite, and publishes with provenance.

Provenance needs the repository and the package to be public.
