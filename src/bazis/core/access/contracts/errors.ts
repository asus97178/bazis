/** A problem of declared permissions, references or roles; the application reports it as a configuration error. */
export class AccessSetupError extends Error {
  override readonly name = "AccessSetupError";
}

/**
 * A list filter that cannot be built: a lookup gave more values than
 * `access.maxInList` (ACCESS-001 §4.3). The request fails with 500.
 */
export class AccessFilterTooLargeError extends Error {
  override readonly name = "AccessFilterTooLargeError";
  readonly code = "access_filter_too_large";
}
