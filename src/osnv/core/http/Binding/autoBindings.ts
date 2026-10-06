import { optionsFromSchema } from "../../../library/jsonapi";
import { AMBIGUOUS_REQUEST_MODEL, findRequestModelByName } from "./requestModelRegistry";
import { AMBIGUOUS_LIST_MODEL, findListModelByName } from "./listModelRegistry";
import { HttpSetupError } from "../Errors/HttpError";
import type { Class } from "../../di";
import type { ParameterBinding } from "./bindings";
import type { GeneratedBindingSpec } from "./generatedSpec";

type GeneratedControllerClass = abstract new (...args: never[]) => object;

// Generated target constructors remain process-owned. Map snapshots make a
// failed multi-owner publication fully reversible.
let targetBindings = new Map<GeneratedControllerClass, Readonly<Record<string, readonly GeneratedBindingSpec[]>>>();
let targetModels = new Map<GeneratedControllerClass, ReadonlyMap<string, Class<object>>>();

/** Registers an isolated generated target slice without relying on class.name. */
export function registerGeneratedBindings(
  controller: Class<object>,
  bindings: Readonly<Record<string, readonly GeneratedBindingSpec[]>>,
  models?: ReadonlyMap<string, Class<object>>,
): void {
  targetBindings.set(controller, bindings);
  if (models !== undefined) targetModels.set(controller, models);
}

/**
 * Binding conventions inferred by codegen (`bun run di:generate`) from the
 * controller method signature, the counterpart of DI auto deps:
 *
 * - a parameter named like a route `:name` -> from the route;
 * - a class type -> request body plus validation;
 * - `HttpContext` / `Request` / `ResponseBuilder` -> context/raw request/builder;
 * - other primitives -> query (converted by type; `?`/default -> optional).
 *
 * Headers and raw bodies are read through HttpContext; services are injected
 * into the constructor. Any DTO class parameter is treated as the request body.
 * Model names are resolved once at startup; configuration errors are
 * `HttpSetupError` (fail fast).
 */
export function resolveGeneratedBindings(
  controller: GeneratedControllerClass,
  methodName: string | symbol,
): readonly ParameterBinding[] | undefined {
  const controllerName = controller.name;
  const specs = targetBindings.get(controller)?.[String(methodName)];
  if (specs === undefined) {
    return undefined;
  }
  const models = targetModels.get(controller);
  return specs.map((spec) => toBinding(spec, controllerName, String(methodName), models));
}

function toBinding(spec: GeneratedBindingSpec, controllerName: string, methodName: string, models?: ReadonlyMap<string, Class<object>>): ParameterBinding {
  switch (spec.source) {
    case "route":
      return { source: "route", name: spec.name, type: spec.type, optional: spec.optional };
    case "query":
      return { source: "query", name: spec.name, type: spec.type, optional: spec.optional };
    case "context":
      return { source: "context" };
    case "request":
      return { source: "request" };
    case "response":
      return { source: "response" };
    case "list": {
      if (!spec.model) {
        return { source: "list" };
      }
      // An explicit target controller always resolves through its own
      // constructor-local index. Name fallback is legacy/default-only.
      const ctor = models === undefined ? findListModelByName(spec.model) : models.get(spec.model);
      if (ctor === undefined) {
        throw new HttpSetupError(
          `${controllerName}.${methodName}: list model "${spec.model}" is not registered. ` +
            `Make sure the class extends ListRequest and its module is imported, then run \`bun run di:generate\`.`,
        );
      }
      if (ctor === AMBIGUOUS_LIST_MODEL) {
        throw new HttpSetupError(
          `${controllerName}.${methodName}: list model name "${spec.model}" is ambiguous (several classes share it). ` +
            `Rename one of the classes.`,
        );
      }
      return { source: "list", model: ctor as Class<object>, listOptions: optionsFromSchema(ctor) };
    }
    case "body": {
      if (!spec.model) {
        return { source: "body" };
      }
      // An explicit target controller always resolves through its own
      // constructor-local index. Name fallback is legacy/default-only.
      const model = models === undefined ? findRequestModelByName(spec.model) : models.get(spec.model);
      if (model === undefined) {
        throw new HttpSetupError(
          `${controllerName}.${methodName}: body model "${spec.model}" is not registered. ` +
            `Regenerate the target metadata; for an external DTO use @RequestModel() and import its module.`,
        );
      }
      if (model === AMBIGUOUS_REQUEST_MODEL) {
        throw new HttpSetupError(
          `${controllerName}.${methodName}: body model name "${spec.model}" is ambiguous (several classes share it). ` +
            `Rename one of the classes.`,
        );
      }
      return { source: "body", model };
    }
  }
}

/** Internal generated-runtime transaction support. */
export function snapshotGeneratedBindings(): {
  readonly targetBindings: typeof targetBindings;
  readonly targetModels: typeof targetModels;
} {
  return {
    targetBindings: new Map(targetBindings),
    targetModels: new Map(targetModels),
  };
}

/** Internal generated-runtime transaction support. */
export function restoreGeneratedBindings(snapshot: ReturnType<typeof snapshotGeneratedBindings>): void {
  targetBindings = snapshot.targetBindings;
  targetModels = snapshot.targetModels;
}
