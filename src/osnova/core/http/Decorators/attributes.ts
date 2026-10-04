import type { Class } from "../../di";
import type { ActionFilterHooks, HttpMiddleware } from "../Middleware/types";
import { ownActionMeta, ownMeta } from "./metadata";

type AnyClass = abstract new (...args: never[]) => unknown;
type AnyMethod = (...args: never[]) => unknown;
type MethodDecorator = (value: AnyMethod, context: ClassMethodDecoratorContext) => void;
type ClassOrMethodDecorator = (value: AnyClass | AnyMethod, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void;

/** Default success status code for the action (`@HttpCode(201)`). */
export function HttpCode(code: number): MethodDecorator {
  return (_value, context) => {
    ownActionMeta(context.metadata, context.name).httpCode = code;
  };
}

/** Response Content-Type for plain-value returns (`@Produces("text/csv")`). */
export function Produces(contentType: string): MethodDecorator {
  return (_value, context) => {
    ownActionMeta(context.metadata, context.name).produces = contentType;
  };
}

/** Required request Content-Type for body bindings; mismatch -> 415. */
export function Consumes(contentType: string): MethodDecorator {
  return (_value, context) => {
    ownActionMeta(context.metadata, context.name).consumes = contentType;
  };
}

/**
 * Attaches middleware to a controller (class) or a single route (method).
 * Execution order: global -> controller -> route -> action.
 */
export function Middleware(...middleware: HttpMiddleware[]): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      ownMeta(context.metadata).middleware.push(...middleware);
    } else {
      ownActionMeta(context.metadata, context.name).middleware.push(...middleware);
    }
  };
}

/**
 * Action filters (.NET style): `before` runs after binding, `after` may
 * replace the result. Class-level filters wrap method-level ones.
 */
export function ActionFilter(filter: ActionFilterHooks): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      ownMeta(context.metadata).filters.push(filter);
    } else {
      ownActionMeta(context.metadata, context.name).filters.push(filter);
    }
  };
}

/**
 * API version of a controller (or a single action). Routes of versioned
 * controllers are matched according to `httpModule({ versioning })`:
 * URL segment (`/v1.0/...`), query parameter or header.
 */
export function ApiVersion(version: string): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      ownMeta(context.metadata).version = version;
    } else {
      ownActionMeta(context.metadata, context.name).version = version;
    }
  };
}

/**
 * Declares a controller method as an error handler for the given error type
 * (instanceof match; omit the type to catch everything). The handler receives
 * `(error, ctx)` and returns a result like a regular action:
 *
 * ```ts
 * @Catch(EntityNotFoundError)
 * onMissing(error: EntityNotFoundError) {
 *   return NotFound({ error: error.message });
 * }
 * ```
 *
 * Unmatched (or re-thrown) errors fall through to the global error handler.
 */
export function Catch(errorType?: Class<Error>): MethodDecorator {
  return (_value, context) => {
    ownMeta(context.metadata).catches.push({ errorType, methodName: context.name });
  };
}
