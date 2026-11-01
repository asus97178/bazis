import {
  createModuleOwnedMetadataChannel,
  registerModuleOwnedContributionValidator,
  registerModuleOwnedProviderContributor,
  DiContainer,
  type BazisModuleMetadata,
  type ServiceProvider,
} from "../../../di";
import { checkLocalizedText, validateProcess, type ProcessIssue } from "../../../../library/workflow";
import { IWorkflowDefinitions } from "../services/IWorkflowDefinitions.service";
import { isCodeProcess, type CodeProcess } from "./defineProcess";

/** A process of `@Module({ processes })` with the module that declares it. */
export interface OwnedCodeProcess {
  readonly process: CodeProcess;
  readonly module: string;
}

const PROCESS_CHANNEL = createModuleOwnedMetadataChannel<CodeProcess>("workflow.process/v1");
const KEY = /^[a-z][a-z0-9_.-]{0,63}$/;

/** A problem of the processes declared in code; the application reports it as a configuration error. */
export class WorkflowSetupError extends Error {
  override readonly name = "WorkflowSetupError";
}

// Internal imports must not depend on the public barrel having augmented DI's metadata interface.
interface WorkflowModuleFields {
  readonly processes?: readonly unknown[];
}

registerModuleOwnedProviderContributor((metadata: BazisModuleMetadata, context) => {
  const processes = (metadata as BazisModuleMetadata & WorkflowModuleFields).processes;
  if (processes === undefined) return;
  const module = moduleName(metadata);
  if (!Array.isArray(processes)) throw new WorkflowSetupError(`${module}: processes must be an array of defineProcess(...) results.`);
  for (const process of processes) {
    if (!isCodeProcess(process)) throw new WorkflowSetupError(`${module}: processes must list defineProcess(...) results.`);
    const problems = definitionProblems(process);
    if (problems.length > 0) throw new WorkflowSetupError(`${module}: process "${process.key}" ${problems.length === 1 ? "has an error" : "has errors"}:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
    context.addMetadata(PROCESS_CHANNEL, process);
  }
});

registerModuleOwnedContributionValidator((snapshot) => {
  const contributions = snapshot.getMetadataContributions(PROCESS_CHANNEL);
  if (contributions.length === 0) return;
  const owners = new Map<string, string>();
  for (const { payload, ownerName } of contributions) {
    const other = owners.get(payload.key);
    if (other !== undefined) throw new WorkflowSetupError(`Process "${payload.key}" is declared twice: in ${other} and in ${ownerName}.`);
    owners.set(payload.key, ownerName);
  }
  if (snapshot.countProviders(IWorkflowDefinitions) === 0) {
    throw new WorkflowSetupError(`${contributions[0]!.ownerName} declares processes, but the application does not import WorkflowModule (bazis/core/workflow).`);
  }
});

/** The processes declared in the modules of the application's container. */
export function codeProcessesOf(services: ServiceProvider): readonly OwnedCodeProcess[] {
  if (!(services instanceof DiContainer)) throw new WorkflowSetupError("Processes declared in code require the framework DiContainer.");
  return services.getModuleOwnedMetadataContributions(PROCESS_CHANNEL).map(({ payload, ownerName }) => ({ process: payload, module: ownerName }));
}

/** What is wrong with a definition before the Tools are known: the catalog fields and the document's errors. */
export function definitionProblems(process: CodeProcess, tools?: (name: string) => boolean): readonly string[] {
  const problems: string[] = [];
  if (typeof process.key !== "string" || !KEY.test(process.key)) problems.push("key must match ^[a-z][a-z0-9_.-]{0,63}$");
  const title = checkLocalizedText(process.title, 200);
  if (title) problems.push(`title ${title}`);
  const description = process.description == null ? null : checkLocalizedText(process.description, 2000, 0);
  if (description) problems.push(`description ${description}`);
  if (process.folder != null && (typeof process.folder !== "string" || !/^[^/\s](?:[^/]*[^/\s])?(?:\/[^/\s](?:[^/]*[^/\s])?)*$/.test(process.folder))) problems.push("folder must be a path like Sales/Orders");
  if (process.owner != null && (typeof process.owner !== "string" || process.owner === "" || process.owner.length > 200)) problems.push("owner must be up to 200 characters");
  if (process.retentionDays != null && (!Number.isSafeInteger(process.retentionDays) || process.retentionDays < 1 || process.retentionDays > 36_500)) problems.push("retentionDays must be an integer 1–36500");
  problems.push(...documentErrors(validateProcess(process.document, tools === undefined ? {} : { tools })));
  return problems;
}

function documentErrors(issues: readonly ProcessIssue[]): string[] {
  return issues.filter((issue) => issue.severity === "error").map((issue) => {
    const at = issue.node !== undefined ? `node ${issue.node}: ` : issue.flow !== undefined ? `flow ${issue.flow}: ` : "";
    return `${at}${issue.message} (${issue.code})`;
  });
}

function moduleName(metadata: BazisModuleMetadata): string {
  return typeof metadata === "function" ? (metadata as { name: string }).name || "<anonymous module>" : "<module>";
}
