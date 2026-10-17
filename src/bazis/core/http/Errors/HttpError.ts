import { KernelError } from "../../kernel";
import type { ModelValidationIssue } from "../Binding/modelValidator";
import { englishHttpMessage, type HttpMessageKey, type LocalizedMessage, type MessageParams } from "./messages";

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
    /**
     * Key and parameters of the message: the error handler renders it in the
     * application language (`runApp({ language, messages })`); `message` is the
     * English text. Errors created with their own text have no key.
     */
    readonly localized?: LocalizedMessage,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Own text as is, or the framework text by key (translated at the response). */
function textOf(message: string | undefined, key: HttpMessageKey, params?: MessageParams): readonly [string, LocalizedMessage | undefined] {
  return message !== undefined ? [message, undefined] : [englishHttpMessage(key, params), params === undefined ? { key } : { key, params }];
}

export class BadRequestError extends HttpError {
  constructor(message?: string, details?: unknown) {
    const [text, localized] = textOf(message, "badRequest");
    super(400, text, details, localized);
  }
}

export class UnauthorizedError extends HttpError {
  readonly challenge = "Bearer";

  constructor(message?: string, details?: unknown) {
    const [text, localized] = textOf(message, "unauthorized");
    super(401, text, details, localized);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message?: string, details?: unknown) {
    const [text, localized] = textOf(message, "forbidden");
    super(403, text, details, localized);
  }
}

export class NotFoundError extends HttpError {
  constructor(message?: string, details?: unknown) {
    const [text, localized] = textOf(message, "notFound");
    super(404, text, details, localized);
  }
}

export class MethodNotAllowedError extends HttpError {
  constructor(readonly allow: readonly string[]) {
    super(405, englishHttpMessage("methodNotAllowed"), undefined, { key: "methodNotAllowed" });
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor(expected: string) {
    super(415, englishHttpMessage("unsupportedMediaType", { expected }), undefined, { key: "unsupportedMediaType", params: { expected } });
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(maxBytes: number) {
    super(413, englishHttpMessage("payloadTooLarge"), { maxBytes }, { key: "payloadTooLarge" });
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(
    readonly retryAfterSeconds: number,
    /** Extra response headers, for example `RateLimit-*` from {@link rateLimit}. */
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(429, englishHttpMessage("tooManyRequests"), undefined, { key: "tooManyRequests" });
  }
}

/**
 * Request body failed model validation (generated DTO binding + `@Validator`
 * rules on the DTO). The error handler renders it as 400 with the full list
 * of validation problems, each in the application language.
 */
export class ModelValidationError extends BadRequestError {
  constructor(readonly errors: readonly ModelValidationIssue[], title = "Validation failed") {
    super(
      title,
      errors.map((error) => ({ property: error.property, message: error.message, code: error.code })),
    );
  }

  override readonly localized: LocalizedMessage = { key: "validationFailed" };
}

/** A 400 the framework writes itself: English text plus the key to translate it. */
export function frameworkBadRequest(key: HttpMessageKey, params?: MessageParams, details?: unknown): BadRequestError {
  return Object.assign(new BadRequestError(englishHttpMessage(key, params), details), {
    localized: params === undefined ? { key } : { key, params },
  }) as BadRequestError;
}

/**
 * Misconfigured routes/controllers (duplicate route, bad template, missing
 * @Controller). Thrown at startup, never at request time — fail fast. A
 * KernelError: the start reports it as a configuration error of the code.
 */
export class HttpSetupError extends KernelError {}
