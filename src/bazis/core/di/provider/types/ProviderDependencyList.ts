import type { Token } from "../../token";
import type { KeyedDependency } from "./KeyedDependency";
import type { LazyDependency } from "./LazyDependency";
import type { NamedDependency } from "./NamedDependency";

export type ProviderDependencyList = readonly (
  | Token<unknown>
  | KeyedDependency<unknown>
  | NamedDependency<unknown>
  | LazyDependency<unknown>
)[];
