import type { LocalizedText, Scope } from "./types";

/**
 * Values of a reference kind (ACCESS-001 §6): what the administrator picks in a
 * condition («which tables», «which processes») and what a process checks for
 * `x-ref`. A module declares the kinds it owns in `@Module({ references })`;
 * the class is registered in its `providers` and resolved in the request scope.
 */
export abstract class References {
  /** Which of `ids` exist. */
  abstract exists(ids: readonly string[], context: ReferenceContext): Promise<ReadonlySet<string>>;

  /** Titles of `ids`; unknown ones are left out. */
  abstract describe(ids: readonly string[], context: ReferenceContext): Promise<readonly ReferenceItem[]>;

  /** Values whose title or id contains `text` (empty — all), page by page. */
  abstract search(text: string, context: ReferenceContext, page: ReferencePage): Promise<readonly ReferenceItem[]>;
}

export interface ReferenceItem {
  readonly id: string;
  readonly title: LocalizedText;
}

export interface ReferenceContext {
  readonly scope: Scope;
  readonly language?: string;
}

export interface ReferencePage {
  readonly limit: number;
  readonly offset: number;
}
