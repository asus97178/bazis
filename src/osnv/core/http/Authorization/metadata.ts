import type { HttpContext } from "../HttpContext/HttpContext";

// Same one-line polyfill as the rest of the HTTP module: Bun executes TC39
// decorators natively, but Symbol.metadata may be missing in the runtime.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const AUTHORIZE_META = Symbol.for("osnv:http:authorize");

/**
 * Проверка доступа для `@Authorize`. Получает контекст запроса и решает, можно
 * ли пустить. HTTP-ядро не знает, *что* именно проверяется (вид JWT, логин/
 * пароль, успешный вход через Telegram и т. д.) — это целиком внутри функции.
 *
 * - `true` — доступ разрешён;
 * - `false` — доступ запрещён (ядро ответит `403 Forbidden`);
 * - `throw` — функция сама задаёт ответ, бросив `HttpError` (например,
 *   `UnauthorizedError` → `401`, когда кредов вовсе нет).
 *
 * Зависимости (сервисы, БД) берутся из `ctx.services` (скоуп запроса).
 */
export type AuthorizeCheck = (ctx: HttpContext) => boolean | Promise<boolean>;

/** Требование авторизации: одна или несколько проверок (все должны пройти). */
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
 * Own (copy-on-write) метаданные авторизации для декорируемого класса. TC39
 * metadata наследуется прототипно от родителя — первая запись в подкласс
 * клонирует унаследованное состояние.
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

/** Эффективное требование маршрута (метод перекрывает контроллер). */
export interface ResolvedAuthorizeMeta {
  readonly allowAnonymous: boolean;
  readonly authorize?: AuthorizeOptions;
}

/**
 * Разрешает требование авторизации для конкретного действия. Приоритет:
 * `@AllowAnonymous`/`@Authorize` на методе перекрывают объявленные на классе.
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
