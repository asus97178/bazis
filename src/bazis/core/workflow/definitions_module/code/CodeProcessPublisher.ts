import { markConfigurationError, type ServiceProvider } from "../../../di";
import type { HostedService } from "../../../di/extensions/hosted-service";
import { LOGGER } from "../../../kernel";
import { WorkflowTools } from "../../internal/WorkflowTools";
import { IWorkflowDefinitions } from "../services/IWorkflowDefinitions.service";
import { CodeProcessCatalog } from "./CodeProcessCatalog";
import { definitionProblems, WorkflowSetupError } from "./codeProcesses";

/**
 * Publishes the processes of `@Module({ processes })` at start, after the
 * tables exist (WORKFLOW-001 §14). A document with an unknown Tool stops the
 * start with every finding of every process; the same document again gives no
 * new version.
 */
export class CodeProcessPublisher implements HostedService {
  readonly diagnosticName = "workflow:processes";

  constructor(private readonly services: ServiceProvider) {}

  async start(): Promise<void> {
    const entries = this.services.resolve(CodeProcessCatalog).list();
    if (entries.length === 0) return;
    const tools = this.services.resolve(WorkflowTools);
    const problems = entries.flatMap(({ process, module }) => {
      const found = definitionProblems(process, (name) => tools.has(name));
      return found.length === 0 ? [] : [`${module}: process "${process.key}":\n${found.map((line) => `  - ${line}`).join("\n")}`];
    });
    if (problems.length > 0) {
      throw markConfigurationError(new WorkflowSetupError(`Processes declared in code cannot be published:\n${problems.join("\n")}`));
    }
    const scope = this.services.createScope();
    try {
      const results = await scope.resolve(IWorkflowDefinitions).publishCode(entries);
      this.services.tryResolve(LOGGER)?.info("workflow processes from code", {
        published: results.filter((result) => result.published).map((result) => `${result.key} v${result.version}`),
        unchanged: results.filter((result) => !result.published).map((result) => result.key),
      });
    } finally {
      await scope.dispose();
    }
  }

  stop(): void {}
}
