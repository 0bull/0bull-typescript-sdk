import {
  asObject,
  type FileSource,
  invalid,
  noContent,
  parsePage,
  pathSegment,
  unwrap,
  waitUntil,
} from "../core.js";
import { Page } from "../pagination.js";
import type { Platform, Submission } from "../types.js";
import { TERMINAL_SUBMISSION_STATUSES } from "../types.js";
import { Resource } from "./resource.js";
import { Uploads } from "./uploads.js";

export interface SubmissionListParams {
  page?: number;
  platform?: Platform;
}

export interface SubmissionCreateParams {
  account_id: string;
  /** Defaults to `tiktok` on the server. */
  platform?: Platform;
  /** A local video. Cannot be sent over the socket; uploaded through a signed URL first. */
  video?: FileSource;
  video_url?: string;
  upload_id?: string;
  /** Required for youtube (≤100 chars); optional otherwise (≤2200 chars). */
  caption?: string;
  draft?: boolean;
}

export interface SubmissionWaitParams {
  /** Default 900000 (15 minutes). */
  timeout?: number;
  /** Default 5000. */
  interval?: number;
}

function checkCaption(caption: string | undefined, platform: Platform | undefined): void {
  const isYoutube = (platform ?? "tiktok") === "youtube";
  const limit = isYoutube ? 100 : 2200;
  if (isYoutube && !caption) invalid("caption is required for youtube submissions");
  if (caption !== undefined && caption.length > limit) {
    invalid(`caption must be at most ${limit} characters`);
  }
}

const parseSubmission = {
  parseRest: (response: Parameters<typeof unwrap>[0]) => asObject<Submission>(unwrap(response)),
  parseSocket: (data: unknown) => asObject<Submission>(data),
};

export class Submissions extends Resource {
  /** List video submissions, newest first. */
  async list(params: SubmissionListParams = {}): Promise<Page<Submission>> {
    const data = { page: params.page, platform: params.platform };
    const page = await this.transport.execute({
      rest: { method: "GET", path: "/v1/submissions", query: data },
      socket: { fun: "/app/submissions/list", data },
      parseRest: (response) => parsePage<Submission>(response.json()),
      parseSocket: (body) => parsePage<Submission>(body),
    });
    return new Page(page, (next) => this.list({ ...params, page: next }));
  }

  /** Get one submission by id. */
  get(submissionId: number): Promise<Submission> {
    return this.transport.execute({
      rest: { method: "GET", path: `/v1/submissions/${pathSegment(submissionId)}` },
      socket: { fun: "/app/submissions/get", data: { submission: submissionId } },
      ...parseSubmission,
    });
  }

  /**
   * Create a submission from a local video, a URL, or a prior upload.
   *
   * A local video sent over the socket is uploaded through a signed URL first, since the
   * socket cannot carry file bytes.
   */
  create(params: SubmissionCreateParams): Promise<Submission> {
    const sources = [params.video, params.video_url, params.upload_id].filter(
      (source) => source !== undefined,
    );
    if (sources.length !== 1) {
      invalid("Exactly one of video, video_url, or upload_id is required");
    }
    checkCaption(params.caption, params.platform);

    if (params.video !== undefined && !this.transport.supportsRest) {
      return this.#createFromUpload(params, params.video);
    }
    return this.#send(params, params.video, params.upload_id);
  }

  /** Upload a local video first, since the socket cannot carry file bytes. */
  async #createFromUpload(params: SubmissionCreateParams, video: FileSource): Promise<Submission> {
    const uploadId = await new Uploads(this.transport, this.http).upload(video);
    return this.#send(params, undefined, uploadId);
  }

  #send(
    params: SubmissionCreateParams,
    video: FileSource | undefined,
    uploadId: string | undefined,
  ): Promise<Submission> {
    const fields = {
      platform: params.platform,
      account_id: params.account_id,
      video_url: params.video_url,
      upload_id: uploadId,
      caption: params.caption,
      draft: params.draft,
    };
    return this.transport.execute({
      rest: {
        method: "POST",
        path: "/v1/submissions",
        form: fields,
        file: video !== undefined ? { field: "video", source: video } : undefined,
      },
      socket: {
        fun: "/app/submissions/create",
        data: { ...fields, account_id: undefined, account: params.account_id },
      },
      ...parseSubmission,
    });
  }

  /** Cancel a queued or in-progress submission. */
  cancel(submissionId: number): Promise<Submission> {
    return this.transport.execute({
      rest: { method: "POST", path: `/v1/submissions/${pathSegment(submissionId)}/cancel` },
      socket: { fun: "/app/submissions/cancel", data: { submission: submissionId } },
      ...parseSubmission,
    });
  }

  /** Delete a submission and its stored video. */
  delete(submissionId: number): Promise<void> {
    return this.transport.execute({
      rest: { method: "DELETE", path: `/v1/submissions/${pathSegment(submissionId)}` },
      socket: { fun: "/app/submissions/delete", data: { submission: submissionId } },
      parseRest: noContent,
      parseSocket: noContent,
    });
  }

  /**
   * Poll a submission until it reaches a terminal status.
   *
   * @throws WaitTimeoutError If the timeout elapses first.
   */
  wait(
    submission: Submission | number,
    { timeout = 900_000, interval = 5_000 }: SubmissionWaitParams = {},
  ): Promise<Submission> {
    const submissionId = typeof submission === "number" ? submission : submission.id;
    return waitUntil(
      () => this.get(submissionId),
      (value) => TERMINAL_SUBMISSION_STATUSES.has(value.status),
      { interval, timeout, what: `submission ${submissionId}` },
    );
  }
}
