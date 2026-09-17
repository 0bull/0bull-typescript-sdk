// List phones and print the first one. Read-only. Needs ZEROBULL_API_TOKEN.
// Usage: npx tsx --env-file=.env examples/quickstart.ts
import { ZeroBull } from "../src/index.js";

const client = new ZeroBull();

const phones = await client.phones.list();
const phone = phones[0];
if (!phone) {
  console.log("No phones available");
} else {
  console.log(`${phone.slot}: ${phone.name}`);
}
