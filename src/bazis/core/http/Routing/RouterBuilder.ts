import type { Class, Token } from "../../di";
import { assertConsumes, bindArguments } from "../Binding/ParameterBinder";
import { resolveGeneratedBindings } from "../Binding/autoBindings";
import { generatedSourcesAreStale } from "../../generatedFingerprint";
import { controllerMetaOf, type ActionMeta, type ControllerMeta } from "../Decorators/metadata";
import { HttpSetupError } from "../Errors/HttpError";
import type { HttpContext } from "../HttpContext/HttpContext";
import type { ActionFilterHooks, HttpMiddleware } from "../Middleware/types";
import { corsOptionsOf } from "../Middleware/cors";
import { normalizeResult } from "../Results/normalize";
import type { ApiVersioningOptions, RouteMiddlewareComposer } from "../options";
import { createAuthorizeComposer } from "../Authorization/authorizeComposer";
import { Router, type RouteAction } from "./Router";
import { joinPaths, parseTemplate } from "./template";

type ControllerInstance = Record<string | symbol, (...args: unknown[]) => unknown>;

interface ActionPipeline {
  /** Binding and ActionFilter.before: boundary checks that must also run on cache hits. */
  readonly boundary: HttpMiddleware;
  /** Controller/action execution and ActionFilter.after: skipped when middleware short-circuits. */
  readonly terminal: HttpMiddleware;
}

/**
 * Builds the radix router from controller metadata. Runs once at server
 * startup: templates are parsed and the action boundary/terminal handlers are
 * precompiled per route — request dispatch performs no metadata work at all.
 */
export class RouterBuilder {
  private readonly authorizeComposer = createAuthorizeComposer();

  constructor(
    /** Middleware prepended to every route: [logger?, cors?, errorHandler, ...global]. */
    private readonly serverChain: readonly HttpMiddleware[],
    private readonly globalPrefix: string | undefined,
    private readonly versioning: ApiVersioningOptions | undefined,
    private readonly routeMiddlewareComposer?: RouteMiddlewareComposer,
  ) {}

  build(controllers: readonly Class<object>[]): Router {
    const router = new Router();
    for (const controllerClass of controllers) {
      const meta = controllerMetaOf(controllerClass);
      if (!meta?.isController) {
        throw new HttpSetupError(
          `Class "${controllerClass.name}" is not a controller. Add @Controller() and route decorators.`,
        );
      }
      this.registerController(router, controllerClass, meta);
    }
    return router;
  }

  private registerController(router: Router, controllerClass: Class<object>, meta: ControllerMeta): void {
    const useUrlVersioning = this.versioning === undefined || this.versioning.source === "url";
    for (const [methodName, action] of meta.actions) {
      if (action.routes.length === 0) {
        continue;
      }
      if (action.maxBodyBytes !== undefined
        && (!Number.isSafeInteger(action.maxBodyBytes) || action.maxBodyBytes <= 0)) {
        throw new HttpSetupError("HTTP route maxBodyBytes metadata must be a positive safe integer.");
      }
      const version = action.version ?? meta.version;
      const pipeline = this.createActionPipeline(controllerClass, methodName, meta, action);
      const authorization = this.authorizeComposer(controllerClass, methodName, meta, action);
      const composed = this.routeMiddlewareComposer?.(controllerClass, methodName, meta, action) ?? [];
      // Authorization must precede controller middleware so unauthenticated
      // requests cannot trigger controller-level work or side effects. Route
      // and method policies plus ActionFilter.before form the public action
      // boundary and therefore run before short-circuiting composers such as
      // output cache. The controller and action still remain lazy on a hit.
      const chain = [
        ...this.serverChain,
        ...authorization,
        ...meta.middleware,
        ...action.middleware,
        pipeline.boundary,
        ...composed,
        pipeline.terminal,
      ];
      const routeAction: RouteAction = {
        chain,
        version,
        name: `${controllerClass.name}.${String(methodName)}`,
        maxBodyBytes: action.maxBodyBytes,
        cors: routeCors(meta, action),
      };
      for (const declaration of action.routes) {
        const versionSegment = useUrlVersioning && version !== undefined ? `v${version}` : undefined;
        const fullPath = joinPaths(this.globalPrefix, versionSegment, meta.prefix, declaration.template);
        const versionKey = useUrlVersioning ? "" : (version ?? "");
        router.register(parseTemplate(fullPath), declaration.httpMethod, versionKey, routeAction);
      }
    }
  }

  /**
   * Precompiles binding + ActionFilter.before as a boundary middleware and
   * controller execution + ActionFilter.after as the terminal. This lets
   * output cache short-circuit only the latter. Errors first get a chance at
   * the controller's @Catch handlers, then bubble to the global error handler.
   */
  private createActionPipeline(
    controllerClass: Class<object>,
    methodName: string | symbol,
    meta: ControllerMeta,
    action: ActionMeta,
  ): ActionPipeline {
    const filters: readonly ActionFilterHooks[] = [...meta.filters, ...action.filters];
    const catches = meta.catches;
    const bindings = resolveGeneratedBindings(controllerClass, methodName);
    assertBindingsFresh(controllerClass, methodName, bindings);
    const responseDefaults = { httpCode: action.httpCode, produces: action.produces };
    const bindingDefaults = { consumes: action.consumes };
    const token = controllerClass as unknown as Token<object>;
    const boundArguments = new WeakMap<HttpContext, readonly unknown[]>();

    const handleError = async (
      error: unknown,
      ctx: HttpContext,
      resolvedController?: ControllerInstance,
    ): Promise<boolean> => {
      if (catches.length === 0) {
        return false;
      }
      const controller = resolvedController ?? ctx.services.resolve(token) as ControllerInstance;
      for (const handler of catches) {
        if (handler.errorType !== undefined && !(error instanceof handler.errorType)) {
          continue;
        }
        const handled: unknown = await controller[handler.methodName]!(error, ctx);
        if (handled !== undefined) {
          ctx.response = normalizeResult(handled, ctx, {});
          return true;
        }
      }
      return false;
    };

    const boundary: HttpMiddleware = async (ctx, next) => {
      try {
        assertConsumes(ctx, bindingDefaults.consumes);
        const args = bindings ? await bindArguments(bindings, ctx, bindingDefaults) : [ctx];
        for (const filter of filters) {
          await filter.before?.(ctx);
        }
        boundArguments.set(ctx, args);
      } catch (error) {
        if (await handleError(error, ctx)) {
          return;
        }
        throw error;
      }

      try {
        await next();
      } finally {
        boundArguments.delete(ctx);
      }
    };

    const terminal: HttpMiddleware = async (ctx: HttpContext) => {
      const args = boundArguments.get(ctx);
      if (args === undefined) {
        throw new Error(`Action boundary was not executed for ${controllerClass.name}.${String(methodName)}`);
      }
      const controller = ctx.services.resolve(token) as ControllerInstance;
      try {
        let result: unknown = await controller[methodName]!(...args);
        for (let index = filters.length - 1; index >= 0; index -= 1) {
          const replaced = await filters[index]!.after?.(ctx, result);
          if (replaced !== undefined) {
            result = replaced;
          }
        }
        ctx.response = normalizeResult(result, ctx, responseDefaults);
      } catch (error) {
        if (await handleError(error, ctx, controller)) {
          return;
        }
        throw error;
      }
    };

    return { boundary, terminal };
  }
}

/**
 * Without generated bindings a method receives only the HttpContext. When the
 * generated code is older than the sources, a method that declares parameters
 * but has no bindings was most likely added or changed after the last codegen:
 * its arguments would silently get wrong values, so the server refuses to start.
 */
/** The action's own `cors()` wins over the controller's. */
function routeCors(meta: ControllerMeta, action: ActionMeta): ReturnType<typeof corsOptionsOf> {
  for (const middleware of [...action.middleware].reverse()) {
    const options = corsOptionsOf(middleware);
    if (options !== undefined) return options;
  }
  for (const middleware of [...meta.middleware].reverse()) {
    const options = corsOptionsOf(middleware);
    if (options !== undefined) return options;
  }
  return undefined;
}

function assertBindingsFresh(
  controllerClass: Class<object>,
  methodName: string | symbol,
  bindings: readonly unknown[] | undefined,
): void {
  if (bindings !== undefined || !generatedSourcesAreStale()) {
    return;
  }
  const method = (controllerClass.prototype as Record<string | symbol, unknown>)[methodName];
  if (typeof method !== "function" || method.length === 0) {
    return;
  }
  throw new HttpSetupError(
    `${controllerClass.name}.${String(methodName)} has parameters but no generated argument bindings: ` +
      "the generated code is older than this controller. Run `bazis codegen` " +
      "(bazis dev, bazis test and bazis build run it automatically).",
  );
}
