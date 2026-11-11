import { ServiceProvider, type Class } from "../di";
import { registerFrameworkClassDeps } from "../di/module/autoDeps";
import { Tool } from "./decorators/Tool";
import { AgentSetupError } from "./errors";
import { toolMetadataOf, type ToolOptions } from "./metadata";
import type { AgentToolExecutionContext } from "./AgentToolExecutor";

declare const TOOL_TYPES: unique symbol;

/**
 * A Tool made by {@link defineTool}. It stands in `@Module({ tools })` next to
 * the classes with `@Tool`, and a process names it by reference.
 */
export type DefinedTool<I = unknown, O = unknown> = Class<object> & {
  /** The name it is called by: `orm.order.find`. */
  readonly toolName: string;
  /** Only for the types: what `execute` takes and gives back. */
  readonly [TOOL_TYPES]?: { readonly input: I; readonly output: O };
};

/** Several made Tools under the names their factory gave them: `orderTools.find`. */
export type ToolSet<K extends string = string> = { readonly [P in K]: DefinedTool };

/** What `defineTool` takes: what `@Tool` takes, without the classes of input and output, and the work itself. */
export interface DefinedToolOptions<I = unknown, O = unknown> extends Omit<ToolOptions, "input" | "output"> {
  /**
   * Does the work. `services` is the scope of the call: `services.resolve(OrdersDbContext)`.
   * The input comes as the caller sent it: check it here.
   */
  execute(input: I, context: AgentToolExecutionContext, services: ServiceProvider): O | Promise<O>;
}

const DEFINED = new WeakSet<object>();

/**
 * A Tool without a class: for Tools made by a function, when their number and
 * names are known only from its arguments. A Tool written by hand is a class
 * with `@Tool`.
 *
 * ```ts
 * export function exportTools(formats: readonly string[]): ToolSet {
 *   return Object.fromEntries(formats.map((format) => [format, defineTool({
 *     name: `reports.export.${format}`,
 *     description: `Exports a report as ${format}.`,
 *     sideEffect: "read",
 *     callers: ["workflow"],
 *     inputSchema: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"] },
 *     execute: (input: { reportId: string }, _context, services) => services.resolve(ReportService).export(input.reportId, format),
 *   })]));
 * }
 *
 * @Module({ tools: [SendReportTool, exportTools(["pdf", "csv"])] })
 * ```
 */
export function defineTool<I = unknown, O = unknown>(definition: DefinedToolOptions<I, O>): DefinedTool<I, O> {
  if (definition === null || typeof definition !== "object" || typeof definition.execute !== "function") {
    throw new AgentSetupError("defineTool takes the description of a Tool with its execute(input, context, services).");
  }
  const { execute, ...options } = definition;

  @Tool(options)
  class MadeTool {
    static readonly toolName = String(options.name).trim();

    constructor(private readonly services: ServiceProvider) {}

    execute(input: unknown, context: AgentToolExecutionContext): unknown {
      return execute(input as I, context, this.services);
    }
  }

  // The class is made here, so codegen never sees its constructor.
  registerFrameworkClassDeps([[MadeTool, [ServiceProvider]]]);
  DEFINED.add(MadeTool);
  Object.defineProperty(MadeTool, "name", { value: `Tool(${MadeTool.toolName})` });
  return MadeTool as unknown as DefinedTool<I, O>;
}

/** Whether a value came from {@link defineTool}. */
export function isDefinedTool(value: unknown): value is DefinedTool {
  return typeof value === "function" && DEFINED.has(value);
}

/**
 * @internal The Tools a module lists in `tools`: classes with `@Tool`, made Tools
 * and sets of them, as one list of classes.
 */
export function moduleToolsOf(value: unknown): readonly Class<object>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AgentSetupError("tools must be an array of classes with @Tool, Tools made by defineTool and sets of them.");
  const out: Class<object>[] = [];
  for (const entry of value) {
    if (typeof entry === "function") {
      out.push(entry as Class<object>);
      continue;
    }
    const members = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? Object.entries(entry) : undefined;
    if (members === undefined || members.length === 0 || members.some(([, member]) => !isDefinedTool(member))) {
      throw new AgentSetupError("tools must list classes with @Tool, Tools made by defineTool and sets of them: an object in the list must hold only Tools made by defineTool.");
    }
    for (const [, member] of members) out.push(member as Class<object>);
  }
  return out;
}

/** The name a class with `@Tool` or a made Tool is called by; `undefined` for anything else. */
export function toolNameOf(tool: unknown): string | undefined {
  return typeof tool === "function" ? toolMetadataOf(tool as Class<object>)?.name : undefined;
}
