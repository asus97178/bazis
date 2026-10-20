import type { ServiceScope } from "../../di";
import { HttpSetupError } from "../Errors/HttpError";

// Same one-line polyfill as the rest of the HTTP module: Bun executes TC39
// decorators natively, but Symbol.metadata may be missing in the runtime.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const AUTHORIZE_META = Symbol.for("bazis:http:authorize");

/**
 * What an access check sees. An HTTP request (`HttpContext`) and a gRPC call
 * (`GrpcContext`) both provide it, so one check protects both transports.
 */
export interface AuthorizeContext {
  /** A request header (HTTP) or a text metadata value (gRPC), by case-insensitive name. */
  header(name: string): string | undefined;
  /** The DI scope of this request or call. */
  readonly services: ServiceScope;
  /** Values shared by the checks and the handler of this request or call. */
  readonly state: Map<string, unknown>;
}

/**
 * Access check for `@Authorize`. Receives the request context and decides
 * whether to let it through. The HTTP kernel does not know *what* is checked
 * (JWT kind, login/password, a successful Telegram sign-in and so on): that
 * is entirely inside the function.
 *
 * - `true`: access granted;
 * - `false`: access denied (the kernel answers `403 Forbidden`);
 * - `throw`: the function defines the response itself by throwing an `HttpError`
 *   (for example `UnauthorizedError` → `401` when there are no credentials at all).
 *
 * Dependencies (services, DB) come from `ctx.services` (the request scope).
 * On a gRPC call `false`/`ForbiddenError` is PERMISSION_DENIED and
 * `UnauthorizedError`/`JwtError` is UNAUTHENTICATED.
 */
export type AuthorizeCheck = (ctx: AuthorizeContext) => boolean | Promise<boolean>;

/** Authorization requirement: one or more checks (all must pass). */
export interface AuthorizeOptions {
  readonly checks: readonly AuthorizeCheck[];
}

interface AuthActionMeta {
  authorize?: AuthorizeOptions;
  allowAnonymous?: boolean;
  /** Declaration made on this exact class/method metadata object. */
  declaration?: "authorize" | "anonymous";
  /** Both `@Authorize` and `@AllowAnonymous` were declared here. */
  conflict?: true;
}

interface AuthControllerMeta {
  authorize?: AuthorizeOptions;
  allowAnonymous?: boolean;
  /** Declaration made on this exact class metadata object. */
  declaration?: "authorize" | "anonymous";
  /** Both `@Authorize` and `@AllowAnonymous` were declared on the class. */
  conflict?: true;
  actions: Map<string | symbol, AuthActionMeta>;
}

interface AuthMetadataCarrier {
  [AUTHORIZE_META]?: AuthControllerMeta;
}

function emptyMeta(): AuthControllerMeta {
  return { actions: new Map() };
}

function cloneMeta(source: AuthControllerMeta): AuthControllerMeta {
  const actions = new Map<string | symbol, AuthActionMeta>();
  for (const [name, action] of source.actions) {
    // Values inherit, declaration markers do not: the first decorator on a
    // subclass must override its base rather than accidentally accumulate it.
    actions.set(name, {
      authorize: action.authorize,
      allowAnonymous: action.allowAnonymous,
    });
  }
  return {
    authorize: source.authorize,
    allowAnonymous: source.allowAnonymous,
    actions,
  };
}

/**
 * Own (copy-on-write) authorization metadata of the decorated class. TC39
 * metadata is inherited prototypically from the parent: the first write in a
 * subclass clones the inherited state.
 */
function ownMeta(metadata: object): AuthControllerMeta {
  const carrier = metadata as AuthMetadataCarrier;
  if (!Object.prototype.hasOwnProperty.call(carrier, AUTHORIZE_META)) {
    const inherited = carrier[AUTHORIZE_META];
    carrier[AUTHORIZE_META] = inherited ? cloneMeta(inherited) : emptyMeta();
  }
  return carrier[AUTHORIZE_META]!;
}

function ownActionMeta(metadata: object, methodName: string | symbol): AuthActionMeta {
  const meta = ownMeta(metadata);
  let action = meta.actions.get(methodName);
  if (!action) {
    action = {};
    meta.actions.set(methodName, action);
  }
  return action;
}

// The other declaration on the same class or method: each would silently undo
// the other and the decorator order would decide. Reported when routes are built.
function markConflict(target: { declaration?: "authorize" | "anonymous"; conflict?: true }, declaration: "authorize" | "anonymous"): void {
  if (target.declaration !== undefined && target.declaration !== declaration) target.conflict = true;
}

export function setControllerAuthorize(metadata: object, options: AuthorizeOptions): void {
  const meta = ownMeta(metadata);
  markConflict(meta, "authorize");
  meta.authorize = meta.declaration === "authorize" && meta.authorize
    ? { checks: [...options.checks, ...meta.authorize.checks] }
    : options;
  meta.declaration = "authorize";
  delete meta.allowAnonymous;
}

export function setControllerAllowAnonymous(metadata: object): void {
  const meta = ownMeta(metadata);
  markConflict(meta, "anonymous");
  meta.allowAnonymous = true;
  meta.declaration = "anonymous";
  delete meta.authorize;
}

export function setActionAuthorize(metadata: object, methodName: string | symbol, options: AuthorizeOptions): void {
  const action = ownActionMeta(metadata, methodName);
  markConflict(action, "authorize");
  action.authorize = action.declaration === "authorize" && action.authorize
    ? { checks: [...options.checks, ...action.authorize.checks] }
    : options;
  action.declaration = "authorize";
  delete action.allowAnonymous;
}

export function setActionAllowAnonymous(metadata: object, methodName: string | symbol): void {
  const action = ownActionMeta(metadata, methodName);
  markConflict(action, "anonymous");
  action.allowAnonymous = true;
  action.declaration = "anonymous";
  delete action.authorize;
}

/** Effective route requirement: the class and method checks combined. */
export interface ResolvedAuthorizeMeta {
  readonly allowAnonymous: boolean;
  readonly authorize?: AuthorizeOptions;
}

/**
 * Resolves the authorization requirement of a specific action:
 *
 * - `@AllowAnonymous` on the method opens it, whatever the class declares;
 * - `@Authorize` on the class and on the method combine: the class checks run
 *   first, then the method checks (a check repeated on both runs once);
 * - `@AllowAnonymous` on the class opens the methods without their own `@Authorize`.
 *
 * Inheritance is different: a subclass's own class-level declaration replaces
 * the base class's, and an overriding method's declaration replaces the base method's.
 * Both decorators on the same class or method throw `HttpSetupError`.
 */
export function resolveAuthorizeMeta(ctor: object, methodName: string | symbol): ResolvedAuthorizeMeta {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | AuthMetadataCarrier
    | undefined;
  const meta = metadata?.[AUTHORIZE_META];
  if (!meta) {
    return { allowAnonymous: false };
  }

  const owner = (ctor as { readonly name?: string }).name || "Controller";
  if (meta.conflict) {
    throw new HttpSetupError(
      `${owner} has both @AllowAnonymous() and @Authorize(...) on the class: the result would depend on the decorator order. `
        + "Keep one; to open single methods of a protected class, put @AllowAnonymous() on them.",
    );
  }
  const action = meta.actions.get(methodName);
  if (action?.conflict) {
    throw new HttpSetupError(
      `${owner}.${String(methodName)} has both @AllowAnonymous() and @Authorize(...): the result would depend on the decorator order. `
        + "Keep @Authorize(...) to protect the route, or @AllowAnonymous() to open it.",
    );
  }
  if (action?.allowAnonymous) {
    return { allowAnonymous: true };
  }
  const classChecks = meta.authorize?.checks ?? [];
  const actionChecks = action?.authorize?.checks ?? [];
  if (actionChecks.length === 0 && meta.allowAnonymous) {
    return { allowAnonymous: true };
  }
  const checks = [...new Set([...classChecks, ...actionChecks])];
  return checks.length === 0
    ? { allowAnonymous: false }
    : { allowAnonymous: false, authorize: { checks } };
}

/**
 * The checks a route runs: the server's default checks (`runApp({ http:
 * { authorize } })`) first, then the route's own `@Authorize`; each function
 * once. `undefined` — the route is open: `@AllowAnonymous`, or no checks at all.
 */
export function routeAuthorizeChecks(ctor: object, methodName: string | symbol, defaults: readonly AuthorizeCheck[] = []): readonly AuthorizeCheck[] | undefined {
  const meta = resolveAuthorizeMeta(ctor, methodName);
  if (meta.allowAnonymous) return undefined;
  const checks = [...new Set([...defaults, ...(meta.authorize?.checks ?? [])])];
  return checks.length === 0 ? undefined : checks;
}

/** `authorize` of the HTTP options as a list. */
export function defaultAuthorizeChecks(option: AuthorizeCheck | readonly AuthorizeCheck[] | undefined): readonly AuthorizeCheck[] {
  return option === undefined ? [] : typeof option === "function" ? [option] : option;
}
