import type { LocalizedText, ProcessDocument } from "../../../../library/workflow";

const CODE_PROCESS = Symbol.for("bazis/core/workflow/code-process");

/** What `defineProcess` takes: the catalog fields of the process and its document. */
export interface ProcessDefinition {
  /** The key it is started by: `^[a-z][a-z0-9_.-]{0,63}$`. */
  readonly key: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText | null;
  /** A path in the catalog: `Sales/Orders`. */
  readonly folder?: string | null;
  /** Whose process it is: an opaque id. */
  readonly owner?: string | null;
  /** Days to keep completed and cancelled instances; omitted keeps them. */
  readonly retentionDays?: number | null;
  readonly document: ProcessDocument;
}

/** A process described in code: listed in `@Module({ processes })` and published at start (WORKFLOW-001 §14). */
export interface CodeProcess extends ProcessDefinition {
  readonly [CODE_PROCESS]: true;
}

/**
 * Describes a process in the code of the module that owns it. It is only a
 * description: checks happen when the container is built and at start.
 *
 * ```ts
 * // orders_module/processes/OrderApproval.process.ts
 * export const OrderApprovalProcess = defineProcess({
 *   key: "order-approval",
 *   title: "Order approval",
 *   document: { schemaVersion: "bazis.workflow/v2", nodes: { … }, flows: { … } },
 * });
 * ```
 *
 * A document of version 1 goes through `upgradeDocument`.
 */
export function defineProcess(definition: ProcessDefinition): CodeProcess {
  return Object.freeze({ ...definition, [CODE_PROCESS]: true as const });
}

export function isCodeProcess(value: unknown): value is CodeProcess {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[CODE_PROCESS] === true;
}
