/**
 * The process document format `bazis.workflow/v2` (WORKFLOW-002 §3): types,
 * node kinds, validation, data paths and expressions, the upgrade from version 1
 * and the core of a designer. Pure functions without DI or a database: usable by
 * a designer, a CLI or a browser.
 */
export {
  PROCESS_SCHEMA_VERSION,
  emptyProcess,
  initialVarsOf,
  inputSpecOf,
  outputOf,
  type Bounds,
  type NodeKind,
  type Point,
  type ProcessDiagram,
  type ProcessDocument,
  type ProcessFlow,
  type ProcessLogSettings,
  type ProcessNode,
  type ProcessSettings,
} from "./ProcessDocument";
export { NODE_KINDS, nodeKindOf, ISO_DURATION, MAX_ITERATIONS, MAX_LOOP_PARALLEL, PROCESS_KEY, type JsonSchema, type NodeKindDefinition, type NodeRole } from "./nodeKinds";
export { PROCESS_LIMITS, validateProcess, hasErrors, type ProcessIssue, type ProcessIssueCode, type ValidateProcessOptions } from "./validateProcess";
export { DATA_PATH, DATA_PATHS, isPath, readPath, resolveInput, type InstanceData } from "./paths";
export {
  EXPRESSION_FUNCTIONS,
  EXPRESSION_LIMITS,
  checkExpression,
  checkPath,
  evaluateExpression,
  expressionFunction,
  isExpressionNode,
  isTruthy,
  type Expr,
  type ExprCall,
  type ExpressionScope,
  type ExprFunction,
  type ExprFunctionName,
  type ExprPath,
  type ExprType,
} from "./expressions";
export { ExpressionSyntaxError, parseExpression, printExpression } from "./expressionSyntax";
export { durationMs } from "./duration";
export { parseCron, type CronSchedule } from "./cron";
export { processToMermaid } from "./mermaid";
export { PERSONAL_MASK, maskByMapping, maskBySchema, masksPersonal, personalPaths, personalVariables, readsPersonal } from "./masking";
export { allTexts, checkLocalizedText, textOf, type LocalizedText } from "./localized";
export {
  FIELD_NAME,
  checkExtensions,
  checkFormSpec,
  formFieldNames,
  validateForm,
  variableProblems,
  type FieldType,
  type FormField,
  type FormIssue,
  type FormSpec,
  type VariableDirection,
  type VariableSpec,
} from "./formFields";
export { PROCESS_SCHEMA_VERSION_V1, upgradeCondition, upgradeDocument, type ConditionV1, type FormFieldV1, type ProcessDocumentV1 } from "./upgradeDocument";
export { fromStructure, isStructured, toStructure, type ProcessStructure, type StructureBoundary, type StructureBranch, type StructureStart, type StructureStep } from "./structure";
export { formOf, processPalette, type PaletteNodeKind, type PaletteTool, type ProcessPalette, type StepForm, type StepFormField } from "./palette";
