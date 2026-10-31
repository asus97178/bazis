/**
 * The process document format `bazis.workflow/v1` (WORKFLOW-001 §2): types,
 * node kinds, validation, data paths and conditions. Pure functions without DI
 * or a database: usable by a designer, a CLI or a browser.
 */
export {
  PROCESS_SCHEMA_VERSION,
  emptyProcess,
  type Bounds,
  type Condition,
  type ConditionOp,
  type NodeKind,
  type Point,
  type ProcessDiagram,
  type ProcessDocument,
  type ProcessFlow,
  type ProcessNode,
} from "./ProcessDocument";
export { NODE_KINDS, nodeKindOf, ISO_DURATION, type NodeKindDefinition, type NodeRole } from "./nodeKinds";
export { PROCESS_LIMITS, validateProcess, hasErrors, type ProcessIssue, type ProcessIssueCode, type ValidateProcessOptions } from "./validateProcess";
export { DATA_PATH, isPath, readPath, resolveInput, type InstanceData } from "./paths";
export { evaluateCondition } from "./conditions";
export { durationMs } from "./duration";
export { parseCron, type CronSchedule } from "./cron";
export { checkFormSpec, formFieldCodes, validateForm, type FormField, type FormFieldType, type FormIssue, type FormSpec } from "./formFields";
