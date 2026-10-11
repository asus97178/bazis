import type { Class } from "../di";
import { AgentSetupError } from "./errors";

// Bun executes TC39 decorators natively, but Symbol.metadata may be absent in
// the runtime. Keep the same tiny polyfill used by HTTP/background metadata.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const TOOL_META = Symbol.for("bazis:agent:tool");

export type ToolSideEffect = "none" | "read" | "write" | "external";
export type ToolApproval = "never" | "policy" | "required";

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
  const normalized: ToolMetadata = Object.freeze({
    name: text(options.name, "@Tool.name"),
    description: text(options.description, "@Tool.description"),
    input: options.input,
    output: options.output,
    sideEffect,
    approval: approvalFor(sideEffect, options.approval),
    timeoutMs: positiveInteger(options.timeoutMs, "@Tool.timeoutMs"),
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
