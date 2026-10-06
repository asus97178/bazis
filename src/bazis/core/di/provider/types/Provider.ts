import type { AsyncFactoryProvider } from "./AsyncFactoryProvider";
import type { ClassProvider } from "./ClassProvider";
import type { FactoryProvider } from "./FactoryProvider";
import type { ValueProvider } from "./ValueProvider";

export type Provider<T = unknown> =
  | ClassProvider<T, any>
  | FactoryProvider<T, any>
  | AsyncFactoryProvider<T, any>
  | ValueProvider<T>;
