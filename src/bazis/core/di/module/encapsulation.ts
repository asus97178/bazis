import { ModuleEncapsulationError } from "../errors";
import { getProviderDeps } from "../internal/providerDeps";
import type { ProviderDefinition, ProviderDependencyList } from "../provider";
import { isKeyedDependency, isLazyDependency, isNamedDependency } from "../provider";
import type { OpenGenericTokenFamily, Token } from "../token";
import { tokenToDebugName } from "../token";
import { applyNamedDependencyEncapsulationHooks } from "./encapsulationHooks";
import type { ModuleExport } from "./types";

/**
 * Build-time module graph record. Collected by `createContainer` while
 * loading modules; consumed by `validateModuleEncapsulation`.
 */
export interface ModuleGraphRecord {
  readonly name: string;
  readonly imports: ModuleGraphRecord[];
  /** undefined — the module is fully open; otherwise the explicit export list. */
  readonly exports: readonly ModuleExport[] | undefined;
  /** Global module: exported tokens are visible everywhere without imports. */
  readonly global: boolean;
  readonly providedTokens: Set<Token<unknown>>;
  readonly providedFamilies: Set<symbol>;
  readonly definitions: ProviderDefinition[];
}

/**
 * Validates that every provider's dependencies are visible to its module:
 * a module sees its own providers plus whatever its direct imports export.
 * Open modules (no `exports` field) transitively expose everything they see,
 * which keeps pre-encapsulation code working unchanged.
 *
 * Runs once at container build time and returns a checker for providers
 * materialized later by an open generic factory. Visibility is computed once;
 * cached service resolution does not repeat validation.
 */
export function validateModuleEncapsulation(
  records: readonly ModuleGraphRecord[],
): (definition: ProviderDefinition, record: ModuleGraphRecord) => void {
  if (!hasClosedModules(records)) {
    return () => {};
  }

  const issues: string[] = [];
  const tokensByName = collectTokensByName(records);
  const allProvidedTokens = new Set<Token<unknown>>();
  const allProvidedFamilies = new Set<symbol>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as ModuleGraphRecord;
    for (const token of record.providedTokens) {
      allProvidedTokens.add(token);
    }
    for (const familyId of record.providedFamilies) {
      allProvidedFamilies.add(familyId);
    }
  }
  const exportedTokensMemo = new Map<ModuleGraphRecord, Set<Token<unknown>>>();
  const exportedFamiliesMemo = new Map<ModuleGraphRecord, Set<symbol>>();
  const visiting = new Set<ModuleGraphRecord>();

  const exportedTokens = (record: ModuleGraphRecord): Set<Token<unknown>> => {
    const memoized = exportedTokensMemo.get(record);
    if (memoized) {
      return memoized;
    }
    if (visiting.has(record)) {
      return new Set();
    }
    visiting.add(record);

    const result = new Set<Token<unknown>>();
    if (record.exports === undefined) {
      for (const token of record.providedTokens) {
        result.add(token);
      }
      for (let index = 0; index < record.imports.length; index += 1) {
        for (const token of exportedTokens(record.imports[index] as ModuleGraphRecord)) {
          result.add(token);
        }
      }
    } else {
      const visible = visibleTokens(record);
      for (let index = 0; index < record.exports.length; index += 1) {
        const ref = record.exports[index] as ModuleExport;
        if (isFamilyExport(ref)) {
          continue;
        }
        if (record.providedTokens.has(ref) || visible.has(ref)) {
          result.add(ref);
        } else {
          issues.push(
            `Module "${record.name}" exports "${tokenToDebugName(ref)}" which it neither provides nor imports.`,
          );
        }
      }
    }

    visiting.delete(record);
    exportedTokensMemo.set(record, result);
    return result;
  };

  const visibleTokens = (record: ModuleGraphRecord): Set<Token<unknown>> => {
    const result = new Set<Token<unknown>>(record.providedTokens);
    for (let index = 0; index < record.imports.length; index += 1) {
      for (const token of exportedTokens(record.imports[index] as ModuleGraphRecord)) {
        result.add(token);
      }
    }
    return result;
  };

  const exportedFamilies = (record: ModuleGraphRecord): Set<symbol> => {
    const memoized = exportedFamiliesMemo.get(record);
    if (memoized) {
      return memoized;
    }
    if (visiting.has(record)) {
      return new Set();
    }
    visiting.add(record);

    const result = new Set<symbol>();
    if (record.exports === undefined) {
      for (const familyId of record.providedFamilies) {
        result.add(familyId);
      }
      for (let index = 0; index < record.imports.length; index += 1) {
        for (const familyId of exportedFamilies(record.imports[index] as ModuleGraphRecord)) {
          result.add(familyId);
        }
      }
    } else {
      for (let index = 0; index < record.exports.length; index += 1) {
        const ref = record.exports[index] as ModuleExport;
        if (isFamilyExport(ref)) {
          result.add(ref.id);
        }
      }
    }

    visiting.delete(record);
    exportedFamiliesMemo.set(record, result);
    return result;
  };

  const visibleFamilies = (record: ModuleGraphRecord): Set<symbol> => {
    const result = new Set<symbol>(record.providedFamilies);
    for (let index = 0; index < record.imports.length; index += 1) {
      for (const familyId of exportedFamilies(record.imports[index] as ModuleGraphRecord)) {
        result.add(familyId);
      }
    }
    return result;
  };

  // Global modules (kernel infrastructure) are visible to everyone without an
  // explicit import, mirroring NestJS @Global().
  const globalTokens = new Set<Token<unknown>>();
  const globalFamilies = new Set<symbol>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as ModuleGraphRecord;
    if (!record.global) {
      continue;
    }
    for (const token of exportedTokens(record)) {
      globalTokens.add(token);
    }
    for (const familyId of exportedFamilies(record)) {
      globalFamilies.add(familyId);
    }
  }

  // Why a provided token is not visible: the owner does not export it, or the
  // consumer module does not import the owner. Both used to read "not exported".
  const explainHidden = (token: Token<unknown>, consumer: ModuleGraphRecord): string => {
    const owner = records.find((record) => record !== consumer && record.providedTokens.has(token));
    if (owner === undefined) return "which is provided by another module but not exported.";
    return exportedTokens(owner).has(token)
      ? `which module "${owner.name}" exports, but "${consumer.name}" does not list "${owner.name}" in its imports. Add "${owner.name}" to the imports of "${consumer.name}".`
      : `which module "${owner.name}" provides but does not export. Add it to the exports of "${owner.name}".`;
  };

  const contexts = new Map<ModuleGraphRecord, DependencyCheckContext>();
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex] as ModuleGraphRecord;
    const visible = visibleTokens(record);
    const familiesVisible = visibleFamilies(record);
    for (const token of globalTokens) {
      visible.add(token);
    }
    for (const familyId of globalFamilies) {
      familiesVisible.add(familyId);
    }

    const context: DependencyCheckContext = {
      visible, familiesVisible, tokensByName, allProvidedTokens, allProvidedFamilies, issues, explainHidden,
    };
    contexts.set(record, context);
    for (const definition of record.definitions) {
      checkDefinition(record, definition, context);
    }
  }

  if (issues.length > 0) {
    throw new ModuleEncapsulationError(issues);
  }
  return (definition, record) => {
    const context = contexts.get(record);
    if (!context) {
      return;
    }
    const materializedIssues: string[] = [];
    checkDefinition(record, definition, { ...context, issues: materializedIssues });
    if (materializedIssues.length > 0) {
      throw new ModuleEncapsulationError(materializedIssues);
    }
  };
}

interface DependencyCheckContext {
  readonly visible: ReadonlySet<Token<unknown>>;
  readonly familiesVisible: ReadonlySet<symbol>;
  readonly tokensByName: ReadonlyMap<string, Token<unknown>[]>;
  readonly allProvidedTokens: ReadonlySet<Token<unknown>>;
  readonly allProvidedFamilies: ReadonlySet<symbol>;
  readonly issues: string[];
  readonly explainHidden: (token: Token<unknown>, consumer: ModuleGraphRecord) => string;
}

function checkDefinition(
  record: ModuleGraphRecord,
  definition: ProviderDefinition,
  context: DependencyCheckContext,
): void {
  for (const dependency of getProviderDeps(definition.provider)) {
    if (dependency !== undefined) {
      checkDependency(record, definition, dependency, context);
    }
  }
}

function checkDependency(
  record: ModuleGraphRecord,
  definition: ProviderDefinition,
  dep: NonNullable<ProviderDependencyList[number]>,
  context: DependencyCheckContext,
): void {
  const consumer = tokenToDebugName(definition.provider.provide);

  // Laziness changes "when" a dependency is created, not "whether" the module
  // may see it — validate the inner descriptor with the same rules.
  if (isLazyDependency(dep)) {
    checkDependency(record, definition, dep.inner, context);
    return;
  }

  if (isNamedDependency(dep)) {
    if (
      applyNamedDependencyEncapsulationHooks({
        depName: dep.name,
        consumer,
        moduleName: record.name,
        visible: context.visible,
        familiesVisible: context.familiesVisible,
      })
    ) {
      return;
    }
    const candidates = context.tokensByName.get(dep.name);
    // No candidates at all is a missing-dependency problem, not encapsulation.
    if (!candidates || candidates.length === 0) {
      return;
    }
    for (let index = 0; index < candidates.length; index += 1) {
      if (context.visible.has(candidates[index] as Token<unknown>)) {
        return;
      }
    }
    const provided = candidates.find((candidate) => context.allProvidedTokens.has(candidate as Token<unknown>)) as Token<unknown> | undefined;
    context.issues.push(
      `Module "${record.name}": "${consumer}" depends on "${dep.name}", ${provided ? context.explainHidden(provided, record) : "which is provided by another module but not exported."}`,
    );
    return;
  }

  const token = isKeyedDependency(dep) ? dep.token : dep;
  if (typeof token !== "function" && token.genericFamilyId) {
    if (context.visible.has(token)) {
      return;
    }
    // Unknown family is a missing-registration problem, not encapsulation.
    if (
      context.allProvidedFamilies.has(token.genericFamilyId) &&
      !context.familiesVisible.has(token.genericFamilyId)
    ) {
      context.issues.push(
        `Module "${record.name}": "${consumer}" depends on open generic "${tokenToDebugName(token)}", whose family is not exported by any imported module.`,
      );
    }
    return;
  }

  // Missing tokens are reported by validateOnBuild / resolve, not here.
  if (!context.allProvidedTokens.has(token) || context.visible.has(token)) {
    return;
  }
  context.issues.push(
    `Module "${record.name}": "${consumer}" depends on "${tokenToDebugName(token)}", ${context.explainHidden(token, record)}`,
  );
}

function collectTokensByName(records: readonly ModuleGraphRecord[]): Map<string, Token<unknown>[]> {
  const result = new Map<string, Token<unknown>[]>();
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex] as ModuleGraphRecord;
    for (const token of record.providedTokens) {
      const name = tokenToDebugName(token);
      const existing = result.get(name);
      if (existing) {
        if (!existing.includes(token)) {
          existing.push(token);
        }
      } else {
        result.set(name, [token]);
      }
    }
  }
  return result;
}

function hasClosedModules(records: readonly ModuleGraphRecord[]): boolean {
  for (let index = 0; index < records.length; index += 1) {
    if ((records[index] as ModuleGraphRecord).exports !== undefined) {
      return true;
    }
  }
  return false;
}

export function isFamilyExport(ref: ModuleExport): ref is OpenGenericTokenFamily<unknown, unknown> {
  return typeof ref === "object" && ref !== null && "of" in ref && typeof (ref as { of: unknown }).of === "function";
}

/**
 * Effective set of tokens visible to each module: its own providers, the tokens
 * exported (transitively, with re-export) by its direct imports, plus everything
 * exported by global modules. Same visibility semantics as
 * {@link validateModuleEncapsulation}, but computed for *every* graph (including
 * the fully-open default) and without issue reporting — validation has already
 * run by the time this is consumed. Powers module-scoped named-dependency
 * resolution (see `bindModuleScopedNames`).
 */
export function computeModuleVisibleTokens(
  records: readonly ModuleGraphRecord[],
): Map<ModuleGraphRecord, Set<Token<unknown>>> {
  const exportedMemo = new Map<ModuleGraphRecord, Set<Token<unknown>>>();
  const visiting = new Set<ModuleGraphRecord>();

  const visibleOf = (record: ModuleGraphRecord): Set<Token<unknown>> => {
    const result = new Set<Token<unknown>>(record.providedTokens);
    for (let index = 0; index < record.imports.length; index += 1) {
      for (const token of exported(record.imports[index] as ModuleGraphRecord)) {
        result.add(token);
      }
    }
    return result;
  };

  const exported = (record: ModuleGraphRecord): Set<Token<unknown>> => {
    const memoized = exportedMemo.get(record);
    if (memoized) {
      return memoized;
    }
    if (visiting.has(record)) {
      return new Set();
    }
    visiting.add(record);

    const result = new Set<Token<unknown>>();
    if (record.exports === undefined) {
      for (const token of record.providedTokens) {
        result.add(token);
      }
      for (let index = 0; index < record.imports.length; index += 1) {
        for (const token of exported(record.imports[index] as ModuleGraphRecord)) {
          result.add(token);
        }
      }
    } else {
      const visible = visibleOf(record);
      for (let index = 0; index < record.exports.length; index += 1) {
        const ref = record.exports[index] as ModuleExport;
        if (isFamilyExport(ref)) {
          continue;
        }
        if (record.providedTokens.has(ref) || visible.has(ref)) {
          result.add(ref);
        }
      }
    }

    visiting.delete(record);
    exportedMemo.set(record, result);
    return result;
  };

  const globalTokens = new Set<Token<unknown>>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as ModuleGraphRecord;
    if (!record.global) {
      continue;
    }
    for (const token of exported(record)) {
      globalTokens.add(token);
    }
  }

  const result = new Map<ModuleGraphRecord, Set<Token<unknown>>>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as ModuleGraphRecord;
    const visible = visibleOf(record);
    for (const token of globalTokens) {
      visible.add(token);
    }
    result.set(record, visible);
  }
  return result;
}
