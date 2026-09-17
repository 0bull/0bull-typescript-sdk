export type FieldErrors = Record<string, string[]>;

/** Base class for every error the SDK throws on purpose. */
export class ZeroBullError extends Error {
  override name = "ZeroBullError";
}

/** An API reply with a non-2xx status. */
export class APIStatusError extends ZeroBullError {
  override name = "APIStatusError";
  constructor(
    message: string,
    readonly status: number,
    readonly errors: FieldErrors = {},
    readonly body: unknown = undefined,
  ) {
    super(message);
  }
}

export class BadRequestError extends APIStatusError {
  override name = "BadRequestError";
}
export class AuthenticationError extends APIStatusError {
  override name = "AuthenticationError";
}
export class PermissionDeniedError extends APIStatusError {
  override name = "PermissionDeniedError";
}
export class NotFoundError extends APIStatusError {
  override name = "NotFoundError";
}
export class ConflictError extends APIStatusError {
  override name = "ConflictError";
}
export class ValidationError extends APIStatusError {
  override name = "ValidationError";
}
export class UnavailableError extends APIStatusError {
  override name = "UnavailableError";
}
export class InternalServerError extends APIStatusError {
  override name = "InternalServerError";
}

/** Rate limit still exceeded after retries. `retryAfter` is in seconds. */
export class RateLimitError extends APIStatusError {
  override name = "RateLimitError";
  constructor(
    message: string,
    status: number,
    errors: FieldErrors,
    body: unknown,
    readonly retryAfter: number | undefined,
  ) {
    super(message, status, errors, body);
  }
}

export class APIConnectionError extends ZeroBullError {
  override name = "APIConnectionError";
}
export class APITimeoutError extends APIConnectionError {
  override name = "APITimeoutError";
}
export class SocketClosedError extends ZeroBullError {
  override name = "SocketClosedError";
}
export class WaitTimeoutError extends ZeroBullError {
  override name = "WaitTimeoutError";
}

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "Bad request",
  401: "Unauthenticated",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  422: "Validation failed",
  429: "Too many requests",
  500: "Server error",
  502: "Service unavailable",
  503: "Service unavailable",
};

const STATUS_ERRORS: Record<number, typeof APIStatusError> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: ValidationError,
  502: UnavailableError,
  503: UnavailableError,
};

/** Map a REST or socket error reply to the shared error hierarchy. */
export function errorFromStatus(
  status: number,
  body: unknown,
  retryAfter?: number,
): APIStatusError {
  let message = DEFAULT_MESSAGES[status] ?? `HTTP ${status}`;
  const errors: FieldErrors = {};
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const raw = body as Record<string, unknown>;
    if (typeof raw.message === "string" && raw.message.trim()) message = raw.message;
    if (raw.errors !== null && typeof raw.errors === "object" && !Array.isArray(raw.errors)) {
      for (const [key, value] of Object.entries(raw.errors)) {
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
          errors[key] = value;
        }
      }
    }
  } else if (typeof body === "string" && body.trim()) {
    message = body;
  }
  if (status === 429) return new RateLimitError(message, status, errors, body, retryAfter);
  const ErrorClass =
    STATUS_ERRORS[status] ?? (status >= 500 ? InternalServerError : APIStatusError);
  return new ErrorClass(message, status, errors, body);
}
