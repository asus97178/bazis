/**
 * Business processes without a UI (WORKFLOW-001): the composite `WorkflowModule`
 * with the Definitions and Runtime parts, their services, HTTP, events and
 * extension points. The document format is `bazis/library/workflow`.
 */
export { WorkflowModule } from "./Workflow.module";
export { WorkflowDefinitionsModule } from "./definitions_module/WorkflowDefinitions.module";
export { WorkflowRuntimeModule } from "./runtime_module/WorkflowRuntime.module";
export {
  IWorkflowDefinitions,
  type CreateProcess,
  type ProcessDetails,
  type ProcessListQuery,
  type ProcessSummary,
  type UpdateProcess,
  type VersionDetails,
  type VersionSummary,
} from "./definitions_module/services/IWorkflowDefinitions.service";
export {
  IWorkflowRuntime,
  type HistoryEntry,
  type InstanceDetails,
  type InstanceListQuery,
  type InstanceSummary,
  type StartInstance,
  type TokenDetails,
} from "./runtime_module/services/IWorkflowRuntime.service";
export {
  WORKFLOW_INSTANCE_FINISHED,
  WORKFLOW_TASK_REQUESTED,
  WORKFLOW_TOKEN_CLOSED,
  type WorkflowInstanceFinished,
  type WorkflowTaskRequested,
  type WorkflowTokenClosed,
} from "./runtime_module/events/Runtime.events";
export { workflowRuntimeConfig } from "./runtime_module/config/Runtime.config";
export type { HistoryType } from "./runtime_module/model/WfHistory.model";
export type { InstanceStatus, StartedVia } from "./runtime_module/model/WfInstance.model";
export type { TokenStatus } from "./runtime_module/model/WfToken.model";
export { WorkflowAccess, DenyWorkflowAccess, type WorkflowAccessTarget, type WorkflowAction } from "./access/WorkflowAccess";
export { WorkflowInputValidator, DefaultWorkflowInputValidator, type WorkflowInputContext } from "./contracts/WorkflowInputValidator";
export { WorkflowError, type WorkflowErrorCode } from "./contracts/WorkflowError";
export type { WorkflowActor, WorkflowPage, WorkflowPaging } from "./contracts/types";
