import type { AgentDefinition } from "./AgentRegistry";
import { AgentRuntimeError } from "./errors";
import {
  agentMessage,
  type AgentContentPart,
  type AgentMessage,
  type AgentMessageRole,
  type JsonObject,
  type JsonValue,
} from "./semantic";

export interface AgentContextLimits {
  readonly maxMessages?: number;
  readonly maxChars?: number;
  readonly maxTokens?: number;
}

export interface AgentContextBuildInput {
  readonly invocationId: string;
  readonly agent: AgentDefinition;
  readonly messages: readonly AgentMessage[];
  readonly metadata: JsonObject;
  readonly limits?: AgentContextLimits;
}

export interface AgentContextTraceEntry {
  readonly section: string;
  readonly role?: AgentMessageRole;
  readonly chars: number;
  readonly tokens: number;
  readonly included: boolean;
  readonly reason?: string;
}

export interface AgentContext {
  readonly messages: readonly AgentMessage[];
  readonly trace: readonly AgentContextTraceEntry[];
  readonly metadata: JsonObject;
}

export interface AgentContextBuilder {
  build(input: AgentContextBuildInput): AgentContext;
}

export interface AgentContextTokenEstimator {
  estimateMessage(message: AgentMessage): number;
}

export interface DefaultAgentContextBuilderOptions {
  readonly tokenEstimator?: AgentContextTokenEstimator;
}

interface ContextCandidate {
  readonly section: string;
  readonly message: AgentMessage;
  readonly chars: number;
  readonly tokens: number;
}

function errorMessageOf(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === "string" ? error.message : String(error);
  } catch {
    return "Unknown error.";
  }
}

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentRuntimeError(`${field} must be a positive integer.`);
  }
  return value;
}

export function normalizeAgentContextLimits(
  limits: AgentContextLimits | undefined,
  field = "agentContext.limits",
): AgentContextLimits | undefined {
  if (limits === undefined) {
    return undefined;
  }

  const normalized: { maxMessages?: number; maxChars?: number; maxTokens?: number } = {};
  const maxMessages = optionalPositiveInteger(limits.maxMessages, `${field}.maxMessages`);
  const maxChars = optionalPositiveInteger(limits.maxChars, `${field}.maxChars`);
  const maxTokens = optionalPositiveInteger(limits.maxTokens, `${field}.maxTokens`);
  if (maxMessages !== undefined) {
    normalized.maxMessages = maxMessages;
  }
  if (maxChars !== undefined) {
    normalized.maxChars = maxChars;
  }
  if (maxTokens !== undefined) {
    normalized.maxTokens = maxTokens;
  }
  return Object.freeze(normalized);
}

export function mergeAgentContextLimits(
  defaults: AgentContextLimits | undefined,
  overrides: AgentContextLimits | undefined,
): AgentContextLimits | undefined {
  if (defaults === undefined && overrides === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(defaults ?? {}),
    ...(overrides ?? {}),
  });
}

function cloneMessage(message: AgentMessage, field: string): AgentMessage {
  if (!message || typeof message !== "object") {
    throw new AgentRuntimeError(`${field} must be an agent message.`);
  }
  try {
    return agentMessage(message.role, message.content, {
      id: message.id,
      name: message.name,
      toolCallId: message.toolCallId,
      createdAtUnixMs: message.createdAtUnixMs,
      metadata: message.metadata,
    });
  } catch (error) {
    throw new AgentRuntimeError(`${field} is invalid: ${errorMessageOf(error)}`);
  }
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function contentPartChars(part: AgentContentPart): number {
  switch (part.kind) {
    case "text":
      return part.text.length;
    case "data":
      return jsonLength(part.value) + (part.name?.length ?? 0);
    case "image":
      return part.uri.length + (part.mediaType?.length ?? 0) + part.detail.length;
    case "file":
      return part.uri.length + (part.mediaType?.length ?? 0) + (part.name?.length ?? 0);
    case "tool-result":
      return jsonLength(part.result);
    case "tool-call":
      return jsonLength(part.call);
  }
}

function textTokenCount(text: string): number {
  const matches = text.match(/[\p{L}\p{N}_]+|[^\s]/gu);
  return matches?.length ?? 0;
}

function contentPartTokens(part: AgentContentPart): number {
  switch (part.kind) {
    case "text":
      return textTokenCount(part.text);
    case "data":
      return textTokenCount(JSON.stringify(part.value) ?? "") + (part.name === undefined ? 0 : textTokenCount(part.name));
    case "image":
      return textTokenCount(JSON.stringify({ uri: part.uri, mediaType: part.mediaType ?? null, detail: part.detail }));
    case "file":
      return textTokenCount(JSON.stringify({ uri: part.uri, mediaType: part.mediaType ?? null, name: part.name ?? null }));
    case "tool-result":
      return textTokenCount(JSON.stringify(part.result) ?? "");
    case "tool-call":
      return textTokenCount(JSON.stringify(part.call) ?? "");
  }
}

function messageChars(message: AgentMessage): number {
  let total = message.role.length;
  if (message.id !== undefined) {
    total += message.id.length;
  }
  if (message.name !== undefined) {
    total += message.name.length;
  }
  if (message.toolCallId !== undefined) {
    total += message.toolCallId.length;
  }
  for (let index = 0; index < message.content.length; index += 1) {
    total += contentPartChars(message.content[index] as AgentContentPart);
  }
  return total;
}

export class ApproximateAgentContextTokenEstimator implements AgentContextTokenEstimator {
  estimateMessage(message: AgentMessage): number {
    let total = 1;
    if (message.name !== undefined) {
      total += textTokenCount(message.name);
    }
    if (message.toolCallId !== undefined) {
      total += textTokenCount(message.toolCallId);
    }
    for (let index = 0; index < message.content.length; index += 1) {
      total += contentPartTokens(message.content[index] as AgentContentPart);
    }
    return total;
  }
}

function protectedIndexes(candidates: readonly ContextCandidate[]): ReadonlySet<number> {
  const indexes = new Set<number>();
  if (candidates.length === 0) {
    return indexes;
  }
  if (candidates[0]?.section === "prompt") {
    indexes.add(0);
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index]?.section !== "prompt") {
      indexes.add(index);
      protectToolExchange(candidates, indexes, index);
      break;
    }
  }
  if (indexes.size === 0) {
    indexes.add(0);
  }
  return indexes;
}

function toolCallIds(message: AgentMessage): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const part of message.content) {
    if (part.kind === "tool-call") {
      ids.add(part.call.id);
    }
  }
  return ids;
}

/** Keep the assistant call and all parallel tool results as one protocol unit. */
function protectToolExchange(
  candidates: readonly ContextCandidate[],
  indexes: Set<number>,
  index: number,
): void {
  const current = candidates[index]?.message;
  if (current?.role !== "tool") {
    return;
  }
  const resultIds = new Set<string>();
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const message = candidates[cursor]?.message;
    if (message?.role === "tool" && message.toolCallId !== undefined) {
      resultIds.add(message.toolCallId);
      indexes.add(cursor);
      continue;
    }
    if (message?.role === "assistant") {
      const callIds = toolCallIds(message);
      if ([...resultIds].some((id) => callIds.has(id))) {
        indexes.add(cursor);
      }
    }
    break;
  }
}

type ContextBudget = "maxMessages" | "maxChars" | "maxTokens";

/** A monotonic eviction cursor and safe integer totals keep normal trimming O(n). */
class ContextSelection {
  private cursor = 0;
  private readonly useRunningTokenTotal: boolean;
  readonly totals = { maxMessages: 0, maxChars: 0, maxTokens: 0 };
  private readonly minimum = { maxMessages: 0, maxChars: 0, maxTokens: 0 };

  constructor(
    private readonly candidates: readonly ContextCandidate[],
    private readonly included: boolean[],
    private readonly reasons: Array<string | undefined>,
    private readonly protectedItems: ReadonlySet<number>,
  ) {
    candidates.forEach((candidate, index) => {
      this.totals.maxMessages++;
      this.totals.maxChars += candidate.chars;
      this.totals.maxTokens += candidate.tokens;
      if (protectedItems.has(index)) {
        this.minimum.maxMessages++;
        this.minimum.maxChars += candidate.chars;
        this.minimum.maxTokens += candidate.tokens;
      }
    });
    this.useRunningTokenTotal = Number.isSafeInteger(this.totals.maxTokens) && candidates.every((candidate) => Number.isSafeInteger(candidate.tokens));
  }

  apply(budget: ContextBudget, limit: number | undefined): void {
    if (limit === undefined) return;
    if (limit < this.minimum[budget]) {
      throw new AgentRuntimeError(`agentContext.limits.${budget} is too small for protected context.`);
    }
    while (this.total(budget) > limit) {
      if (!this.dropOldest(budget)) {
        throw new AgentRuntimeError(`agentContext.limits.${budget} cannot be applied to protected context.`);
      }
    }
  }

  total(budget: ContextBudget): number {
    if (budget !== "maxTokens" || this.useRunningTokenTotal) return this.totals[budget];
    // Custom estimators historically accept fractions and huge finite values.
    // Preserve their left-to-right sums instead of subtracting with rounding
    // error or retaining Infinity after a large message has been removed.
    let total = 0;
    this.candidates.forEach((candidate, index) => { if (this.included[index]) total += candidate.tokens; });
    return total;
  }

  private remove(index: number, reason: ContextBudget): void {
    if (!this.included[index] || this.protectedItems.has(index)) return;
    const candidate = this.candidates[index]!;
    this.included[index] = false;
    this.reasons[index] = reason;
    this.totals.maxMessages--;
    this.totals.maxChars -= candidate.chars;
    this.totals.maxTokens -= candidate.tokens;
  }

  private dropOldest(reason: ContextBudget): boolean {
    while (this.cursor < this.candidates.length) {
      const index = this.cursor++;
      if (!this.included[index] || this.protectedItems.has(index)) continue;
      const message = this.candidates[index]!.message;
      const callIds = message.role === "assistant" ? toolCallIds(message) : undefined;
      this.remove(index, reason);
      if (callIds !== undefined && callIds.size > 0) {
        for (let nextIndex = index + 1; nextIndex < this.candidates.length; nextIndex++) {
          const next = this.candidates[nextIndex]!.message;
          if (next.role !== "tool") break;
          if (next.toolCallId !== undefined && callIds.has(next.toolCallId)) this.remove(nextIndex, reason);
        }
      }
      return true;
    }
    return false;
  }
}

function traceEntry(
  candidate: ContextCandidate,
  included: boolean,
  reason: string | undefined,
): AgentContextTraceEntry {
  const entry: AgentContextTraceEntry = {
    section: candidate.section,
    role: candidate.message.role,
    chars: candidate.chars,
    tokens: candidate.tokens,
    included,
    ...(reason !== undefined ? { reason } : {}),
  };
  return Object.freeze(entry);
}

function traceToJson(trace: readonly AgentContextTraceEntry[]): JsonValue {
  return Object.freeze(trace.map((entry) => {
    const json: Record<string, JsonValue> = {
      section: entry.section,
      chars: entry.chars,
      tokens: entry.tokens,
      included: entry.included,
    };
    if (entry.role !== undefined) {
      json.role = entry.role;
    }
    if (entry.reason !== undefined) {
      json.reason = entry.reason;
    }
    return Object.freeze(json) as JsonObject;
  }));
}

export class DefaultAgentContextBuilder implements AgentContextBuilder {
  private readonly tokenEstimator: AgentContextTokenEstimator;

  constructor(options: DefaultAgentContextBuilderOptions = {}) {
    this.tokenEstimator = options.tokenEstimator ?? new ApproximateAgentContextTokenEstimator();
  }

  build(input: AgentContextBuildInput): AgentContext {
    const limits = normalizeAgentContextLimits(input.limits);
    const candidates = this.candidates(input.agent, input.messages);
    if (candidates.length === 0) {
      throw new AgentRuntimeError("agent context requires at least one message.");
    }

    const included = candidates.map(() => true);
    const reasons = candidates.map(() => undefined as string | undefined);
    const protectedItems = protectedIndexes(candidates);
    const selection = new ContextSelection(candidates, included, reasons, protectedItems);
    selection.apply("maxMessages", limits?.maxMessages);
    selection.apply("maxChars", limits?.maxChars);
    selection.apply("maxTokens", limits?.maxTokens);

    const messages: AgentMessage[] = [];
    const trace: AgentContextTraceEntry[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index] as ContextCandidate;
      const isIncluded = included[index] === true;
      trace.push(traceEntry(candidate, isIncluded, reasons[index]));
      if (isIncluded) {
        messages.push(candidate.message);
      }
    }

    const charCount = selection.totals.maxChars;
    const tokenCount = selection.total("maxTokens");
    return Object.freeze({
      messages: Object.freeze(messages),
      trace: Object.freeze(trace),
      metadata: Object.freeze({
        invocationId: input.invocationId,
        messageCount: messages.length,
        charCount,
        tokenCount,
        trace: traceToJson(trace),
      }),
    });
  }

  private candidates(agent: AgentDefinition, messages: readonly AgentMessage[]): readonly ContextCandidate[] {
    const candidates: ContextCandidate[] = [];
    const prompt = this.promptMessage(agent);
    if (prompt !== undefined) {
      const tokens = this.estimatedTokens(prompt, "prompt");
      candidates.push(Object.freeze({
        section: "prompt",
        message: prompt,
        chars: messageChars(prompt),
        tokens,
      }));
    }

    for (let index = 0; index < messages.length; index += 1) {
      const message = cloneMessage(messages[index] as AgentMessage, `agentContext.messages[${index}]`);
      const tokens = this.estimatedTokens(message, `conversation[${index}]`);
      candidates.push(Object.freeze({
        section: `conversation[${index}]`,
        message,
        chars: messageChars(message),
        tokens,
      }));
    }
    return Object.freeze(candidates);
  }

  private estimatedTokens(message: AgentMessage, field: string): number {
    let estimate: unknown;
    try { estimate = this.tokenEstimator.estimateMessage(message); } catch (error) {
      throw new AgentRuntimeError(`agentContext token estimator failed for ${field}: ${errorMessageOf(error)}`);
    }
    if (!Number.isFinite(estimate) || typeof estimate !== "number" || estimate < 0) {
      throw new AgentRuntimeError(`agentContext token estimator returned an invalid estimate for ${field}.`);
    }
    return estimate;
  }

  private promptMessage(agent: AgentDefinition): AgentMessage | undefined {
    const lines: string[] = [];
    if (agent.metadata.role !== undefined) {
      lines.push(`Role: ${agent.metadata.role}`);
    }
    if (agent.metadata.description !== undefined) {
      lines.push(`Description: ${agent.metadata.description}`);
    }
    if (agent.metadata.goal !== undefined) {
      lines.push(`Goal: ${agent.metadata.goal}`);
    }
    if (agent.metadata.instructions.length > 0) {
      lines.push("Instructions:");
      lines.push(...agent.metadata.instructions.map((item) => `- ${item}`));
    }
    if (agent.metadata.constraints.length > 0) {
      lines.push("Constraints:");
      lines.push(...agent.metadata.constraints.map((item) => `- ${item}`));
    }
    for (let index = 0; index < agent.metadata.sections.length; index += 1) {
      appendPromptSection(lines, agent.metadata.sections[index] as (typeof agent.metadata.sections)[number]);
    }

    const prompt = agent.prompt?.metadata;
    if (prompt !== undefined) {
      if (prompt.description !== undefined) {
        lines.push(`Prompt description: ${prompt.description}`);
      }
      if (prompt.version !== undefined) {
        lines.push(`Prompt version: ${prompt.version}`);
      }
      if (prompt.role !== undefined) {
        lines.push(`Prompt role: ${prompt.role}`);
      }
      if (prompt.goal !== undefined) {
        lines.push(`Goal: ${prompt.goal}`);
      }
      if (prompt.instructions.length > 0) {
        lines.push("Instructions:");
        lines.push(...prompt.instructions.map((item) => `- ${item}`));
      }
      if (prompt.constraints.length > 0) {
        lines.push("Constraints:");
        lines.push(...prompt.constraints.map((item) => `- ${item}`));
      }
      for (let index = 0; index < prompt.sections.length; index += 1) {
        appendPromptSection(lines, prompt.sections[index] as (typeof prompt.sections)[number]);
      }
    }

    return lines.length === 0
      ? undefined
      : agentMessage("system", lines.join("\n"), {
          metadata: {
            agentName: agent.metadata.name,
            promptName: prompt?.name ?? null,
            promptSectionKinds: prompt?.sections.map((section) => section.kind) ?? [],
          },
        });
  }
}

function appendPromptSection(
  lines: string[],
  section: { readonly kind: string; readonly title?: string; readonly content: readonly string[] },
): void {
  lines.push(`${section.title ?? promptSectionTitle(section.kind)}:`);
  if (section.content.length === 1) {
    lines.push(section.content[0] as string);
    return;
  }
  lines.push(...section.content.map((item) => `- ${item}`));
}

function promptSectionTitle(kind: string): string {
  switch (kind) {
    case "system":
      return "System";
    case "developer":
      return "Developer";
    case "role":
      return "Role";
    case "task":
      return "Task";
    case "instructions":
      return "Instructions";
    case "constraints":
      return "Constraints";
    case "examples":
      return "Examples";
    case "output":
      return "Output format";
    case "tool-policy":
      return "Tool policy";
    case "memory":
      return "Memory";
    case "knowledge":
      return "Knowledge";
    default:
      return "Prompt section";
  }
}
