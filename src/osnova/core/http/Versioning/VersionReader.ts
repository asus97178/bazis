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
