import type { WorkflowActor } from "./types";

/** What every port of the pack learns about the call (WORKFLOW-002 §6). */
export interface WorkflowPortContext {
  readonly partition: string | null;
  /** The language of the request; `workflow.language` for events, schedules and the background. */
  readonly language: string;
  /** `null` for a call from code. */
  readonly actor: WorkflowActor | null;
}

/** Where the `extensions` are: a node, a variable, or neither for the root of the document. */
export interface ExtensionTarget {
  readonly node?: string;
  readonly variable?: string;
}

/**
 * Checks the application's data in a document (WORKFLOW-002 §3.1) when a draft
 * is saved and a version is published: the application lists its namespaces and
 * registers its implementation in any module. A namespace nobody checks is an
 * error. A published version with such a key still runs: the engine does not
 * read `extensions`, so a removed module does not break live processes.
 */
export abstract class WorkflowExtensions {
  abstract namespaces(): readonly string[];
  /** Every problem of `value`, the data of one namespace at one place. */
  abstract check(namespace: string, value: unknown, target: ExtensionTarget, context: WorkflowPortContext): readonly string[] | Promise<readonly string[]>;
}

/** By default there are no namespaces. */
export class DefaultWorkflowExtensions extends WorkflowExtensions {
  namespaces(): readonly string[] {
    return [];
  }

  check(): readonly string[] {
    return [];
  }
}
