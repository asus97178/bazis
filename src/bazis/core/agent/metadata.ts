import type { Class } from "../di";
import { AgentSetupError } from "./errors";

// Bun executes TC39 decorators natively, but Symbol.metadata may be absent in
// the runtime. Keep the same tiny polyfill used by HTTP/background metadata.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const AGENT_META = Symbol.for("bazis:agent:agent");
const TOOL_META = Symbol.for("bazis:agent:tool");
const PROMPT_META = Symbol.for("bazis:agent:prompt");
const TASK_META = Symbol.for("bazis:agent:task");

export type ToolSideEffect = "none" | "read" | "write" | "external";
export type ToolApproval = "never" | "policy" | "required";
export type PromptSectionKind =
  | "system"
  | "developer"
  | "role"
  | "task"
  | "instructions"
  | "constraints"
  | "examples"
  | "output"
  | "tool-policy"
  | "memory"
  | "knowledge";

export interface AgentOptions {
  readonly name?: string;
  readonly description?: string;
  readonly role?: string;
  readonly goal?: string;
  readonly instructions?: readonly string[];
  readonly constraints?: readonly string[];
  readonly sections?: readonly PromptSectionOptions[];
  readonly prompt?: Class<object>;
  readonly tools?: readonly Class<object>[];
  readonly input?: Class<object>;
  readonly output?: Class<object>;
  readonly modelProfile?: string;
  readonly maxSteps?: number;
}

export interface AgentMetadata {
  readonly name: string;
  readonly description?: string;
  readonly role?: string;
  readonly goal?: string;
  readonly instructions: readonly string[];
  readonly constraints: readonly string[];
  readonly sections: readonly PromptSectionMetadata[];
  readonly prompt?: Class<object>;
  readonly tools: readonly Class<object>[];
  readonly input?: Class<object>;
  readonly output?: Class<object>;
  readonly modelProfile?: string;
  readonly maxSteps?: number;
  readonly tasks: readonly AgentTaskMetadata[];
}

export interface AgentTaskOptions {
  readonly name?: string;
  readonly description?: string;
  readonly input?: Class<object>;
  readonly output?: Class<object>;
  readonly modelProfile?: string;
  readonly maxSteps?: number;
}

export interface AgentTaskMetadata {
  readonly name: string;
  readonly methodName: string;
  readonly description?: string;
  readonly input?: Class<object>;
  readonly output?: Class<object>;
  readonly modelProfile?: string;
  readonly maxSteps?: number;
}

export interface ToolOptions {
  readonly name: string;
  readonly description: string;
  readonly input?: Class<object>;
  readonly output?: Class<object>;
  readonly sideEffect?: ToolSideEffect;
  readonly approval?: ToolApproval;
  readonly timeoutMs?: number;
  readonly tags?: readonly string[];
}

export interface ToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly input?: Class<object>;
  readonly output?: Class<object>;
  readonly sideEffect: ToolSideEffect;
  readonly approval: ToolApproval;
  readonly timeoutMs?: number;
  readonly tags: readonly string[];
}

export interface PromptOptions {
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly role?: string;
  readonly goal?: string;
  readonly instructions?: readonly string[];
  readonly constraints?: readonly string[];
  readonly sections?: readonly PromptSectionOptions[];
}

export interface PromptMetadata {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly role?: string;
  readonly goal?: string;
  readonly instructions: readonly string[];
  readonly constraints: readonly string[];
  readonly sections: readonly PromptSectionMetadata[];
}

export interface PromptSectionOptions {
  readonly kind: PromptSectionKind;
  readonly title?: string;
  readonly content: string | readonly string[];
  readonly priority?: number;
}

export interface PromptSectionMetadata {
  readonly kind: PromptSectionKind;
  readonly title?: string;
  readonly content: readonly string[];
  readonly priority?: number;
}

interface MetadataCarrier {
  [AGENT_META]?: AgentMetadata;
  [TOOL_META]?: ToolMetadata;
  [PROMPT_META]?: PromptMetadata;
  [TASK_META]?: readonly AgentTaskMetadata[];
}

interface NamedConstructor {
  readonly name?: string;
}

function classNameOf(target: object): string {
  return (target as NamedConstructor).name ?? "<anonymous class>";
}

function text(value: string | undefined, fallback: string, field: string): string {
  const resolved = value ?? fallback;
  const trimmed = resolved.trim();
  if (trimmed.length === 0) {
    throw new AgentSetupError(`${field} must be a non-empty string.`);
  }
  return trimmed;
}

function optionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AgentSetupError(`${field} must be a non-empty string when provided.`);
  }
  return trimmed;
}

function readonlyTextList(values: readonly string[] | undefined, field: string): readonly string[] {
  if (values === undefined) {
    return Object.freeze([]);
  }
  const normalized: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    normalized.push(text(values[index] as string, "", field));
  }
  return Object.freeze(normalized);
}

function promptSectionKind(value: string, field: string): PromptSectionKind {
  if (
    value !== "system" &&
    value !== "developer" &&
    value !== "role" &&
    value !== "task" &&
    value !== "instructions" &&
    value !== "constraints" &&
    value !== "examples" &&
    value !== "output" &&
    value !== "tool-policy" &&
    value !== "memory" &&
    value !== "knowledge"
  ) {
    throw new AgentSetupError(
      `${field} must be system, developer, role, task, instructions, constraints, examples, output, tool-policy, memory or knowledge.`,
    );
  }
  return value;
}

function readonlyPromptSectionContent(value: string | readonly string[], field: string): readonly string[] {
  if (typeof value === "string") {
    return Object.freeze([text(value, "", field)]);
  }
  if (!Array.isArray(value)) {
    throw new AgentSetupError(`${field} must be a string or an array of strings.`);
  }
  return readonlyTextList(value, field);
}

function readonlyPromptSections(
  values: readonly PromptSectionOptions[] | undefined,
  field: string,
): readonly PromptSectionMetadata[] {
  if (values === undefined) {
    return Object.freeze([]);
  }

  const normalized: PromptSectionMetadata[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as PromptSectionOptions;
    if (!value || typeof value !== "object") {
      throw new AgentSetupError(`${field}[${index}] must be a prompt section object.`);
    }
    normalized.push(freezeWithoutUndefined({
      kind: promptSectionKind(value.kind, `${field}[${index}].kind`),
      title: optionalText(value.title, `${field}[${index}].title`),
      content: readonlyPromptSectionContent(value.content, `${field}[${index}].content`),
      priority: positiveInteger(value.priority, `${field}[${index}].priority`),
    }));
  }
  return Object.freeze(normalized);
}

function readonlyClassList(values: readonly Class<object>[] | undefined): readonly Class<object>[] {
  if (values === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze([...values]);
}

function readonlyTaskList(values: readonly AgentTaskMetadata[] | undefined): readonly AgentTaskMetadata[] {
  if (values === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze([...values]);
}

function positiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentSetupError(`${field} must be a positive integer.`);
  }
  return value;
}

function freezeWithoutUndefined<T extends Record<string, unknown>>(value: T): T {
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      copy[key] = item;
    }
  }
  return Object.freeze(copy) as T;
}

function approvalFor(sideEffect: ToolSideEffect, requested: ToolApproval | undefined): ToolApproval {
  if (requested === undefined) {
    return sideEffect === "write" || sideEffect === "external" ? "required" : "policy";
  }
  if ((sideEffect === "write" || sideEffect === "external") && requested === "never") {
    throw new AgentSetupError(
      `Tools with "${sideEffect}" side effects cannot use approval: "never". Use "policy" or "required".`,
    );
  }
  return requested;
}

function ownCarrier(metadata: object): MetadataCarrier {
  return metadata as MetadataCarrier;
}

function readCarrier(ctor: object): MetadataCarrier | undefined {
  return (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as MetadataCarrier | undefined;
}

function hasOwnMeta(carrier: MetadataCarrier, key: symbol): boolean {
  return Object.prototype.hasOwnProperty.call(carrier, key);
}

export function defineAgentMetadata(target: object, metadata: object, options: AgentOptions): void {
  const carrier = ownCarrier(metadata);
  const normalized: AgentMetadata = Object.freeze({
    name: text(options.name, classNameOf(target), "@Agent.name"),
    description: optionalText(options.description, "@Agent.description"),
    role: optionalText(options.role, "@Agent.role"),
    goal: optionalText(options.goal, "@Agent.goal"),
    instructions: readonlyTextList(options.instructions, "@Agent.instructions"),
    constraints: readonlyTextList(options.constraints, "@Agent.constraints"),
    sections: readonlyPromptSections(options.sections, "@Agent.sections"),
    prompt: options.prompt,
    tools: readonlyClassList(options.tools),
    input: options.input,
    output: options.output,
    modelProfile: optionalText(options.modelProfile, "@Agent.modelProfile"),
    maxSteps: positiveInteger(options.maxSteps, "@Agent.maxSteps"),
    tasks: readonlyTaskList(carrier[TASK_META]),
  });
  carrier[AGENT_META] = normalized;
}

export function defineAgentTaskMetadata(methodName: string | symbol, metadata: object, options: AgentTaskOptions): void {
  if (typeof methodName !== "string") {
    throw new AgentSetupError("@Task supports string method names only.");
  }
  const normalized: AgentTaskMetadata = freezeWithoutUndefined({
    name: text(options.name, methodName, "@Task.name"),
    methodName,
    description: optionalText(options.description, "@Task.description"),
    input: options.input,
    output: options.output,
    modelProfile: optionalText(options.modelProfile, "@Task.modelProfile"),
    maxSteps: positiveInteger(options.maxSteps, "@Task.maxSteps"),
  });
  const carrier = ownCarrier(metadata);
  const existing = carrier[TASK_META] ?? Object.freeze([]);
  carrier[TASK_META] = Object.freeze([...existing, normalized]);
}

export function defineToolMetadata(_target: object, metadata: object, options: ToolOptions): void {
  const sideEffect = options.sideEffect ?? "none";
  if (sideEffect !== "none" && sideEffect !== "read" && sideEffect !== "write" && sideEffect !== "external") {
    throw new AgentSetupError("@Tool.sideEffect must be none, read, write or external.");
  }
  if (options.approval !== undefined && options.approval !== "never" && options.approval !== "policy" && options.approval !== "required") {
    throw new AgentSetupError("@Tool.approval must be never, policy or required.");
  }
  const normalized: ToolMetadata = Object.freeze({
    name: text(options.name, "", "@Tool.name"),
    description: text(options.description, "", "@Tool.description"),
    input: options.input,
    output: options.output,
    sideEffect,
    approval: approvalFor(sideEffect, options.approval),
    timeoutMs: positiveInteger(options.timeoutMs, "@Tool.timeoutMs"),
    tags: readonlyTextList(options.tags, "@Tool.tags"),
  });
  ownCarrier(metadata)[TOOL_META] = normalized;
}

export function definePromptMetadata(target: object, metadata: object, options: PromptOptions): void {
  const normalized: PromptMetadata = Object.freeze({
    name: text(options.name, classNameOf(target), "@Prompt.name"),
    description: optionalText(options.description, "@Prompt.description"),
    version: optionalText(options.version, "@Prompt.version"),
    role: optionalText(options.role, "@Prompt.role"),
    goal: optionalText(options.goal, "@Prompt.goal"),
    instructions: readonlyTextList(options.instructions, "@Prompt.instructions"),
    constraints: readonlyTextList(options.constraints, "@Prompt.constraints"),
    sections: readonlyPromptSections(options.sections, "@Prompt.sections"),
  });
  ownCarrier(metadata)[PROMPT_META] = normalized;
}

export function agentMetadataOf(ctor: object): AgentMetadata | undefined {
  const metadata = readCarrier(ctor);
  if (!metadata || !hasOwnMeta(metadata, AGENT_META)) {
    return undefined;
  }
  return metadata[AGENT_META];
}

export function agentTaskMetadataOf(ctor: object): readonly AgentTaskMetadata[] {
  const metadata = readCarrier(ctor);
  return metadata?.[TASK_META] ?? Object.freeze([]);
}

export function toolMetadataOf(ctor: object): ToolMetadata | undefined {
  const metadata = readCarrier(ctor);
  if (!metadata || !hasOwnMeta(metadata, TOOL_META)) {
    return undefined;
  }
  return metadata[TOOL_META];
}

export function promptMetadataOf(ctor: object): PromptMetadata | undefined {
  const metadata = readCarrier(ctor);
  if (!metadata || !hasOwnMeta(metadata, PROMPT_META)) {
    return undefined;
  }
  return metadata[PROMPT_META];
}
