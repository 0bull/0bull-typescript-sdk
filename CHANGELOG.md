# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Sessions: `SessionPhone.id` is now `SessionPhone.slot`, matching `Phone.slot` and the socket. The
  API renamed the field.

### Removed

- Runs: the workaround that read `result: []` as `null`. The API always sends `null` now.

## [0.1.0] - 2026-09-17

### Added

- `ZeroBull`, an async REST client, and `Socket`, an async WebSocket client, with matching
  resource methods across both surfaces.
- User: `user.get()` for the authenticated user (REST only).
- Accounts: list, get, create, update, delete.
- Submissions: list, get, create (local file, `video_url`, or `upload_id`), cancel, delete, and
  `wait()`. Over the WebSocket, a local file is uploaded through a signed URL first.
- Uploads: signed upload URLs via `uploads.create()` and `uploads.upload()`.
- Phones: list, snapshot, OCR, tap, swipe, hotkey, type. `hotkey` accepts every documented key
  (`HOTKEYS`), including `enter`, `backspace`, `back`, `copy`, `cut`, `paste`, and `select_all`.
- Phone runs: commands, macros, agent runs; list, get, and `wait()`.
- Billing: summary, rentals, phone count requests, and billing request lookup.
- Phone-controller sessions and `client.socket()`, with concurrent calls and automatic reconnects.
- Typed events, discriminated on `type` (`"run"`, `"submission"`, `"billing_request"`), via
  `socket.events()`.
- `socket.call()` for WebSocket functions the SDK doesn't model yet.
- Pagination (`Page`) — `for await` walks every page.
- A typed exception hierarchy mapping every documented REST and WebSocket error, with automatic
  retries for REST rate limits (`429`) honoring `Retry-After`. Client-side argument validation
  throws `TypeError` before any request is sent.
- Configuration through arguments or `ZEROBULL_API_TOKEN` and `ZEROBULL_BASE_URL`.
- Runnable examples in `examples/`.
- Node ≥ 22, ESM only, zero runtime dependencies, written in strict TypeScript with bundled types.

[Unreleased]: https://github.com/0bull/0bull-typescript-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0bull/0bull-typescript-sdk/releases/tag/v0.1.0
