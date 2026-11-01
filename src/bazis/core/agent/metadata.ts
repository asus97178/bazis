import type { Class } from "../di";
import { AgentSetupError } from "./errors";

// Bun executes TC39 decorators natively, but Symbol.metadata may be absent in
// the runtime. Keep the same tiny polyfill used by HTTP/background metadata.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const TOOL_META = Symbol.for("bazis:agent:tool");

export type ToolSideEffect = "none" | "read" | "write" | "external";

/** On whose behalf a Tool runs: a user, or the system (a process, a job). */
export interface ToolActor {
  readonly kind: "user" | "system";
  readonly id: string;
}
export type ToolApproval = "never" | "policy" | "required";
/** Whether a Tool can run without changing anything, when a process is tried out (WORKFLOW-002 §5.4). */
export type ToolDryRun = "supported" | "unsupported";

export interface ToolOptions {
  readonly name: string;
  readonly description: string;
  readonly input?: Class<object>;
  readonly output?: Class<object>;
  readonly sideEffect?: ToolSideEffect;
  readonly approval?: ToolApproval;
  readonly timeoutMs?: number;
  /** `"unsupported"` by default. */
  readonly dryRun?: ToolDryRun;
  /**
   * Who may call the Tool: `"agent"` for LLM agents, any other id for code that
   * runs Tools itself (`ToolRunner.as("workflow")`). Required and non-empty;
   * a caller not listed is refused with TOOL_CALLER_NOT_ALLOWED.
   */
  readonly callers: readonly string[];
  /** Grouping and search only; tags never decide who may call a Tool. */
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
  readonly dryRun: ToolDryRun;
  readonly callers: readonly string[];
  readonly tags: readonly string[];
}

interface MetadataCarrier {
  [TOOL_META]?: ToolMetadata;
}

function text(value: string | undefined, field: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    throw new AgentSetupError(`${field} must be a non-empty string.`);
  }
  return trimmed;
}

function readonlyTextList(values: readonly string[] | undefined, field: string): readonly string[] {
  if (values === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(values.map((value) => text(value, field)));
}

/** A caller id: `agent` or an application id such as `workflow`. */
export function callerId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(value)) {
    throw new AgentSetupError(`@Tool.callers: ${JSON.stringify(value)} is not a caller id such as "agent" or "workflow".`);
  }
  return value;
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

export function defineToolMetadata(_target: object, metadata: object, options: ToolOptions): void {
  const sideEffect = options.sideEffect ?? "none";
  if (sideEffect !== "none" && sideEffect !== "read" && sideEffect !== "write" && sideEffect !== "external") {
    throw new AgentSetupError("@Tool.sideEffect must be none, read, write or external.");
  }
  if (options.approval !== undefined && options.approval !== "never" && options.approval !== "policy" && options.approval !== "required") {
    throw new AgentSetupError("@Tool.approval must be never, policy or required.");
  }
  if (options.dryRun !== undefined && options.dryRun !== "supported" && options.dryRun !== "unsupported") {
    throw new AgentSetupError("@Tool.dryRun must be supported or unsupported.");
  }
  const normalized: ToolMetadata = Object.freeze({
    name: text(options.name, "@Tool.name"),
    description: text(options.description, "@Tool.description"),
    input: options.input,
    output: options.output,
    sideEffect,
    approval: approvalFor(sideEffect, options.approval),
    timeoutMs: positiveInteger(options.timeoutMs, "@Tool.timeoutMs"),
    dryRun: options.dryRun ?? "unsupported",
    // Checked when the module registers the Tool, so a missing list prints as
    // one configuration-error line at start instead of failing the import.
    callers: Array.isArray(options.callers) ? Object.freeze(options.callers.map((caller) => callerId(caller))) : Object.freeze([]),
    tags: readonlyTextList(options.tags, "@Tool.tags"),
  });
  (metadata as MetadataCarrier)[TOOL_META] = normalized;
}

export function toolMetadataOf(ctor: object): ToolMetadata | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as MetadataCarrier | undefined;
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, TOOL_META)) {
    return undefined;
  }
  return metadata[TOOL_META];
}
