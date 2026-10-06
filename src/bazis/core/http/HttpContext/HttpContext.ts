import type { ServiceScope } from "../../di";
import { BadRequestError, PayloadTooLargeError } from "../Errors/HttpError";
import { ResponseBuilder } from "./ResponseBuilder";
import type { ModelValidator } from "../Binding/modelValidator";

/** Route parameter values after constraint conversion (`:id(int)` -> number). */
export type RouteParams = Readonly<Record<string, string | number | boolean>>;

/**
 * Per-request context flowing through the middleware pipeline and into
 * actions. Wraps the native Bun `Request`, the matched route parameters and
 * the request-scoped DI resolver.
 */
export class HttpContext {
  /** Response produced by the pipeline (set by the terminal handler or middleware). */
  response?: Response;

  /** Response shaping for actions that return plain values (see ResponseBuilder). */
  readonly res = new ResponseBuilder();

  /** Free-form state for passing data between middleware (e.g. auth user). */
  readonly state = new Map<string, unknown>();

  private bodyPromise?: Promise<unknown>;
  private bodyBytesPromise?: Promise<Uint8Array>;

  constructor(
    /** Native Bun request. */
    readonly request: Request,
    /** Parsed request URL (query via `url.searchParams`). */
    readonly url: URL,
    /** Route parameters, converted per template constraints. */
    readonly params: RouteParams,
    /**
     * Request-scoped DI resolver: controllers and scoped services of this
     * request are resolved from here. JS producers retain the scope until EOF,
     * failure, cancellation or peer disconnect. Native file/materialized bodies
     * release it after Bun takes ownership. The original Response is preserved.
     */
    readonly services: ServiceScope,
    /** API version resolved for this request (if versioning is enabled). */
    readonly apiVersion?: string,
    /** Optional maximum request body size enforced while reading body streams. */
    private readonly maxBodyBytes?: number,
    /** Remote peer address reported by Bun (not a forwarded header). */
    readonly clientIp?: string,
    /** Validator captured by the owning HTTP server. */
    readonly modelValidator?: ModelValidator,
  ) {}

  get method(): string {
    return this.request.method;
  }

  get path(): string {
    return this.url.pathname;
  }

  /** Query parameter shortcut. */
  query(name: string): string | undefined {
    return this.url.searchParams.get(name) ?? undefined;
  }

  /** Header shortcut (case-insensitive). */
  header(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }

  /**
   * Request body parsed as JSON. Parsed once and cached — multiple bindings
   * and middleware share the same promise. Malformed JSON becomes a 400.
   */
  json<T = unknown>(): Promise<T> {
    this.bodyPromise ??= this.readBodyText().then((text) => {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BadRequestError("Malformed JSON in request body");
      }
    });
    return this.bodyPromise as Promise<T>;
  }

  /** Request body as text. Shares the same bounded body read as JSON/formData. */
  text(): Promise<string> {
    return this.readBodyText();
  }

  /** Request body as multipart/urlencoded form data (native parser). */
  formData(): ReturnType<Request["formData"]> {
    return this.readBodyBytes()
      .then((bytes) => new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], { headers: this.request.headers }).formData())
      .catch((error) => {
        if (error instanceof PayloadTooLargeError) {
          throw error;
        }
        throw new BadRequestError("Malformed form data in request body");
      }) as ReturnType<Request["formData"]>;
  }

  private readBodyText(): Promise<string> {
    return this.readBodyBytes().then((bytes) => new TextDecoder().decode(bytes));
  }

  private readBodyBytes(): Promise<Uint8Array> {
    this.bodyBytesPromise ??= readRequestBodyBytes(this.request, this.maxBodyBytes);
    return this.bodyBytesPromise;
  }
}

async function readRequestBodyBytes(request: Request, maxBytes: number | undefined): Promise<Uint8Array> {
  if (request.body === null) {
    return new Uint8Array();
  }
  if (maxBytes === undefined) {
    return new Uint8Array(await request.arrayBuffer());
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      const chunk = item.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        void reader.cancel("request body exceeds maxBodyBytes").catch(() => undefined);
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] as Uint8Array;
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
