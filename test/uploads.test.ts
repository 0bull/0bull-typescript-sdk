import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpTransport } from "../src/http.js";
import { Uploads } from "../src/resources/uploads.js";
import { fakeSocketTransport, mockApi } from "./helpers.js";

const upload = {
  upload_id: "up_1",
  upload_url: "https://api.test/signed",
  expires_at: "2026-01-01",
};

function tempVideo(): string {
  const dir = mkdtempSync(join(tmpdir(), "0bull-"));
  const file = join(dir, "clip.mp4");
  writeFileSync(file, "clip");
  return file;
}

describe("uploads over REST", () => {
  it("mints a signed URL, not enveloped", async () => {
    const api = mockApi();
    api.add("POST", "/v1/uploads", { status: 201, json: upload });
    expect(await api.client.uploads.create()).toEqual(upload);
  });

  it("uploads bytes through the minted URL without the API token", async () => {
    const api = mockApi();
    api.add("POST", "/v1/uploads", { status: 201, json: upload });
    api.add("POST", "/signed", { json: { ok: true } });
    const uploadId = await api.client.uploads.upload(new Uint8Array([1, 2, 3]));
    expect(uploadId).toBe("up_1");
    expect(api.requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/uploads", "/signed"]);
    expect(api.last().headers.get("authorization")).toBeNull();
    const file = (await api.last().formData()).get("video") as File;
    expect(file.name).toBe("video");
    expect(file.type).toBe("application/octet-stream");
  });

  it("uploads a local file path with its basename and mp4 content type", async () => {
    const api = mockApi();
    api.add("POST", "/v1/uploads", { status: 201, json: upload });
    api.add("POST", "/signed", { json: { ok: true } });
    const video = tempVideo();
    expect(await api.client.uploads.upload(video)).toBe("up_1");
    const file = (await api.last().formData()).get("video") as File;
    expect(file.name).toBe("clip.mp4");
    expect(file.type).toBe("video/mp4");
  });

  it("uploads a Blob source", async () => {
    const api = mockApi();
    api.add("POST", "/v1/uploads", { status: 201, json: upload });
    api.add("POST", "/signed", { json: { ok: true } });
    const video = new Blob(["clip"], { type: "video/quicktime" });
    expect(await api.client.uploads.upload(video)).toBe("up_1");
    const file = (await api.last().formData()).get("video") as File;
    expect(file.name).toBe("video");
    expect(file.type).toBe("video/quicktime");
  });
});

describe("uploads over the socket", () => {
  it("maps create to its fun", async () => {
    const fake = fakeSocketTransport(upload);
    const uploads = new Uploads(fake.transport, new HttpTransport({ apiToken: "t" }));
    const result = await uploads.create();
    expect(result).toEqual(upload);
    expect(fake.calls).toEqual([{ fun: "/app/submissions/upload-url", data: {} }]);
  });

  it("mints the URL over the socket, then uploads over real HTTP", async () => {
    const api = mockApi();
    api.add("POST", "/signed", { json: { ok: true } });
    const fake = fakeSocketTransport(upload);
    const uploads = new Uploads(fake.transport, api.http);
    const uploadId = await uploads.upload(new Uint8Array([1]));
    expect(uploadId).toBe("up_1");
    expect(fake.calls).toEqual([{ fun: "/app/submissions/upload-url", data: {} }]);
    expect(api.requests).toHaveLength(1);
    expect(api.last().headers.get("authorization")).toBeNull();
  });
});
