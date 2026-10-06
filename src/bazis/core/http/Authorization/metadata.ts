import type { HttpContext } from "../HttpContext/HttpContext";

// Same one-line polyfill as the rest of the HTTP module: Bun executes TC39
// decorators natively, but Symbol.metadata may be missing in the runtime.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const AUTHORIZE_META = Symbol.for("bazis:http:authorize");

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
 */
export type AuthorizeCheck = (ctx: HttpContext) => boolean | Promise<boolean>;

/** Authorization requirement: one or more checks (all must pass). */
export interface AuthorizeOptions {
  readonly checks: readonly AuthorizeCheck[];
}

interface AuthActionMeta {
  authorize?: AuthorizeOptions;
  allowAnonymous?: boolean;
  /** Declaration made on this exact class/method metadata object. */
  declaration?: "authorize" | "anonymous";
}

interface AuthControllerMeta {
  authorize?: AuthorizeOptions;
  allowAnonymous?: boolean;
  /** Declaration made on this exact class metadata object. */
  declaration?: "authorize" | "anonymous";
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

export function setControllerAuthorize(metadata: object, options: AuthorizeOptions): void {
  const meta = ownMeta(metadata);
  meta.authorize = meta.declaration === "authorize" && meta.authorize
    ? { checks: [...options.checks, ...meta.authorize.checks] }
    : options;
  meta.declaration = "authorize";
  delete meta.allowAnonymous;
}

export function setControllerAllowAnonymous(metadata: object): void {
  const meta = ownMeta(metadata);
  meta.allowAnonymous = true;
  meta.declaration = "anonymous";
  delete meta.authorize;
}

export function setActionAuthorize(metadata: object, methodName: string | symbol, options: AuthorizeOptions): void {
  const action = ownActionMeta(metadata, methodName);
  action.authorize = action.declaration === "authorize" && action.authorize
    ? { checks: [...options.checks, ...action.authorize.checks] }
    : options;
  action.declaration = "authorize";
  delete action.allowAnonymous;
}

export function setActionAllowAnonymous(metadata: object, methodName: string | symbol): void {
  const action = ownActionMeta(metadata, methodName);
  action.allowAnonymous = true;
  action.declaration = "anonymous";
  delete action.authorize;
}

/** Effective route requirement (the method overrides the controller). */
export interface ResolvedAuthorizeMeta {
  readonly allowAnonymous: boolean;
  readonly authorize?: AuthorizeOptions;
}

/**
 * Resolves the authorization requirement of a specific action. Precedence:
 * `@AllowAnonymous`/`@Authorize` on the method override those declared on the class.
 */
export function resolveAuthorizeMeta(ctor: object, methodName: string | symbol): ResolvedAuthorizeMeta {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | AuthMetadataCarrier
    | undefined;
  const meta = metadata?.[AUTHORIZE_META];
  if (!meta) {
    return { allowAnonymous: false };
  }

  const action = meta.actions.get(methodName);
  if (action?.allowAnonymous) {
    return { allowAnonymous: true };
  }
  if (action?.authorize) {
    return { allowAnonymous: false, authorize: action.authorize };
  }
  if (meta.allowAnonymous) {
    return { allowAnonymous: true };
  }
  if (meta.authorize) {
    return { allowAnonymous: false, authorize: meta.authorize };
  }
  return { allowAnonymous: false };
}
