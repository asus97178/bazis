import type { Token } from "../../token";
import type { KeyedDependency } from "./KeyedDependency";
import type { Lazy, LazyDependency } from "./LazyDependency";
import type { NamedDependency } from "./NamedDependency";
import type { OptionalDependency } from "./OptionalDependency";

export type ResolvedDeps<
  D extends readonly (Token<unknown> | KeyedDependency<unknown> | NamedDependency<unknown> | LazyDependency<unknown> | OptionalDependency<unknown>)[],
> = {
  [K in keyof D]: D[K] extends LazyDependency<infer TResolvedLazy>
    ? Lazy<TResolvedLazy>
    : D[K] extends OptionalDependency<infer TResolvedOptional>
    ? TResolvedOptional | undefined
    : D[K] extends Token<infer TResolved>
      ? TResolved
      : D[K] extends KeyedDependency<infer TResolvedKeyed>
        ? TResolvedKeyed
        : D[K] extends NamedDependency<infer TResolvedNamed>
          ? TResolvedNamed
          : never;
};
