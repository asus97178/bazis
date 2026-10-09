import type { Token } from "../token";
import type { ServiceKey } from "../types";

/**
 * A single constructor/factory dependency, normalized once per provider so the
 * hot resolve path skips re-deriving the descriptor (named-token lookup, keyed
 * unwrapping) and the per-dependency object allocation on every resolution.
 *
 * `undefined` entries mean "leave this positional argument unset" (a ctor param
 * with a default value that should not be injected).
 */
export interface PlannedDependency {
  readonly token: Token<unknown>;
  readonly key: ServiceKey | undefined;
  readonly lazy: boolean;
  /** Resolve to `undefined` when the token has no registration. */
  readonly optional?: boolean;
}

export type ResolutionPlan = readonly (PlannedDependency | undefined)[];
