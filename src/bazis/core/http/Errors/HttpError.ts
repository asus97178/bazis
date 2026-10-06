import type { ModelValidationIssue } from "../Binding/modelValidator";

/**
 * Base class for errors that map directly to an HTTP response.
 * The global error handler turns any thrown HttpError into
 * `{ error: message, details? }` with the given status code.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad Request", details?: unknown) {
    super(400, message, details);
  }
}

export class UnauthorizedError extends HttpError {
  readonly challenge = "Bearer";

  constructor(message = "Unauthorized", details?: unknown) {
    super(401, message, details);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden", details?: unknown) {
    super(403, message, details);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not Found", details?: unknown) {
    super(404, message, details);
  }
}

export class MethodNotAllowedError extends HttpError {
  constructor(readonly allow: readonly string[]) {
    super(405, "Method Not Allowed");
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor(expected: string) {
    super(415, `Unsupported Media Type: expected ${expected}`);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(maxBytes: number) {
    super(413, "Payload Too Large", { maxBytes });
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "Too Many Requests");
  }
}

/**
 * Request body failed model validation (generated DTO binding + `@Validator`
 * rules on the DTO). The error handler renders it as 400 with the full list
 * of validation problems.
 */
export class ModelValidationError extends BadRequestError {
  constructor(readonly errors: readonly ModelValidationIssue[], title = "Validation failed") {
    super(
      title,
      errors.map((error) => ({ property: error.property, message: error.message, code: error.code })),
    );
  }
}

/**
 * Misconfigured routes/controllers (duplicate route, bad template, missing
 * @Controller). Thrown at startup, never at request time — fail fast.
 */
export class HttpSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpSetupError";
  }
}
