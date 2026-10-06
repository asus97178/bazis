import type { Class } from "../../di";
import type { ActionFilterHooks, HttpMiddleware } from "../Middleware/types";

// Same one-line polyfill as the validation module: Bun executes TC39
// decorators natively, Symbol.metadata may be missing in the runtime.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const HTTP_META = Symbol.for("bazis:http:meta");

/** One route declared by a method decorator (@Get/@Post/...). */
export interface RouteDeclaration {
  /** HTTP verb, "*" for @All. */
  readonly httpMethod: string;
  /** Path template relative to the controller prefix (":id(int)", "*rest"). */
  readonly template: string;
}

/** Error handler declared with @Catch on a controller method. */
export interface CatchDeclaration {
  /** Error class to match (instanceof); undefined matches any error. */
  errorType?: Class<Error>;
  methodName: string | symbol;
}

/** Metadata of a single action (method). */
export interface ActionMeta {
  routes: RouteDeclaration[];
  httpCode?: number;
  produces?: string;
  consumes?: string;
  version?: string;
  maxBodyBytes?: number;
  middleware: HttpMiddleware[];
  filters: ActionFilterHooks[];
}

/** Metadata of a controller class (own + inherited via copy-on-write). */
export interface ControllerMeta {
  /** Set by @Controller. */
  prefix?: string;
  isController: boolean;
  version?: string;
  middleware: HttpMiddleware[];
  filters: ActionFilterHooks[];
  catches: CatchDeclaration[];
  actions: Map<string | symbol, ActionMeta>;
}

interface HttpMetadataCarrier {
  [HTTP_META]?: ControllerMeta;
}

function emptyMeta(): ControllerMeta {
  return { isController: false, middleware: [], filters: [], catches: [], actions: new Map() };
}

function cloneMeta(source: ControllerMeta): ControllerMeta {
  const actions = new Map<string | symbol, ActionMeta>();
  for (const [name, action] of source.actions) {
    actions.set(name, {
      ...action,
      routes: [...action.routes],
      middleware: [...action.middleware],
      filters: [...action.filters],
    });
  }
  return {
    ...source,
    middleware: [...source.middleware],
    filters: [...source.filters],
    catches: [...source.catches],
    actions,
  };
}

/**
 * Own (copy-on-write) controller metadata for the class being decorated.
 * TC39 metadata objects inherit prototypically from the parent class — the
 * first write into a subclass clones the inherited state.
 */
export function ownMeta(metadata: object): ControllerMeta {
  const carrier = metadata as HttpMetadataCarrier;
  if (!Object.prototype.hasOwnProperty.call(carrier, HTTP_META)) {
    const inherited = carrier[HTTP_META];
    carrier[HTTP_META] = inherited ? cloneMeta(inherited) : emptyMeta();
  }
  return carrier[HTTP_META]!;
}

/** Action metadata bucket for a method decorator. */
export function ownActionMeta(metadata: object, methodName: string | symbol): ActionMeta {
  const meta = ownMeta(metadata);
  let action = meta.actions.get(methodName);
  if (!action) {
    action = { routes: [], middleware: [], filters: [] };
    meta.actions.set(methodName, action);
  }
  return action;
}

/** Reads controller metadata from a class (undefined if not decorated). */
export function controllerMetaOf(ctor: object): ControllerMeta | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | HttpMetadataCarrier
    | undefined;
  return metadata?.[HTTP_META];
}
