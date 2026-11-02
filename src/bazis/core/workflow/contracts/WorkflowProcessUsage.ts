/**
 * What the catalog asks before it deletes a process. Runtime answers: the catalog
 * knows nothing of instances, and without Runtime there are none.
 */
export abstract class WorkflowProcessUsage {
  /** How many `pending`, `running` and `failed` instances the process has. */
  abstract liveInstances(processKey: string): Promise<number>;
}
