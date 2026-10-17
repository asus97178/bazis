import { HttpClientError } from "./errors";
import type { RequestConfig } from "./types";

/**
 * Every option of {@link RequestConfig}, checked so a misspelled one is not
 * silently ignored. A record, not a list: a new option fails typecheck until
 * it is added here.
 */
const OPTIONS: Readonly<Record<keyof RequestConfig, true>> = {
  url: true, method: true, baseUrl: true, headers: true, params: true, paramsSerializer: true, data: true,
  transformRequest: true, transformResponse: true, onDownloadProgress: true, timeoutMs: true, maxResponseBytes: true,
  signal: true, responseType: true, withCredentials: true, credentials: true, auth: true,
  allowCrossOriginCredentials: true, validateStatus: true, retry: true, propagateCorrelation: true,
  correlationHeaders: true, fetch: true, inspectableRedirects: true, redirect: true, maxRedirects: true, cache: true,
  mode: true, keepalive: true, meta: true,
};
const KNOWN: ReadonlySet<string> = new Set(Object.keys(OPTIONS));

/** axios names with a different spelling here. */
const AXIOS_NAMES: Readonly<Record<string, keyof RequestConfig>> = {
  timeout: "timeoutMs",
  maxContentLength: "maxResponseBytes",
};

/**
 * Rejects an option the client does not know. Without it `baseURL` (the axios
 * spelling) was dropped, and every call failed with ERR_NETWORK
 * "fetch() URL is invalid".
 */
export function assertKnownOptions(config: object, where: string): void {
  for (const key of Object.keys(config)) {
    if (KNOWN.has(key)) continue;
    const suggestion = AXIOS_NAMES[key] ?? [...KNOWN].find((known) => known.toLowerCase() === key.toLowerCase());
    throw new HttpClientError(`Unknown HttpClient option "${key}" in ${where}${suggestion === undefined ? "" : `; did you mean "${suggestion}"?`}`);
  }
}
