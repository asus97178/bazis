# HTTP client library

Passport version: 6. Check date: 2026-09-20.
Type: an atomic single-feature library; it has no DI module of its own.
Path: `src/osnv/library/http-client`. Public entry: [index.ts](index.ts).
Status and scope: the negotiated redirect mode, fixes HTTP-05/06/08/09 and the transport contracts HTTP-E01–E04. The full field list stays in [types.ts](types.ts); the named-client factory and interceptors are not re-described here.

## 1. Responsibility and structure

Addendum 2026-09-20: `maxResponseBytes` and `onDownloadProgress` keep 204/205/304
responses without creating a new Response with a body. A browser may expose an
empty ReadableStream even for such a status; wrapping it made the Response
constructor fail on a successful logout. Public parameters do not change.
Checks: `test/http-client.bodyless.test.ts`, a real logout of the Vue client.

`HttpClient` runs HTTP requests on top of Fetch and is responsible for the URL, redirects, retries, response limits and error representation. It owns the instance configuration and the request attempts. ORM, application authorization and DI registrations are outside the library. No atomic submodules are used: it implements one feature.

## 2. Components

| Component | Source | Input → result |
|---|---|---|
| Sending, redirects, retries, decoding | [HttpClient.ts](HttpClient.ts) | `RequestConfig` → `Promise<HttpResponse>` or an error |
| URL/query | [serialize.ts](serialize.ts) | URL and parameters → a string with the query before the fragment |
| Contracts | [types.ts](types.ts), [errors.ts](errors.ts) | Configuration, envelope and stable error codes |
| Checks | [test](test) | Synthetic fetch and local HTTP servers |

The components already existed; a regression test file was added. HTTP controllers, background handlers, UI, events and ORM data are not used.

## 3. Connection and DI

Call: `new HttpClient(defaults).request(config)` or the `get/post/...` methods.
The TypeScript exports stay in `index.ts`; `HttpErrorCode.BadResponse`, `HttpErrorCode.RedirectNotInspectable` and the shared wire contract `InspectableRedirectProtocol` were added. Its read-only fields `header`, `statusHeader`, `version` equal `x-osnv-redirect`, `x-osnv-redirect-status`, `manual-v1`; the constant takes no user arguments. DI `imports`, `exports`, providers and lifetime do not apply. The [core/http-client](../../core/http-client/index.ts) integration depends on the library; there is no reverse dependency.

## 4. Configuration and lifecycle

Retries are allowed only for supported idempotent methods with a replayable body. One deadline covers attempts and delays; signals are passed to Fetch. `responseType: "stream"` hands the stream to the consumer, who must read it to the end or cancel it. Producer cleanup runs when a response is discarded, but its never-settling Promise does not hold up a retry, a redirect or a size rejection. The library cannot stop arbitrary user code that ignores the passed AbortSignal.

Without the negotiated mode (`inspectableRedirects: false`) browser Fetch hides the Location of a manual redirect. A body-less request with safe headers may follow across origins: Fetch itself removes `Authorization` on such a hop. When starting from the page/worker origin, its cookies are kept through `credentials: "same-origin"`; cookies are not sent to a foreign origin. When starting from an external API, `credentials: "omit"` is used. An explicit `mode: "same-origin"` is kept.

Arbitrary API-key headers, a body and `credentials: "include"` require `mode: "same-origin"` for requests to the page/worker origin or an explicit `allowCrossOriginCredentials`. For an external API the first request works through CORS, but a hidden redirect with such data is blocked without permission. Restricted correlation headers still forbid an uncontrolled redirect even when credentials are allowed; the `all` policy allows sending them. Bun/Node keep the per-hop header cleanup.

Browser Fetch has a limit of 20 hops. Without negotiation, with a budget of 20–100 this stricter limit is used. With 0 a hop is forbidden; with 1–19 a regular response is accepted, but an opaque redirect is rejected before the hop, because its address and the further number of hops cannot be checked. The negotiated mode from §7 gives an exact limit. There are no probe requests followed by a resend.

## 5. Changed inputs and results

The consumer is application code. The application decides the right to call an external API and the secret values. The library checks transport limits but does not perform application authorization. An optional `inspectableRedirects` field was added.

| Field | Type / null | Default | Check and action |
|---|---|---|---|
| `url`, `baseUrl` | `string`, no null | URL from the request/settings | The query is added before `#fragment`; the browser supports a relative URL |
| `params` | `RequestParams`, null in values | absent | Arrays repeat the key; null/undefined are skipped |
| `paramsSerializer` | function, no null | the standard serializer | The ready query string is inserted before the fragment |
| `redirect` | `follow/manual/error`, no null | `follow` | Browser manual returns an opaque response with status 0 |
| `maxRedirects` | safe integer, no null | 20 | 0–100; Bun/Node and the negotiated browser mode count every hop. Native browser: 0 forbids a redirect, 1–19 rejects an opaque redirect before the hop, 20–100 uses the native cap of 20 |
| `inspectableRedirects` | boolean, no null | false | With true and `follow` negotiates visible redirects with the server; a non-boolean value is rejected before sending |
| `allowCrossOriginCredentials` | boolean, no null | false | Explicit permission to send secrets/a body across the origin boundary; CORS and browser Fetch rules still apply |
| `validateStatus` | function or null | 200–299 | Called once; null turns off only the status check |
| `responseType` | an enumeration in `types.ts`, no null | by Content-Type | Invalid JSON is rejected even with an accepted status |

All fields are optional and merge with the client settings; a network call needs a resolvable URL. A decoding error does not drop the HTTP context:

| Result | Meaning |
|---|---|
| `ERR_BAD_STATUS` | The status is rejected, including the case of corrupted JSON |
| `ERR_BAD_RESPONSE` | The status is accepted, but the JSON is corrupted |
| `error.status`, `.response` | Hold the status, headers, config, raw Response; with corrupted JSON `data` holds the already read text |
| `error.cause` | The original `SyntaxError` for corrupted JSON |
| `ERR_NETWORK` | Including a blocked browser redirect, CORS, reaching the native redirect cap |
| `ERR_REDIRECT_NOT_INSPECTABLE` | A manual redirect cannot be checked, or the negotiated mode confirmation is missing/invalid; no automatic retry |
| `ERR_TOO_MANY_REDIRECTS` | The limit available for exact counting is exceeded; the next request is not sent |
| `HttpClientError` without a code | An invalid `maxRedirects` (non-integer or outside 0–100), before the network call |

Errors of user progress/transform callbacks are not renamed into JSON errors. The raw error text may contain server data: the logging policy stays with the application.

## 6. Checks and readiness

Current fixes and requalification without the client application:
[HTTP-E01–E05](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-http-enterprise-fixes/REPORT.md).
The history of earlier checks is kept below; its counters do not apply to the current snapshot.

Qualification addendum: [Admin UI integration, browsers, Node and load](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-http-qualification/REPORT.md).
The cancellation reason is also determined by the actual AbortSignal: WebKit may
reject Fetch/body reading with a TypeError when a timeout expires. That is still
`ETIMEDOUT`; an explicit cancellation by the caller takes priority as `ERR_CANCELED`.
A progress callback error cancels the producer and releases the reader without
waiting for the user cancel hook. The progress buffer type is compatible with the TypeScript DOM lib.
The current application uses the library directly in the Vue AdminApiService;
Vue does not become a dependency of the library. The historical Angular interceptor
was removed by a parallel UI migration. The results below refer to the earlier snapshot.

Current results: [negotiated mode and checks](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-http-redirects/REPORT.md): 274 Bun tests, 28 negotiated and 22 regular Chromium scenarios, TypeScript PASS. History: [original fixes](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-13-http/REMEDIATION.md), [compatibility check](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-13-http/COMPATIBILITY.md). Methods/bodies, cookies, Authorization, no leaks, Worker, limits, malformed metadata and HTTP errors are checked. A full check of Node and other browsers is outside this work.

The normative basis of the browser limitation: [Fetch: opaque redirect](https://fetch.spec.whatwg.org/#concept-filtered-response-opaque-redirect), [HTTP redirect fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch). There are no architectural exceptions or DI API changes.

## 7. Negotiated redirects

The new option `inspectableRedirects?: boolean` comes from the defaults/request config, default false; null and non-boolean values are forbidden before the network call. With `redirect: "follow"`, true turns on a step-by-step protocol with the option of the same name in our HTTP server. With `manual/error` the chosen standard mode is kept and no negotiation is sent.

Each attempt and each hop sends `X-osnv-Redirect: manual-v1` through Fetch with `redirect: "manual"`, `cache: "no-store"`. A successful response must confirm `X-osnv-Redirect: manual-v1`. A redirect is represented by HTTP 200 with the `X-osnv-Redirect-Status: 301|302|303|307|308` and Location headers; a regular response has no status header. HEAD uses the same headers without a body. Redirect metadata is handled before user decoding: the client checks the address and the limit before the next request. There is no new JSON envelope; secrets and Set-Cookie are not copied into the body.

In this mode the exact `maxRedirects` 0–100 applies in the browser with the same code as in Bun/Node. On an origin change the existing rules for removing secrets, correlation and forbidding body transfer apply. Browser CORS and `mode` are kept. There is no probe request, no resend to detect a redirect, no background proxy and no server-side access to arbitrary URLs.

A missing confirmation, invalid metadata or an opaque redirect → `ERR_REDIRECT_NOT_INSPECTABLE`, without an automatic retry. An HTTP error 400–599 without an encoded redirect status is kept even without confirmation: it cannot hide a negotiated redirect with wire status 200. This keeps, for example, an HTTP 500 from a native file-open error after the pipeline. Exceeding the limit available for counting → the existing `ERR_TOO_MANY_REDIRECTS`. The mode needs support from the HTTP recipients in the chain; it is not enabled for a regular external API. In native mode an opaque redirect that the client cannot check also gets the separate `ERR_REDIRECT_NOT_INSPECTABLE` code.

Example: `new HttpClient({ inspectableRedirects: true, maxRedirects: 2 })` together with `httpModule({ inspectableRedirects: true })` on the server. Real Chromium checked the limits 0/1/2/19/20/100, HEAD, POST 301/302/303/307/308, CORS/secrets, timeout, Worker and a non-supporting server. A strict server `cors.allowedHeaders` must allow `X-osnv-Redirect`; responses keep the existing CORS origins/credentials. Redirects without Location are not negotiated hops; the browser may hide such an invalid redirect behind an opaque response.

## 8. Body reading and the original Response

`RequestConfig.data` still accepts `BodyInit`. For a `ReadableStream` the client
passes `duplex: "half"` to Fetch, which Node requires; the body is not buffered.
The stream stays single-use: retries are disabled with it, and 307/308 cannot replay it.
The streaming upload limits of the chosen browser/Fetch still apply.

A break during buffered reading (`text`, JSON, `arrayBuffer`, `blob`, progress)
returns `HttpClientError` with `ERR_NETWORK` and the original error in `cause`.
An actual cancellation/timeout keeps `ERR_CANCELED`/`ETIMEDOUT`.
The conversion wraps only the body reading, so an exception of a progress/transform
callback is kept even when it is named `TimeoutError`.
After a partial read the request is not retried automatically.

`maxResponseBytes` limits the bytes available after Fetch decoding, including
decompression. `Content-Length` is checked up front only without
`Content-Encoding` or with `identity`; the compressed size is not compared with
the decompressed one. Checking every read chunk keeps the protection against a
body growing too much after decompression.
With CORS a missing visible `Content-Encoding` does not prove `identity`:
the header may be hidden while `Content-Length` is visible. In that case the
client uses the actual stream size and does not reject a small gzip up front.
The limiter keeps its own rejection reason: if the browser's
`Response.text/arrayBuffer/blob` replaces the stream error with a `TypeError`, the
client result still holds `ERR_RESPONSE_TOO_LARGE`.

`HttpResponse.raw` always points to the original Fetch Response, including with
progress, a size limit, an HTTP error and corrupted JSON. URL/type and other
metadata are not lost; the body is not cloned and not read twice.
`raw.body` may already be read or locked by the limiter's reader.
With `responseType: "stream"` the consumer reads/cancels `data` and the limit is kept;
errors of further reading of this stream come through its API.
