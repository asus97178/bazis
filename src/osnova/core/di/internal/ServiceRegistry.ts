import { ModuleEncapsulationError } from "../errors";
import type { Provider, ProviderDefinition } from "../provider";
import type { Token } from "../token";
import type { ServiceKey } from "../types";
import { NamedTokenIndex } from "./NamedTokenIndex";
import type { OpenGenericRegistration } from "./OpenGenericRegistration";
import { ServiceRegistration } from "./ServiceRegistration";

/** Owns registration identity, keyed lookup and atomic open-generic materialization. */
export class ServiceRegistry {
  private readonly registrationsByToken = new Map<Token<unknown>, ServiceRegistration[]>();
  private readonly openGenericRegistrations = new Map<symbol, OpenGenericRegistration[]>();
  private readonly openGenericMaterializedKeys = new Map<Token<unknown>, Set<ServiceKey | undefined>>();
  // Cache successful registration selections, not resolved instances or missing keys.
  private lastSelections: WeakMap<
    readonly ServiceRegistration[], Map<ServiceKey | undefined, ServiceRegistration>
  > | undefined;
  private allSelections: WeakMap<
    readonly ServiceRegistration[], Map<ServiceKey | undefined, readonly ServiceRegistration[]>
  > | undefined;
  private readonly namedTokenIndex = new NamedTokenIndex(() => this.registrationsByToken.keys());
  private nextRegistrationId: number;

  public constructor(
    definitions: readonly ProviderDefinition[],
    openGenericRegistrations: readonly OpenGenericRegistration[],
  ) {
    this.nextRegistrationId = definitions.length;
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index] as ProviderDefinition;
      const token = definition.provider.provide;
      const registration = new ServiceRegistration(index, token, definition.provider, definition.lifetime, definition.key);
      const existing = this.registrationsByToken.get(token);
      if (existing) {
        existing.push(registration);
      } else {
        this.registrationsByToken.set(token, [registration]);
      }
    }

    for (let index = 0; index < openGenericRegistrations.length; index += 1) {
      const registration = openGenericRegistrations[index] as OpenGenericRegistration;
      const existing = this.openGenericRegistrations.get(registration.family.id);
      if (existing) {
        existing.push(registration);
      } else {
        this.openGenericRegistrations.set(registration.family.id, [registration]);
      }
    }
  }

  public groups(): Iterable<readonly ServiceRegistration[]> {
    return this.registrationsByToken.values();
  }

  public lookupName(name: string): Token<unknown> | undefined {
    return this.namedTokenIndex.lookup(name);
  }

  public all(token: Token<unknown>, key: ServiceKey | undefined): readonly ServiceRegistration[] {
    this.materializeOpenGenericRegistration(token, key, undefined);
    const registrations = this.registrationsByToken.get(token);
    if (!registrations) return [];
    if (registrations.length === 1) return registrations[0]!.key === key ? registrations : [];
    const cached = this.allSelections?.get(registrations)?.get(key);
    if (cached) return cached;
    let selected: readonly ServiceRegistration[] = registrations;
    // The usual single-key list can be consumed without copying it.
    for (const registration of registrations) {
      if (registration.key !== key) {
        selected = registrations.filter((entry) => entry.key === key);
        break;
      }
    }
    if (selected.length > 0) {
      this.allSelections ??= new WeakMap();
      let selections = this.allSelections.get(registrations);
      if (!selections) this.allSelections.set(registrations, selections = new Map());
      selections.set(key, selected);
    }
    return selected;
  }

  public find(token: Token<unknown>, key: ServiceKey | undefined): ServiceRegistration | undefined {
    const registrations = this.registrationsByToken.get(token);
    // Short lists use the direct scan; indexing pays off only for larger groups.
    const direct = registrations && registrations.length > 8
      ? this.findLastInGroup(registrations, key)
      : this.findLastRegistration(registrations, key);
    if (direct) {
      return direct;
    }
    // Miss: a closed generic may not be materialized yet. materialize is
    // idempotent and returns immediately for non-generic / already-done tokens.
    this.materializeOpenGenericRegistration(token, key, undefined);
    return this.findLastRegistration(this.registrationsByToken.get(token), key);
  }

  private findLastInGroup(
    registrations: readonly ServiceRegistration[],
    key: ServiceKey | undefined,
  ): ServiceRegistration | undefined {
    const last = registrations[registrations.length - 1]!;
    if (last.key === key && !last.fromOpenGeneric) return last;
    const cached = this.lastSelections?.get(registrations)?.get(key);
    if (cached) return cached;
    const selected = this.findLastRegistration(registrations, key);
    // Remember successful selections only; arbitrary missing keys must not grow this cache.
    if (selected) {
      this.lastSelections ??= new WeakMap();
      let selections = this.lastSelections.get(registrations);
      if (!selections) this.lastSelections.set(registrations, selections = new Map());
      selections.set(key, selected);
    }
    return selected;
  }

  private findLastRegistration(
    registrations: readonly ServiceRegistration[] | undefined,
    key: ServiceKey | undefined,
  ): ServiceRegistration | undefined {
    if (!registrations) {
      return undefined;
    }
    let genericFallback: ServiceRegistration | undefined;
    for (let index = registrations.length - 1; index >= 0; index -= 1) {
      const registration = registrations[index] as ServiceRegistration;
      if (registration.key === key) {
        // Explicit closed registrations retain priority even after resolveAll
        // materializes a family. Enumeration order remains unchanged.
        if (!registration.fromOpenGeneric) {
          return registration;
        }
        genericFallback ??= registration;
      }
    }
    return genericFallback;
  }

  public validateOpenGenerics(issues: Set<string>): void {
    const tokens = [...this.registrationsByToken.keys()];
    for (const openRegistrations of this.openGenericRegistrations.values()) {
      for (let index = 0; index < openRegistrations.length; index += 1) {
        const openRegistration = openRegistrations[index] as OpenGenericRegistration;
        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
          const argToken = tokens[tokenIndex] as Token<unknown>;
          // Closed generic tokens are not valid generic arguments here:
          // skipping them avoids materializing nested noise like Repo<Repo<T>>.
          if (typeof argToken !== "function" && argToken.genericFamilyId) {
            continue;
          }
          const closedToken = openRegistration.family.of(argToken);
          this.materializeOpenGenericRegistration(closedToken, openRegistration.key, issues);
        }
      }
    }
  }

  private materializeOpenGenericRegistration(
    token: Token<unknown>,
    key: ServiceKey | undefined,
    issues: Set<string> | undefined,
  ): void {
    if (typeof token === "function") {
      return;
    }
    const familyId = token.genericFamilyId;
    const argumentToken = token.genericArgToken;
    if (!familyId || !argumentToken) {
      return;
    }
    const registrations = this.openGenericRegistrations.get(familyId);
    if (!registrations || registrations.length === 0) {
      return;
    }

    if (this.isOpenGenericMaterialized(token, key)) {
      return;
    }

    const staged: Array<{ readonly registration: OpenGenericRegistration; readonly provider: Provider<unknown> }> = [];
    for (let index = 0; index < registrations.length; index += 1) {
      const registration = registrations[index] as OpenGenericRegistration;
      if (registration.key !== key) {
        continue;
      }

      let provider: Provider<unknown>;
      try {
        provider = registration.providerFactory(argumentToken);
      } catch (error) {
        // Module visibility is a separate contract, including during eager
        // graph validation. Keep the same diagnostic as ordinary providers.
        if (error instanceof ModuleEncapsulationError) {
          throw error;
        }
        if (issues) {
          const message = error instanceof Error ? error.message : String(error);
          issues.add(`Open generic "${token.description}" factory failed: ${message}`);
          continue;
        }
        throw error;
      }
      staged.push({ registration, provider });
    }

    if (issues && staged.length !== registrations.filter((registration) => registration.key === key).length) {
      return;
    }

    const closedRegistrations = staged.map(
      ({ registration, provider }, index) => new ServiceRegistration(
        this.nextRegistrationId + index,
        token,
        provider,
        registration.lifetime,
        registration.key,
        true,
      ),
    );
    this.nextRegistrationId += closedRegistrations.length;
    const existing = this.registrationsByToken.get(token);
    if (existing) {
      existing.push(...closedRegistrations);
      if (closedRegistrations.length > 0) {
        this.lastSelections?.delete(existing);
        this.allSelections?.delete(existing);
      }
    } else if (closedRegistrations.length > 0) {
      this.registrationsByToken.set(token, closedRegistrations);
      this.namedTokenIndex.index(token);
    }
    this.markOpenGenericMaterialized(token, key);
  }

  private isOpenGenericMaterialized(token: Token<unknown>, key: ServiceKey | undefined): boolean {
    const materializedKeys = this.openGenericMaterializedKeys.get(token);
    if (!materializedKeys) {
      return false;
    }
    return materializedKeys.has(key);
  }

  private markOpenGenericMaterialized(token: Token<unknown>, key: ServiceKey | undefined): void {
    let materializedKeys = this.openGenericMaterializedKeys.get(token);
    if (!materializedKeys) {
      materializedKeys = new Set<ServiceKey | undefined>();
      this.openGenericMaterializedKeys.set(token, materializedKeys);
    }
    materializedKeys.add(key);
  }
}
