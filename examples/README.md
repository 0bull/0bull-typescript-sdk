# Examples

Runnable scripts demonstrating the SDK. Put `ZEROBULL_API_TOKEN` in a git-ignored `.env` file (or
export it), then run any script with:

```bash
npx tsx --env-file=.env examples/<file>.ts
```

- `quickstart.ts` — list phones and print the first one. Read-only.
- `socket-events.ts` — queue a macro run over the WebSocket and wait for it to finish via events.
  **Mutates**: queues a real run on a phone. Takes an optional workflow name as its argument
  (default `post-to-story`), or `ZEROBULL_WORKFLOW`.
- `upload-video.ts` — upload a local video file and print its upload id. **Mutates**: uploads a
  real file. Takes the video path as its argument.
