import { validateForm, type FormIssue, type FormSpec } from "../../../library/workflow";

/** What a value is checked for: a process input or a task form. */
export interface WorkflowInputContext {
  readonly purpose: "input" | "task";
  readonly processKey: string;
  readonly partition: string | null;
}

/**
 * Checks a process input and task forms against their fields (WORKFLOW-001 §9).
 * The default checks the types of `bazis.workflow/v1`; an application with its
 * own field rules registers its implementation of this class in any module.
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
