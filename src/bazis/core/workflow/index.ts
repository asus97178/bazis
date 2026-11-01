/**
 * Business processes without a UI (WORKFLOW-001): the composite `WorkflowModule`
 * with the Definitions and Runtime parts, their services, HTTP, events and
 * extension points. The document format is `bazis/library/workflow`.
 */
import type { CodeProcess } from "./definitions_module/code/defineProcess";
import "./generated/deps";

export { WorkflowModule } from "./Workflow.module";
export { defineProcess, type CodeProcess, type ProcessDefinition } from "./definitions_module/code/defineProcess";
export { WorkflowSetupError } from "./definitions_module/code/codeProcesses";
export { WorkflowClock, SystemWorkflowClock } from "./contracts/WorkflowClock";
export { WorkflowDefinitionsModule } from "./definitions_module/WorkflowDefinitions.module";
export { WorkflowRuntimeModule } from "./runtime_module/WorkflowRuntime.module";
export { WorkflowTasksModule } from "./tasks_module/WorkflowTasks.module";
export { IWorkflowTasks, type TaskDetails, type TaskListQuery } from "./tasks_module/services/IWorkflowTasks.service";
export { WORKFLOW_TASK_COMPLETED, type WorkflowTaskCompleted } from "./tasks_module/events/Tasks.events";
export { WORKFLOW_PROCESS_CHANGED, type ProcessChange, type WorkflowProcessChanged } from "./definitions_module/events/Definitions.events";
export type { TaskStatus } from "./tasks_module/model/WfTask.model";
export {
  IWorkflowDefinitions,
  type CreateProcess,
  type ProcessDetails,
  type ProcessListQuery,
  type ProcessSummary,
  type SavedDraft,
  type SaveDraftOptions,
  type UpdateProcess,
  type VersionDetails,
  type VersionSummary,
} from "./definitions_module/services/IWorkflowDefinitions.service";
export {
  IWorkflowRuntime,
  type CancelInstance,
  type EmitOptions,
  type EmitResult,
  type HistoryEntry,
  type InstanceDetails,
  type InstanceListQuery,
  type InstanceSummary,
  type RetryInstance,
  type StartInstance,
  type TokenDetails,
} from "./runtime_module/services/IWorkflowRuntime.service";
export {
  WORKFLOW_INSTANCE_CANCELLED,
  WORKFLOW_INSTANCE_FINISHED,
  WORKFLOW_INSTANCE_RETRIED,
  WORKFLOW_INSTANCE_STARTED,
  WORKFLOW_INSTANCES_DELETED,
  WORKFLOW_TASK_REQUESTED,
  WORKFLOW_TOKEN_CLOSED,
  type WorkflowInstanceCancelled,
  type WorkflowInstanceFinished,
  type WorkflowInstanceRetried,
  type WorkflowInstanceStarted,
  type WorkflowInstancesDeleted,
  type WorkflowTaskRequested,
  type WorkflowTokenClosed,
} from "./runtime_module/events/Runtime.events";
export { workflowRuntimeConfig } from "./runtime_module/config/Runtime.config";
export type { HistoryType } from "./runtime_module/model/WfHistory.model";
export type { InstanceStatus, StartedVia } from "./runtime_module/model/WfInstance.model";
export type { TokenStatus } from "./runtime_module/model/WfToken.model";
export { WorkflowInputValidator, DefaultWorkflowInputValidator, type WorkflowInputContext } from "./contracts/WorkflowInputValidator";
export { WorkflowError, type WorkflowErrorCode } from "./contracts/WorkflowError";
export type { WorkflowActor, WorkflowAuditOptions, WorkflowPage, WorkflowPaging, WorkflowRequest, WorkflowToolMetadata } from "./contracts/types";

// Augment the declaring file, not the "../di" re-export: re-export targets
// depend on program file order and silently stop merging in some projects.
declare module "../di/module/types/BazisModule" {
  interface BazisModuleMetadata {
    /** Processes of the module, from `defineProcess`: published at start (WORKFLOW-001 §14). */
    readonly processes?: readonly CodeProcess[];
  }
}
