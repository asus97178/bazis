import { validateForm, type FormIssue, type FormSpec } from "../../../library/workflow";
import type { WorkflowPortContext } from "./WorkflowExtensions";

/** What a value is checked for: a process input or a task form. */
export interface WorkflowInputContext extends WorkflowPortContext {
  readonly purpose: "input" | "task";
  readonly processKey: string;
}

/**
 * Checks a process input and task forms against their fields (WORKFLOW-002 §3.4):
 * a field carries the application's rules in `extensions`. The default checks the
 * types; an application with its own field rules registers its implementation of
 * this class in any module.
 */
export abstract class WorkflowInputValidator {
  abstract validate(spec: FormSpec | undefined, value: unknown, context: WorkflowInputContext): { readonly value: Record<string, unknown>; readonly issues: readonly FormIssue[] } | Promise<{ readonly value: Record<string, unknown>; readonly issues: readonly FormIssue[] }>;
}

/** The built-in field check. */
export class DefaultWorkflowInputValidator extends WorkflowInputValidator {
  validate(spec: FormSpec | undefined, value: unknown): { readonly value: Record<string, unknown>; readonly issues: readonly FormIssue[] } {
    return validateForm(spec, value);
  }
}
