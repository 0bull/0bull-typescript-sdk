// MUTATES: queues a real macro run on the given phone. Needs ZEROBULL_API_TOKEN.
// Usage: npx tsx --env-file=.env examples/socket-events.ts <slot> <workflow>
import { TERMINAL_RUN_STATUSES, ZeroBull } from "../src/index.js";

const [slot, workflow] = process.argv.slice(2);
if (!slot || !workflow) {
  console.error("Usage: socket-events.ts <slot> <workflow>");
  process.exit(1);
}

const client = new ZeroBull();
await using socket = client.socket();
await socket.connect();

const run = await socket.phones.runMacro(slot, { workflow });
console.log(`started run ${run.id}`);

for await (const event of socket.events()) {
  if (
    event.type === "run" &&
    event.run.id === run.id &&
    TERMINAL_RUN_STATUSES.has(event.run.status)
  ) {
    console.log(`run ${event.run.id}: ${event.run.status}`);
    break;
  }
}
