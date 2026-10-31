import { Module } from "../di";
import { WorkflowDefinitionsModule } from "./definitions_module/WorkflowDefinitions.module";
import { IWorkflowDefinitions } from "./definitions_module/services/IWorkflowDefinitions.service";
import { WorkflowRuntimeModule } from "./runtime_module/WorkflowRuntime.module";
import { IWorkflowRuntime } from "./runtime_module/services/IWorkflowRuntime.service";
import { WorkflowTasksModule } from "./tasks_module/WorkflowTasks.module";
import { IWorkflowTasks } from "./tasks_module/services/IWorkflowTasks.service";

/**
 * Business processes (WORKFLOW-001): the pack only assembles its parts
 * ([passport](MODULE.md)). An application imports it, or only the parts it needs.
 */
@Module({
  imports: [WorkflowDefinitionsModule, WorkflowRuntimeModule, WorkflowTasksModule],
  exports: [IWorkflowDefinitions, IWorkflowRuntime, IWorkflowTasks],
})
export class WorkflowModule {}
