import { expandModuleMetadata, type BazisModuleRef } from "../../../di";
import { toolMetadataOf } from "../../../agent";
import { validateProcess } from "../../../../library/workflow";
import { WORKFLOW_CALLER } from "../../internal/WorkflowTools";
import { WorkflowDefinitionsModule } from "../WorkflowDefinitions.module";
import { definitionProblems, type OwnedCodeProcess } from "./codeProcesses";
import { isCodeProcess } from "./defineProcess";

/** What `bazis workflow check` reports for one process. */
export interface InspectedProcess extends OwnedCodeProcess {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ProcessInspection {
  readonly processes: readonly InspectedProcess[];
  /** Problems across processes: one key in two modules, a `processes` entry that is not a process. */
  readonly errors: readonly string[];
  /** Tools of the module tree that processes may call. */
  readonly tools: readonly string[];
}

/**
 * The processes and Tools of a module tree without building the application
 * (`bazis workflow check`): the checks of the build and of the start at once.
 */
export function inspectProcesses(root: BazisModuleRef): ProcessInspection {
  const found: OwnedCodeProcess[] = [];
  const errors: string[] = [];
  const tools = new Set<string>();
  const visited = new Set<BazisModuleRef>();
  const visit = (moduleRef: BazisModuleRef): void => {
    if (visited.has(moduleRef)) return;
    visited.add(moduleRef);
    const module = typeof moduleRef === "function" ? moduleRef.name || "<anonymous module>" : "<module>";
    const fields = moduleRef as { readonly processes?: unknown; readonly tools?: unknown };
    if (Array.isArray(fields.tools)) {
      for (const target of fields.tools) {
        const metadata = typeof target === "function" ? toolMetadataOf(target as new () => object) : undefined;
        if (metadata?.callers.includes(WORKFLOW_CALLER)) tools.add(metadata.name);
      }
    }
    if (fields.processes !== undefined) {
      if (!Array.isArray(fields.processes)) errors.push(`${module}: processes must be an array of defineProcess(...) results.`);
      else for (const process of fields.processes) {
        if (isCodeProcess(process)) found.push({ process, module });
        else errors.push(`${module}: processes must list defineProcess(...) results.`);
      }
    }
    for (const imported of moduleRef.imports ?? []) visit(imported);
    for (const expanded of expandModuleMetadata(moduleRef)) visit(expanded);
  };
  visit(root);
  if (found.length > 0 && !visited.has(WorkflowDefinitionsModule)) {
    errors.push(`${found[0]!.module} declares processes, but the application does not import WorkflowModule (bazis/core/workflow).`);
  }
  const owners = new Map<string, string>();
  for (const { process, module } of found) {
    const other = owners.get(process.key);
    if (other !== undefined) errors.push(`Process "${process.key}" is declared twice: in ${other} and in ${module}.`);
    else owners.set(process.key, module);
  }
  const allowed = (name: string) => tools.has(name);
  return {
    processes: found.map((entry) => ({
      ...entry,
      errors: definitionProblems(entry.process, allowed),
      warnings: validateProcess(entry.process.document, { tools: allowed }).filter((issue) => issue.severity === "warning")
        .map((issue) => `${issue.node !== undefined ? `node ${issue.node}: ` : issue.flow !== undefined ? `flow ${issue.flow}: ` : ""}${issue.message} (${issue.code})`),
    })),
    errors,
    tools: [...tools].sort(),
  };
}
