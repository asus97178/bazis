import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Tool, ToolError, type AgentToolExecutionContext } from "../../agent";
import type { ConfigView } from "../../kernel";
import type { ToolsSettings } from "../contracts/Tools.config";
import { hostAllowed, isPublicAddress } from "./publicAddress";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const MAX_REDIRECTS = 5;
/** What a redirect to another host must not carry. */
const CREDENTIALS = new Set(["authorization", "cookie", "proxy-authorization"]);

const secretText = { type: "string", description: "Usually $secrets.NAME" };

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    method: { enum: [...METHODS] },
    url: { type: "string", format: "uri" },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: { description: "Sent as JSON" },
    auth: {
      type: "object",
      description: "none; bearer with token; basic with username and password; apiKey with header and value",
      properties: {
        type: { enum: ["none", "bearer", "basic", "apiKey"] },
        token: secretText,
        username: { type: "string" },
        password: secretText,
        header: { type: "string" },
        value: secretText,
      },
      required: ["type"],
    },
    successCodes: { type: "array", items: { type: "integer", minimum: 100, maximum: 599 } },
    timeoutMs: { type: "integer", minimum: 1 },
  },
  required: ["url"],
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "integer" },
    headers: { type: "object" },
    body: { description: "JSON, or text when the response is not JSON" },
    dryRun: { type: "boolean" },
  },
};

interface Request {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly successCodes: ReadonlySet<number> | undefined;
  readonly timeoutMs: number;
  /** The header `auth` of type `apiKey` puts the key in: a redirect to another host drops it. */
  readonly apiKeyHeader: string | undefined;
}

/**
 * A request to the outside (WORKFLOW-002 §7.1), closed by default: an empty
 * `tools.http.allow` lets nothing through. A host must be listed, and every address
 * it resolves to must be public, on each redirect too; `http` goes to the address
 * that was checked, `https` is held to its certificate. A status outside the success
 * codes is an error with the reason `http_<status>`; 5xx and 429 are plain failures,
 * so `retry` of the step repeats them. A trial makes only `GET` and `HEAD`.
 */
@Tool({
  name: "http.request",
  description: "Makes an HTTP request to an allowed host.",
  sideEffect: "external",
  dryRun: "supported",
  callers: ["workflow", "agent"],
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
})
export class HttpRequestTool {
  constructor(private readonly config: ConfigView<ToolsSettings>) {}

  async execute(raw: unknown, context: AgentToolExecutionContext): Promise<unknown> {
    const callers = this.config.get("http.callers").split(",").map((item) => item.trim());
    if (context.caller !== undefined && !callers.includes(context.caller)) throw new ToolError(`tools.http.callers does not list ${context.caller}`, { reason: "caller_not_allowed" });
    const request = this.requestOf(raw);
    if (context.dryRun === true && !SAFE_METHODS.has(request.method)) return { dryRun: true };
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(request.timeoutMs)]);
    const response = await this.follow(request, signal);
    const body = await this.bodyOf(response, request.method, signal);
    const allowed = request.successCodes === undefined ? response.ok : request.successCodes.has(response.status);
    if (!allowed) {
      const message = `${request.method} ${request.url.host} answered ${response.status}`;
      if (response.status >= 500 || response.status === 429) throw new Error(message);
      throw new ToolError(message, { reason: `http_${response.status}` });
    }
    const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== "set-cookie"));
    return { status: response.status, headers, body, ...(context.dryRun === true ? { dryRun: true } : {}) };
  }

  private requestOf(raw: unknown): Request {
    const input = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const method = String(input.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) throw invalid(`method must be one of ${[...METHODS].join(", ")}`);
    if (typeof input.url !== "string") throw invalid("url is required");
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw invalid("url is not a URL");
    }
    const headers: Record<string, string> = {};
    if (input.headers !== undefined && input.headers !== null) {
      if (typeof input.headers !== "object" || Array.isArray(input.headers)) throw invalid("headers must be an object");
      for (const [name, value] of Object.entries(input.headers)) {
        if (typeof value !== "string") throw invalid(`header ${name} must be a string`);
        headers[name.toLowerCase()] = value;
      }
    }
    Object.assign(headers, authHeaders(input.auth));
    let body: string | undefined;
    if (input.body !== undefined && input.body !== null) {
      if (SAFE_METHODS.has(method)) throw invalid(`${method} has no body`);
      body = JSON.stringify(input.body);
      headers["content-type"] ??= "application/json";
    }
    let successCodes: Set<number> | undefined;
    if (input.successCodes !== undefined && input.successCodes !== null) {
      if (!Array.isArray(input.successCodes) || input.successCodes.length === 0 || !input.successCodes.every((code) => Number.isInteger(code) && code >= 100 && code <= 599)) throw invalid("successCodes must be a list of status codes");
      successCodes = new Set(input.successCodes as number[]);
    }
    const limit = this.config.get("http.timeoutMs");
    const asked = input.timeoutMs ?? limit;
    if (!Number.isSafeInteger(asked) || (asked as number) < 1) throw invalid("timeoutMs must be a positive integer");
    const apiKeyHeader = (input.auth as { type?: unknown; header?: unknown } | null | undefined)?.type === "apiKey" ? String((input.auth as { header: unknown }).header).toLowerCase() : undefined;
    return { method, url, headers, body, successCodes, timeoutMs: Math.min(asked as number, limit), apiKeyHeader };
  }

  /** The request and its redirects, each hop checked as the first one. */
  private async follow(first: Request, signal: AbortSignal): Promise<Response> {
    let { method, url, body } = first;
    let headers: Record<string, string> = { ...first.headers };
    const origin = first.url.host;
    const apiKeyHeader = first.apiKeyHeader;
    for (let hop = 0; ; hop += 1) {
      const target = await this.checked(url);
      const response = await fetch(target, {
        method,
        headers: target.href === url.href ? headers : { ...headers, host: url.host },
        redirect: "manual",
        signal,
        ...(body === undefined ? {} : { body }),
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (location === null) return response;
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new ToolError(`More than ${MAX_REDIRECTS} redirects`, { reason: "too_many_redirects" });
      url = new URL(location, url);
      if (url.host !== origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIALS.has(name) && name !== apiKeyHeader));
      // 301, 302 and 303 turn a write into a read, as browsers do.
      if (response.status !== 307 && response.status !== 308 && !SAFE_METHODS.has(method)) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
      }
    }
  }

  /** The URL to connect to, once the host is allowed and its addresses are public. Refused otherwise. */
  private async checked(url: URL): Promise<URL> {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("only http and https are supported");
    if (url.username !== "" || url.password !== "") throw invalid("credentials go to auth, not to the url");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
    if (!hostAllowed(this.config.get("http.allow"), hostname, port)) throw new ToolError(`tools.http.allow does not list ${url.host}`, { reason: "host_not_allowed" });
    if (this.config.get("http.allowPrivateNetworks")) return url;
    const addresses = isIP(hostname) !== 0 ? [hostname] : (await lookup(hostname, { all: true })).map((item) => item.address);
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new ToolError(`${url.host} is not a public address`, { reason: "address_not_allowed" });
    if (url.protocol === "https:" || isIP(hostname) !== 0) return url;
    // Past this check the name could resolve elsewhere: plain http goes to the address that passed it.
    const pinned = new URL(url);
    const address = addresses[0]!;
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
    return pinned;
  }

  /** The body within `http.maxResponseBytes`: JSON when it is JSON. */
  private async bodyOf(response: Response, method: string, signal: AbortSignal): Promise<unknown> {
    if (method === "HEAD" || response.body === null) return null;
    const limit = this.config.get("http.maxResponseBytes");
    const tooLarge = () => new ToolError(`The response is larger than ${limit} bytes`, { reason: "response_too_large" });
    if (Number(response.headers.get("content-length") ?? 0) > limit) {
      await response.body.cancel();
      throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    if (text === "") return null;
    if (!/[/+]json\b/i.test(response.headers.get("content-type") ?? "")) return text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

function invalid(message: string): ToolError {
  return new ToolError(message, { reason: "invalid_input" });
}

function authHeaders(auth: unknown): Record<string, string> {
  if (auth === undefined || auth === null) return {};
  if (typeof auth !== "object" || Array.isArray(auth)) throw invalid("auth must be an object");
  const { type, token, username, password, header, value } = auth as Record<string, unknown>;
  const text = (item: unknown, name: string): string => {
    if (typeof item !== "string" || item === "") throw invalid(`auth.${name} is required for ${String(type)}`);
    return item;
  };
  switch (type) {
    case "none":
      return {};
    case "bearer":
      return { authorization: `Bearer ${text(token, "token")}` };
    case "basic":
      return { authorization: `Basic ${Buffer.from(`${text(username, "username")}:${text(password, "password")}`).toString("base64")}` };
    case "apiKey":
      return { [text(header, "header").toLowerCase()]: text(value, "value") };
    default:
      throw invalid("auth.type must be none, bearer, basic or apiKey");
  }
}
