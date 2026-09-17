import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WaitTimeoutError } from "../src/errors.js";
import { HttpTransport } from "../src/http.js";
import { Submissions } from "../src/resources/submissions.js";
import { fakeSocketTransport, mockApi } from "./helpers.js";

const submission = {
  id: 1,
  platform: "tiktok",
  account_id: "acc_1",
  caption: "hi",
  draft: false,
  status: "pending",
  attempts: 0,
  failure: null,
  started_at: null,
  finished_at: null,
  created_at: null,
  updated_at: null,
};

const upload = {
  upload_id: "up_1",
  upload_url: "https://api.test/signed",
  expires_at: "2026-01-01",
};
const meta = { current_page: 1, last_page: 1, per_page: 1, total: 1 };

function tempVideo(): string {
  const dir = mkdtempSync(join(tmpdir(), "0bull-"));
  const file = join(dir, "clip.mp4");
  writeFileSync(file, "clip");
  return file;
}

function socketSubmissions(reply: unknown) {
  const fake = fakeSocketTransport(reply);
  return {
    submissions: new Submissions(fake.transport, new HttpTransport({ apiToken: "t" })),
    ...fake,
  };
}

describe("submissions over REST", () => {
  it("lists, gets, cancels, and deletes", async () => {
    const api = mockApi();
    api.add("GET", "/v1/submissions", {
      json: { data: [submission], meta: { ...meta, path: "x" } },
    });
    api.add("GET", "/v1/submissions/1", { json: { data: submission } });
    api.add("POST", "/v1/submissions/1/cancel", { json: { data: submission } });
    api.add("DELETE", "/v1/submissions/1", { status: 204 });

    const page = await api.client.submissions.list({ platform: "tiktok" });
    expect(page.items).toEqual([submission]);
    expect(new URL(api.last().url).search).toBe("?platform=tiktok");
    expect(await api.client.submissions.get(1)).toEqual(submission);
    expect(await api.client.submissions.cancel(1)).toEqual(submission);
    await expect(api.client.submissions.delete(1)).resolves.toBeUndefined();
  });

  it("creates with a video_url as multipart with no file part", async () => {
    const api = mockApi();
    api.add("POST", "/v1/submissions", { status: 201, json: { data: submission } });
    await api.client.submissions.create({
      account_id: "acc_1",
      video_url: "https://x/video.mp4",
      caption: "hi",
    });
    const form = await api.last().formData();
    expect(form.get("account_id")).toBe("acc_1");
    expect(form.get("video_url")).toBe("https://x/video.mp4");
    expect(form.get("caption")).toBe("hi");
    expect(form.get("video")).toBeNull();
    expect(form.get("platform")).toBeNull();
    expect(form.get("upload_id")).toBeNull();
    expect(form.get("draft")).toBeNull();
  });

  it("creates with a local file path, sending its basename and mp4 content type", async () => {
    const api = mockApi();
    api.add("POST", "/v1/submissions", { status: 201, json: { data: submission } });
    const video = tempVideo();
    await api.client.submissions.create({ account_id: "acc_1", video, caption: "hi" });
    const form = await api.last().formData();
    const file = form.get("video") as File;
    expect(file.name).toBe("clip.mp4");
    expect(file.type).toBe("video/mp4");
    expect(await file.text()).toBe("clip");
    expect(form.get("video_url")).toBeNull();
  });

  it("creates with raw bytes as an octet-stream named video", async () => {
    const api = mockApi();
    api.add("POST", "/v1/submissions", { status: 201, json: { data: submission } });
    await api.client.submissions.create({
      account_id: "acc_1",
      video: new Uint8Array([1, 2, 3]),
      caption: "hi",
    });
    const file = (await api.last().formData()).get("video") as File;
    expect(file.name).toBe("video");
    expect(file.type).toBe("application/octet-stream");
  });

  it("creates with a Blob or File source", async () => {
    const api = mockApi();
    api.add("POST", "/v1/submissions", { status: 201, json: { data: submission } });
    const video = new File(["clip"], "my.mov", { type: "video/quicktime" });
    await api.client.submissions.create({ account_id: "acc_1", video, caption: "hi" });
    const file = (await api.last().formData()).get("video") as File;
    expect(file.name).toBe("my.mov");
    expect(file.type).toBe("video/quicktime");
  });

  it("validates exactly one of video/video_url/upload_id and caption rules before any request", async () => {
    const { client, requests } = mockApi();
    expect(() => client.submissions.create({ account_id: "a", caption: "hi" })).toThrow(
      "Exactly one",
    );
    expect(() =>
      client.submissions.create({
        account_id: "a",
        video_url: "https://x/v.mp4",
        upload_id: "up_1",
        caption: "hi",
      }),
    ).toThrow("Exactly one");
    expect(() =>
      client.submissions.create({
        account_id: "a",
        video_url: "https://x/v.mp4",
        caption: "a".repeat(2201),
      }),
    ).toThrow("2200");
    expect(() =>
      client.submissions.create({
        account_id: "a",
        video_url: "https://x/v.mp4",
        platform: "youtube",
      }),
    ).toThrow("required");
    expect(() =>
      client.submissions.create({
        account_id: "a",
        video_url: "https://x/v.mp4",
        platform: "youtube",
        caption: "a".repeat(101),
      }),
    ).toThrow("100");
    expect(requests).toHaveLength(0);
  });

  it("allows a valid youtube caption", async () => {
    const api = mockApi();
    api.add("POST", "/v1/submissions", { status: 201, json: { data: submission } });
    await expect(
      api.client.submissions.create({
        account_id: "a",
        video_url: "https://x/v.mp4",
        platform: "youtube",
        caption: "title",
      }),
    ).resolves.toEqual(submission);
  });

  it("waits for a terminal status", async () => {
    const api = mockApi();
    api.add("GET", "/v1/submissions/1", { json: { data: { ...submission, status: "pending" } } });
    api.add("GET", "/v1/submissions/1", { json: { data: { ...submission, status: "published" } } });
    const result = await api.client.submissions.wait(1, { interval: 0, timeout: 5000 });
    expect(result.status).toBe("published");
  });

  it("times out waiting", async () => {
    const api = mockApi();
    api.add("GET", "/v1/submissions/1", { json: { data: submission } });
    await expect(
      api.client.submissions.wait(submission, { interval: 1, timeout: 0 }),
    ).rejects.toThrow(WaitTimeoutError);
    await expect(
      api.client.submissions.wait(submission, { interval: 1, timeout: 0 }),
    ).rejects.toThrow("submission 1");
  });
});

describe("submissions over the socket", () => {
  it("maps every call to its fun, sending account instead of account_id", async () => {
    const { submissions, calls } = socketSubmissions(submission);
    await submissions.get(1);
    await submissions.create({ account_id: "acc_1", video_url: "https://x/v.mp4", caption: "hi" });
    await submissions.cancel(1);
    await submissions.delete(1);
    expect(calls).toEqual([
      { fun: "/app/submissions/get", data: { submission: 1 } },
      {
        fun: "/app/submissions/create",
        data: { account: "acc_1", video_url: "https://x/v.mp4", caption: "hi" },
      },
      { fun: "/app/submissions/cancel", data: { submission: 1 } },
      { fun: "/app/submissions/delete", data: { submission: 1 } },
    ]);
  });

  it("uploads a local video first, then creates with the returned upload_id", async () => {
    const api = mockApi();
    const merged = { ...submission, ...upload };
    const fake = fakeSocketTransport(merged);
    const submissions = new Submissions(fake.transport, api.http);
    api.add("POST", "/signed", { json: { ok: true } });

    const video = tempVideo();
    const result = await submissions.create({ account_id: "acc_1", video, caption: "hi" });

    expect(result.id).toBe(1);
    expect(fake.calls).toEqual([
      { fun: "/app/submissions/upload-url", data: {} },
      {
        fun: "/app/submissions/create",
        data: { account: "acc_1", upload_id: "up_1", caption: "hi" },
      },
    ]);
    expect(api.last().headers.get("authorization")).toBeNull();
  });

  it("raises before uploading when video is combined with another source", async () => {
    const fake = fakeSocketTransport(submission);
    const submissions = new Submissions(fake.transport, new HttpTransport({ apiToken: "t" }));
    expect(() =>
      submissions.create({
        account_id: "acc_1",
        video: new Uint8Array([1]),
        upload_id: "up_1",
        caption: "hi",
      }),
    ).toThrow("Exactly one");
    expect(fake.calls).toEqual([]);
  });

  it("parses socket pages", async () => {
    const { submissions, calls } = socketSubmissions({ data: [submission], meta });
    const page = await submissions.list({ platform: "tiktok" });
    expect(page.items).toEqual([submission]);
    expect(calls).toEqual([{ fun: "/app/submissions/list", data: { platform: "tiktok" } }]);
  });
});
