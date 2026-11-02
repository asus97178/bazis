import { markConfigurationError, type ServiceProvider } from "../../../di";
import type { HostedService } from "../../../di/extensions/hosted-service";
import { LOGGER } from "../../../kernel";
import { WorkflowReferences } from "../../internal/WorkflowReferences";
import { WorkflowTools } from "../../internal/WorkflowTools";
import { IWorkflowDefinitions } from "../services/IWorkflowDefinitions.service";
import { CatalogImport } from "./CatalogImport";
import { CodeProcessCatalog } from "./CodeProcessCatalog";
import { definitionProblems, WorkflowSetupError } from "./codeProcesses";

/**
 * At start, after the tables exist: brings over the catalog of the old store
 * (WORKFLOW-002 §9), then publishes the processes of `@Module({ processes })`
 * (WORKFLOW-001 §14). A document with an unknown Tool or process, or an `extensions`
 * namespace nobody checks, stops the start with every finding of every process; the same
 * document again gives no new version. So does a reference kind no module owns, in a Tool
 * or a document. A value that does not exist only warns: it may be data that is yet to come,
 * and the step then fails with `ref_not_found`.
 */
export class CodeProcessPublisher implements HostedService {
  readonly diagnosticName = "workflow:processes";

  constructor(private readonly services: ServiceProvider) {}

  async start(): Promise<void> {
    const logger = this.services.tryResolve(LOGGER);
    const scope = this.services.createScope();
    try {
      const imported = await scope.resolve(CatalogImport).run();
      if (imported > 0) logger?.info("workflow catalog brought over from the old store", { processes: imported });
      const references = scope.resolve(WorkflowReferences);
      const unowned = references.unownedToolKinds();
      if (unowned.length > 0) {
        throw markConfigurationError(new WorkflowSetupError(`Tools refer to kinds no module owns:\n${unowned.map(({ tool, kind }) => `  - ${tool}: ${kind}${kind.startsWith("orm.") ? " (import StandardToolsModule from bazis/core/tools)" : " (declare it in @Module({ references }))"}`).join("\n")}`));
      }
      const entries = this.services.resolve(CodeProcessCatalog).list();
      if (entries.length === 0) return;
      const tools = this.services.resolve(WorkflowTools);
      const definitions = scope.resolve(IWorkflowDefinitions);
      const problems: string[] = [];
      const processes = entries.map(({ process }) => process.key);
      for (const { process, module } of entries) {
        const found = [...definitionProblems(process, (name) => tools.has(name))];
        for (const issue of await definitions.validate(process.document, { processes })) {
          if (issue.severity === "error" && (issue.code === "extension_unknown" || issue.code === "extension_invalid" || issue.code === "unknown_process")) found.push(`${issue.message} (${issue.code})`);
          else if (issue.code === "broken_ref") {
            if (issue.message.startsWith("no module owns")) found.push(`${issue.message} (${issue.code})`);
            else logger?.warn("workflow process refers to what does not exist", { process: process.key, node: issue.node, message: issue.message });
          }
        }
        if (found.length > 0) problems.push(`${module}: process "${process.key}":\n${found.map((line) => `  - ${line}`).join("\n")}`);
      }
      if (problems.length > 0) {
        throw markConfigurationError(new WorkflowSetupError(`Processes declared in code cannot be published:\n${problems.join("\n")}`));
      }
      const results = await definitions.publishCode(entries);
      logger?.info("workflow processes from code", {
        published: results.filter((result) => result.published).map((result) => `${result.key} v${result.version}`),
        unchanged: results.filter((result) => !result.published).map((result) => result.key),
      });
    } finally {
      await scope.dispose();
    }
  }

  stop(): void {}
}
