import { HttpError } from "../../http";
import type { FormIssue, ProcessIssue } from "../../../library/workflow";

export type WorkflowErrorCode = "not_found" | "conflict" | "wrong_status" | "invalid_document" | "invalid_input" | "archived";

const STATUS: Readonly<Record<WorkflowErrorCode, number>> = {
  not_found: 404,
  conflict: 409,
  wrong_status: 409,
  archived: 409,
  invalid_document: 422,
  invalid_input: 422,
};

/**
 * An error of the workflow services. Code and HTTP status in one: the
 * framework's controllers throw it as is, the response is
 * `{ error, details: { code, issues? } }`.
 */
export class WorkflowError extends HttpError {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
    readonly issues?: readonly (ProcessIssue | FormIssue)[],
  ) {
    super(STATUS[code], message, issues === undefined ? { code } : { code, issues });
  }
}
