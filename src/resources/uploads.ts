import { asObject, type FileSource } from "../core.js";
import type { UploadURL } from "../types.js";
import { Resource } from "./resource.js";

export class Uploads extends Resource {
  /** Mint a signed URL for uploading a video. Not enveloped on either transport. */
  create(): Promise<UploadURL> {
    return this.transport.execute({
      rest: { method: "POST", path: "/v1/uploads" },
      socket: { fun: "/app/submissions/upload-url" },
      parseRest: (response) => asObject<UploadURL>(response.json()),
      parseSocket: (data) => asObject<UploadURL>(data),
    });
  }

  /** Upload a local video through a freshly minted signed URL. */
  async upload(video: FileSource): Promise<string> {
    const url = await this.create();
    await this.http.upload(url.upload_url, video);
    return url.upload_id;
  }
}
