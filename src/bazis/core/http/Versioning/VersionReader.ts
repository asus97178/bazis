import { HttpSetupError } from "../Errors/HttpError";
import type { ApiVersioningOptions } from "../options";

/**
 * Resolves the API version requested by the client. For the `"url"` source
 * versions are static path segments (no per-request work, returns undefined);
 * `"query"`/`"header"` read the configured parameter.
 */
export type VersionReader = (request: Request, url: URL) => string | undefined;

export function createVersionReader(options: ApiVersioningOptions | undefined): VersionReader {
  if (!options || options.source === "url") {
    return () => undefined;
  }
  if (options.source === "query") {
    const name = options.parameterName ?? "api-version";
    return (_request, url) => url.searchParams.get(name) ?? options.defaultVersion;
  }
  const header = options.headerName ?? "x-api-version";
  return (request) => request.headers.get(header) ?? options.defaultVersion;
}

const SOURCES = ["url", "query", "header"] as const;

/**
 * Rejects versioning options that would be silently ignored: an unknown
 * source, or a setting that belongs to another source.
 */
export function assertVersioningOptions(options: ApiVersioningOptions | undefined): void {
  if (options === undefined) return;
  const { source } = options;
  if (!SOURCES.includes(source)) {
    throw new HttpSetupError(`versioning.source must be "url", "query" or "header", got ${JSON.stringify(source)}.`);
  }
  if (source === "url" && options.defaultVersion !== undefined) {
    throw new HttpSetupError(
      'versioning.defaultVersion has no effect with source "url": the version is part of the path (/v1/...). '
        + 'Remove it, or use source "query" or "header".',
    );
  }
  if (source !== "query" && options.parameterName !== undefined) {
    throw new HttpSetupError(
      `versioning.parameterName has no effect with source "${source}": it names the query parameter of source "query".`
        + (source === "header" ? " Use headerName for the header." : ""),
    );
  }
  if (source !== "header" && options.headerName !== undefined) {
    throw new HttpSetupError(
      `versioning.headerName has no effect with source "${source}": it names the header of source "header".`
        + (source === "query" ? " Use parameterName for the query parameter." : ""),
    );
  }
}
