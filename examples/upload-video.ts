// MUTATES: uploads a real video file. Needs ZEROBULL_API_TOKEN.
// Usage: npx tsx --env-file=.env examples/upload-video.ts <path-to-video>
import { ZeroBull } from "../src/index.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: npx tsx --env-file=.env examples/upload-video.ts <path-to-video>");
  process.exit(1);
}

const client = new ZeroBull();

const uploadId = await client.uploads.upload(path);
console.log(uploadId);
