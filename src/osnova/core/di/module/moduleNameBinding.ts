import { AmbiguousNamedDependencyError } from "../errors";
import { getProviderDeps, withProviderDeps } from "../internal/providerDeps";
import {
  isLazyDependency,
  isNamedDependency,
  lazyDependency,
  ProviderDefinition,
} from "../provider";
import type { ProviderDependencyList } from "../provider";
import { tokenToDebugName, type Token } from "../token";
import { computeModuleVisibleTokens, type ModuleGraphRecord } from "./encapsulation";

type Dependency = ProviderDependencyList[number];

/**
 * Module-scoped resolution of name-based auto dependencies.
 *
 * Auto deps are reflection-free, so they bind by *type name*. Resolving those
 * names globally would force every token's debug name to be unique across the
 * whole application — a real tax at enterprise scale (two bounded contexts each
 * with an `IRepository`). Instead we resolve each provider's named dependencies
 * against the tokens visible to the module that declared it:
 *
 * - exactly one visible token with that name -> bind to it (becomes a concrete
 *   token, so the hot resolve path skips the name lookup entirely);
 * - several visible tokens share the name -> {@link AmbiguousNamedDependencyError}
 *   at build time (fail fast), instead of a late surprise on first resolve;
 * - none visible -> leave the named dependency untouched so the container's
 *   global index can still resolve it. This preserves the fully-open default
 *   where a service may depend on a sibling module's token without importing it.
 *
 * Runs once at `createContainer`, after encapsulation validation; the resolution
 * hot path is untouched.
 */
export function bindModuleScopedNames(
  definitions: readonly ProviderDefinition[],
  recordOf: ReadonlyMap<ProviderDefinition, ModuleGraphRecord>,
  records: readonly ModuleGraphRecord[],
): ProviderDefinition[] {
  const bind = createModuleScopedNameBinder(records);
  return definitions.map((definition) => {
    const record = recordOf.get(definition);
    return record ? bind(definition, record) : definition;
  });
}

/** Reuses module visibility for ordinary and later materialized providers. */
export function createModuleScopedNameBinder(
  records: readonly ModuleGraphRecord[],
): (definition: ProviderDefinition, record: ModuleGraphRecord) => ProviderDefinition {
  const visibleByRecord = computeModuleVisibleTokens(records);
  const nameMapCache = new Map<ModuleGraphRecord, Map<string, Token<unknown>[]>>();

  const nameMapFor = (record: ModuleGraphRecord): Map<string, Token<unknown>[]> => {
    const cached = nameMapCache.get(record);
    if (cached) {
      return cached;
    }
    const map = new Map<string, Token<unknown>[]>();
    const visible = visibleByRecord.get(record);
    if (visible) {
      for (const token of visible) {
        const name = tokenToDebugName(token);
        const bucket = map.get(name);
        if (bucket) {
          if (!bucket.includes(token)) {
            bucket.push(token);
          }
        } else {
          map.set(name, [token]);
        }
      }
    }
    nameMapCache.set(record, map);
    return map;
  };

  return (definition, record) => rebindDefinition(definition, nameMapFor(record));
}

function rebindDefinition(
  definition: ProviderDefinition,
  nameMap: Map<string, Token<unknown>[]>,
): ProviderDefinition {
  const provider = definition.provider;
  const deps = getProviderDeps(provider);
  if (deps.length === 0) {
    return definition;
  }

  let changed = false;
  const next: Dependency[] = new Array(deps.length);
  for (let index = 0; index < deps.length; index += 1) {
    const dep = deps[index] as Dependency;
    const rebound = rebindDependency(dep, nameMap);
    next[index] = rebound;
    if (rebound !== dep) {
      changed = true;
    }
  }
  if (!changed) {
    return definition;
  }

  const nextProvider = withProviderDeps(provider, next);
  return new ProviderDefinition(nextProvider, definition.lifetime, definition.key);
}

function rebindDependency(dep: Dependency, nameMap: Map<string, Token<unknown>[]>): Dependency {
  if (dep === undefined) {
    return dep;
  }
  if (isLazyDependency(dep)) {
    const inner = dep.inner;
    if (isNamedDependency(inner)) {
      const token = resolveName(inner.name, nameMap);
      return token ? lazyDependency(token) : dep;
    }
    return dep;
  }
  if (isNamedDependency(dep)) {
    return resolveName(dep.name, nameMap) ?? dep;
  }
  return dep;
}

function resolveName(name: string, nameMap: Map<string, Token<unknown>[]>): Token<unknown> | undefined {
  const tokens = nameMap.get(name);
  if (!tokens || tokens.length === 0) {
    return undefined;
  }
  if (tokens.length > 1) {
    throw new AmbiguousNamedDependencyError(name);
  }
  return tokens[0];
}
