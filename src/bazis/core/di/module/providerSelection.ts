import { ModuleEncapsulationError } from "../errors";
import { getProviderDeps } from "../internal/providerDeps";
import { NamedTokenIndex } from "../internal/NamedTokenIndex";
import type { OpenGenericRegistration } from "../internal/OpenGenericRegistration";
import { isKeyedDependency, isLazyDependency, isNamedDependency, isOptionalDependency, type ProviderDefinition } from "../provider";
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
  // Every module that registers a token (in registration order): the error names them all.
  const registeredBy = new Map<Token<unknown>, Map<ServiceKey | undefined, ModuleGraphRecord[]>>();
  for (const definition of definitions) {
    const owner = recordOf.get(definition);
    if (!owner) continue;
    const token = definition.provider.provide;
    const keys = selected.get(token) ?? new Map();
    keys.set(definition.key, owner);
    selected.set(token, keys);
    const ownersByKey = registeredBy.get(token) ?? new Map<ServiceKey | undefined, ModuleGraphRecord[]>();
    const owners = ownersByKey.get(definition.key) ?? [];
    if (!owners.includes(owner)) owners.push(owner);
    ownersByKey.set(definition.key, owners);
    registeredBy.set(token, ownersByKey);
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
      const dep = isLazyDependency(dependency) || isOptionalDependency(dependency) ? dependency.inner : dependency;
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
        selectionMessage(record, tokenToDebugName(definition.provider.provide), tokenToDebugName(token), key, owner,
          registeredBy.get(token)?.get(key) ?? [owner]),
      ]);
    }
  };
}

/**
 * Explains a selection the consumer cannot see. The usual cause: the token is
 * registered in several modules, and the whole application uses the last
 * registration, which comes from a module the consumer does not import.
 */
function selectionMessage(
  record: ModuleGraphRecord,
  consumer: string,
  token: string,
  key: ServiceKey | undefined,
  owner: ModuleGraphRecord,
  owners: readonly ModuleGraphRecord[],
): string {
  const subject = key === undefined ? `"${token}"` : `"${token}" with key ${JSON.stringify(String(key))}`;
  const head = `Module "${record.name}": "${consumer}" depends on ${subject}`;
  if (owners.length > 1) {
    const modules = owners.map((item) => `"${item.name}"`).join(" and ");
    // No colon after "token": the console redaction would read "token: the" as a secret.
    return `${head}, but ${subject} is registered in ${modules}, and the application uses one implementation per token,`
      + ` the last registered one, from "${owner.name}", which "${record.name}" cannot see.`
      + ` Register ${subject} in one module, or give the implementations different keys (DI.keyedSingleton).`;
  }
  return `${head}, but the application uses the implementation from "${owner.name}", which "${record.name}" cannot see.`
    + ` Add "${owner.name}" to the imports of "${record.name}" and export ${subject} from it.`;
}
