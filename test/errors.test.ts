import { describe, expect, it } from "vitest";
import {
  APIStatusError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  errorFromStatus,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnavailableError,
  ValidationError,
} from "../src/errors.js";

describe("errorFromStatus", () => {
  it.each([
    [400, BadRequestError],
    [401, AuthenticationError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, ValidationError],
    [429, RateLimitError],
    [502, UnavailableError],
    [503, UnavailableError],
    [500, InternalServerError],
    [504, InternalServerError],
    [418, APIStatusError],
  ])("maps %i", (status, ErrorClass) => {
    const error = errorFromStatus(status, undefined);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.status).toBe(status);
    expect(error.message).toBeTruthy();
  });

  it("keeps message and string field errors", () => {
    const error = errorFromStatus(422, {
      message: "Bad handle",
      errors: { handle: ["taken"], junk: [1] },
    });
    expect(error.message).toBe("Bad handle");
    expect(error.errors).toEqual({ handle: ["taken"] });
  });

  it("falls back to the default for an empty message and uses a text body", () => {
    expect(errorFromStatus(404, { message: " " }).message).toBe("Not found");
    expect(errorFromStatus(500, "boom").message).toBe("boom");
    expect(errorFromStatus(418, null).message).toBe("HTTP 418");
  });

  it("carries retryAfter on rate limits", () => {
    expect((errorFromStatus(429, {}, 3) as RateLimitError).retryAfter).toBe(3);
  });
});
