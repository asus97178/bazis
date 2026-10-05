import { ModuleEncapsulationError } from "../errors";
import { getProviderDeps } from "../internal/providerDeps";
import { NamedTokenIndex } from "../internal/NamedTokenIndex";
import type { OpenGenericRegistration } from "../internal/OpenGenericRegistration";
import { isKeyedDependency, isLazyDependency, isNamedDependency, type ProviderDefinition } from "../provider";
import { tokenToDebugName, type Token } from "../token";
import type { ServiceKey } from "../types";
import { isFamilyExport, type ModuleGraphRecord } from "./encapsulation";

/** Validate the actual last-wins selection, not just visibility of a token.
 * Root resolve/resolveAll retain their global semantics. A consumer may not
 * silently receive a private implementation from an unrelated module.
 */
export function createProviderSelectionValidator(
  records: readonly ModuleGraphRecord[],
  definitions: readonly ProviderDefinition[],
  recordOf: ReadonlyMap<ProviderDefinition, ModuleGraphRecord>,
  generics: readonly OpenGenericRegistration[],
  genericRecordOf: ReadonlyMap<OpenGenericRegistration, ModuleGraphRecord>,
): (definition: ProviderDefinition, record: ModuleGraphRecord) => void {
  if (!records.some((record) => record.exports !== undefined)) return () => {};

  const selected = new Map<Token<unknown>, Map<ServiceKey | undefined, ModuleGraphRecord>>();
  const selectedFamilies = new Map<symbol, Map<ServiceKey | undefined, ModuleGraphRecord>>();
  for (const definition of definitions) {
    const owner = recordOf.get(definition);
    if (!owner) continue;
    const token = definition.provider.provide;
    const keys = selected.get(token) ?? new Map();
    keys.set(definition.key, owner);
    selected.set(token, keys);
  }
  for (const registration of generics) {
    const owner = genericRecordOf.get(registration);
    if (!owner) continue;
    const keys = selectedFamilies.get(registration.family.id) ?? new Map();
    keys.set(registration.key, owner);
    selectedFamilies.set(registration.family.id, keys);
  }

  // Some generated names (e.g. a closed generic) have no explicit definition
  // until registry materialization. Use the same token families/arguments;
  // token creation is pure and does not invoke provider factories.
  const names = new NamedTokenIndex(function* () {
    yield* selected.keys();
    const arguments_ = [...selected.keys()];
    const families = new Map(generics.map((registration) => [registration.family.id, registration.family]));
    for (const family of families.values()) {
      for (const argument of arguments_) yield family.of(argument);
    }
  });

  // One memo per exact token and selected owner; module graph is already acyclic.
  const exportsMemo = new Map<Token<unknown>, Map<ModuleGraphRecord, Map<ModuleGraphRecord, boolean>>>();
  const exportsOwner = (record: ModuleGraphRecord, owner: ModuleGraphRecord, token: Token<unknown>): boolean => {
    let owners = exportsMemo.get(token);
    if (!owners) exportsMemo.set(token, owners = new Map());
    let memo = owners.get(owner);
    if (!memo) owners.set(owner, memo = new Map());
    const cached = memo.get(record);
    if (cached !== undefined) return cached;
    const publishes = record.exports === undefined || record.exports.some((ref) =>
      ref === token || (isFamilyExport(ref) && typeof token !== "function" && ref.id === token.genericFamilyId),
    );
    const visible = publishes && (record === owner || record.imports.some((imported) => exportsOwner(imported, owner, token)));
    memo.set(record, visible);
    return visible;
  };
  const globals = records.filter((record) => record.global);

  return (definition, record) => {
    for (const dependency of getProviderDeps(definition.provider)) {
      if (dependency === undefined) continue;
      const dep = isLazyDependency(dependency) ? dependency.inner : dependency;
      const token = isNamedDependency(dep) ? names.lookup(dep.name) : isKeyedDependency(dep) ? dep.token : dep;
      if (!token) continue; // Missing dependencies retain their normal DI error.
      const key = isKeyedDependency(dep) ? dep.key : undefined;
      const owner = selected.get(token)?.get(key)
        ?? (typeof token !== "function" && token.genericFamilyId
          ? selectedFamilies.get(token.genericFamilyId)?.get(key) : undefined);
      if (!owner || owner === record) continue;
      if (record.imports.some((imported) => exportsOwner(imported, owner, token))
        || globals.some((global) => exportsOwner(global, owner, token))) continue;
      throw new ModuleEncapsulationError([
        `Module "${record.name}": "${tokenToDebugName(definition.provider.provide)}" selects "${tokenToDebugName(token)}"`
        + ` from module "${owner.name}", which is not exported to this consumer (key: ${String(key)}).`,
      ]);
    }
  };
}
