import type { AgentDataDefinition } from "./AgentDataDefinition";
import { AgentRuntime } from "./AgentRuntime";
import { defineTool, type DefinedTool } from "./defineTool";
import { AgentSetupError, ToolError } from "./errors";
import type { ToolSideEffect } from "./metadata";
import { agentMessageText, type AgentOutputContract, type JsonObject, type JsonValue } from "./semantic";

/** How deep agents may call agents unless `maxDepth` says otherwise. */
const DEFAULT_MAX_DEPTH = 3;
/** An agent works longer than an ordinary Tool: five minutes instead of thirty seconds. */
const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 5 * 60_000;
/** `metadata` key of a run started by an agent Tool: how deep it is. */
const DEPTH_KEY = "agentDepth";

export interface AgentToolOptions {
  /** The name the calling agent uses: `research.find`. */
  readonly name: string;
  /** What the agent is for and when to hand it a task: the calling model reads this. */
  readonly description: string;
  /** The agent that does the task. It gets only the task: nothing of the caller's dialog. */
  readonly agent: AgentDataDefinition;
  /** A structured answer instead of text: the Tool returns the checked value. */
  readonly output?: AgentOutputContract;
  /** The step limit of the nested run; the runtime's own by default. */
  readonly maxSteps?: number;
  /** The model profile of the nested run instead of the agent's. */
  readonly modelProfile?: string;
  /** The deadline of one call, the whole nested run included. Five minutes by default. */
  readonly timeoutMs?: number;
  /**
   * How deep agents may call agents through such Tools: a call beyond it is
   * refused, so two agents that name each other cannot loop. 3 by default.
   */
  readonly maxDepth?: number;
  /**
   * What the Tool itself changes: nothing by default (`"none"`), so several
   * agents of one step run together. The Tools of the nested agent are
   * approved and audited one by one, as in any run.
   */
  readonly sideEffect?: ToolSideEffect;
  /** Who may call it; LLM agents by default. */
  readonly callers?: readonly string[];
  readonly tags?: readonly string[];
}

/** What an agent Tool takes: the task in words. */
export interface AgentToolInput {
  readonly task: string;
}

/** What an agent Tool gives back: the answer in words, or the structured value when `output` asks for one. */
export interface AgentToolOutput {
  readonly answer: string;
  readonly output?: JsonValue;
}

/**
 * An agent as a Tool of another agent: the caller hands over a task in words,
 * the nested agent works on it in its own dialog with its own Tools, and only
 * its answer comes back. It keeps the caller's context small and lets a
 * cheaper model do the reading.
 *
 * ```ts
 * const researcher = { name: "researcher", instructions: "Find facts about orders.", toolNames: ["orders.find"], modelProfile: "fast" };
 *
 * @Module({ tools: [agentTool({ name: "research.orders", description: "Looks up facts about orders. Give it the full question.", agent: researcher })] })
 * export class SupportModule {}
 * ```
 */
export function agentTool(options: AgentToolOptions): DefinedTool<AgentToolInput, AgentToolOutput> {
  if (options === null || typeof options !== "object" || options.agent === null || typeof options.agent !== "object") {
    throw new AgentSetupError("agentTool takes { name, description, agent }: the agent is a definition such as { name, instructions, toolNames }.");
  }
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth <= 0) throw new AgentSetupError("agentTool.maxDepth must be a positive integer.");
  const agent = Object.freeze({ ...options.agent, ...(options.agent.toolNames === undefined ? {} : { toolNames: Object.freeze([...options.agent.toolNames]) }) });

  return defineTool<AgentToolInput, AgentToolOutput>({
    name: options.name,
    description: options.description,
    callers: options.callers ?? ["agent"],
    sideEffect: options.sideEffect ?? "none",
    timeoutMs: options.timeoutMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS,
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "What to do, with everything needed to do it: the agent sees nothing of this conversation." } },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input, context, services) {
      const task = typeof input === "object" && input !== null ? (input as { task?: unknown }).task : undefined;
      if (typeof task !== "string" || task.trim().length === 0) throw new ToolError("The task must be a non-empty string.");
      const depth = typeof context.metadata[DEPTH_KEY] === "number" ? context.metadata[DEPTH_KEY] : 0;
      if (depth >= maxDepth) {
        throw new ToolError(`Agent "${agent.name}" was not started: agents already call agents ${depth} deep, and the limit is ${maxDepth}.`, { reason: "agent_depth_exceeded" });
      }
      const metadata: JsonObject = { ...context.metadata, [DEPTH_KEY]: depth + 1, ...(context.invocationId === undefined ? {} : { parentInvocationId: context.invocationId }) };
      const result = await services.resolve(AgentRuntime).run(agent, {
        input: task,
        metadata,
        signal: context.signal,
        ...(options.output === undefined ? {} : { output: options.output }),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.modelProfile === undefined ? {} : { modelProfile: options.modelProfile }),
      });
      if (result.status === "waiting") {
        // A nested run cannot ask a person: its dialog is not kept anywhere to go on from.
        const asked = result.pendingApprovals?.[0]?.call.name ?? "a Tool";
        throw new ToolError(`Agent "${agent.name}" stopped: its Tool "${asked}" needs a person's approval, which an agent called as a Tool cannot ask for.`, { reason: "agent_needs_approval" });
      }
      if (result.status !== "completed") {
        // The caller's model decides what to do next: try again, ask differently, do without.
        throw new ToolError(`Agent "${agent.name}" did not finish: ${result.error?.message ?? "unknown error"}`, { reason: "agent_failed" });
      }
      return { answer: agentMessageText(result.finalMessage), ...(result.output === undefined ? {} : { output: result.output }) };
    },
  });
}
