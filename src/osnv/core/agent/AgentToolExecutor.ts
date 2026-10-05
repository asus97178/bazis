import { ToolContractValidator, toolContractName, toolErrorMessage as errorMessageOf, type AgentToolSchemaValidator } from "./internal/ToolContract.validator";
import { ToolAuditProjector, type AgentToolAuditEntry, type AgentToolAuditFailureMode } from "./internal/ToolAudit.projector";
export type { AgentToolValidationIssue, AgentToolValidationResult, AgentToolSchemaValidator } from "./internal/ToolContract.validator";
export type { AgentToolAuditPhase, AgentToolAuditFailureMode, AgentToolAuditToolInfo, AgentToolAuditEntry } from "./internal/ToolAudit.projector";
import { DiContainer, type Class, type ServiceProvider, type ServiceScope } from "../di";
import { assertAgentToolHookIdV1, getAgentModuleContributionsV1, type AgentModuleContributionSnapshotV1, type AgentOwnedHookRegistrationV1 } from "./moduleContributions-v1";
import type { AgentToolBeforeEffectEventV1, AgentToolEnforcementDecisionV1, AgentToolHookContextV1, AgentToolRequiredHookRefV1, AgentToolAuditHookProjectionV1, AgentToolSettlementEventV1 } from "./AgentToolHooks";
import { agentModelJson } from "./internal/AgentModelBinding";
import { redactSensitive, type SensitiveRedactionOptions } from "../../library/redaction";
import { AgentSetupError, AgentToolExecutionError, AgentToolPreCommitError } from "./errors";
import type { AgentRegistry, ToolDefinition } from "./AgentRegistry";
import type { JsonObject, JsonValue, AgentToolCall, AgentToolResult } from "./semantic";
import { agentToolCall, agentToolResult, normalizeJsonValue } from "./semantic";

const DEFAULT_RETRYABLE_ERROR_CODES = new Set(["TOOL_EXECUTION_FAILED", "TOOL_RESOLVE_FAILED"]);
const NEVER_RETRY_ERROR_CODES = new Set([
  "TOOL_AUDIT_FAILED",
  "TOOL_AUDIT_FAILED_OUTCOME_UNKNOWN",
  "TOOL_SCOPE_DISPOSE_FAILED",
  "TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN",
  "TOOL_POST_EXECUTION_FAILED_OUTCOME_UNKNOWN",
  "TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN",
  "TOOL_TIMEOUT",
  "TOOL_TIMEOUT_OUTCOME_UNKNOWN",
  "TOOL_ABORTED",
  "TOOL_ABORTED_OUTCOME_UNKNOWN",
  "TOOL_HOOK_DENIED",
  "TOOL_HOOK_UNAVAILABLE",
  "TOOL_HOOK_FAILED",
  "TOOL_HOOK_TIMEOUT",
  "TOOL_HOOK_CANCELLED",
  "TOOL_HOOK_DECISION_INVALID",
  "TOOL_HOOK_AUDIT_FAILED",
  "TOOL_HOOK_REDACTION_FAILED",
  "TOOL_HOOK_SETTLEMENT_FAILED",
  "TOOL_HOOK_SETTLEMENT_OUTCOME_UNKNOWN",
]);
const DEFAULT_RETRY_SETTINGS: RetrySettings = Object.freeze({
  maxAttempts: 1,
  delayMs: 0,
  backoff: "none",
});
const DEFAULT_SCOPE_DISPOSE_TIMEOUT_MS = 5_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export type AgentToolExecutionApproval = "not-required" | "approved";
export type AgentToolApprovalReason = "policy" | "required";
export type AgentToolRetryBackoff = "none" | "fixed" | "exponential";

export interface AgentToolExecutionContext {
  readonly call: AgentToolCall;
  readonly tool: ToolDefinition;
  readonly agentName?: string;
  readonly invocationId?: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey?: string;
  readonly approval: AgentToolExecutionApproval;
  readonly metadata: JsonObject;
  readonly signal: AbortSignal;
}

export interface AgentExecutableTool {
  execute(input: unknown, context: AgentToolExecutionContext): unknown | Promise<unknown>;
}

export interface AgentToolApprovalRequest {
  readonly call: AgentToolCall;
  readonly tool: ToolDefinition;
  readonly reason: AgentToolApprovalReason;
  readonly agentName?: string;
  readonly invocationId?: string;
  readonly idempotencyKey?: string;
  readonly metadata: JsonObject;
  readonly signal?: AbortSignal;
}

export type AgentToolApprovalDecision = boolean | Promise<boolean>;
export type AgentToolApprovalFunction = (request: AgentToolApprovalRequest) => AgentToolApprovalDecision;

export interface AgentToolApprovalPolicyObject {
  approve(request: AgentToolApprovalRequest): AgentToolApprovalDecision;
}

export type AgentToolApprovalPolicy = AgentToolApprovalFunction | AgentToolApprovalPolicyObject;

export type AgentToolAuditFunction = (entry: AgentToolAuditEntry) => void | Promise<void>;

export interface AgentToolAuditSinkObject {
  record(entry: AgentToolAuditEntry): void | Promise<void>;
}

export type AgentToolAuditSink = AgentToolAuditFunction | AgentToolAuditSinkObject;

export interface AgentToolRetryPolicy {
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly maxDelayMs?: number;
  readonly backoff?: AgentToolRetryBackoff;
  readonly retryOnErrorCodes?: readonly string[];
}

export interface AgentToolExecutorOptions {
  readonly approvalPolicy?: AgentToolApprovalPolicy;
  readonly schemaValidator?: AgentToolSchemaValidator;
  readonly auditSink?: AgentToolAuditSink;
  readonly auditFailureMode?: AgentToolAuditFailureMode;
  readonly retryPolicy?: AgentToolRetryPolicy;
  /** Whole tool-call deadline. Defaults to 30 seconds; 0 explicitly disables it. */
  readonly defaultTimeoutMs?: number;
  /** Maximum time to wait for a tool DI scope disposer after execution settles. */
  readonly scopeDisposeTimeoutMs?: number;
  readonly allowUnboundTools?: boolean;
  readonly allowUnvalidatedSchemas?: boolean;
  /** Side-effecting tools require an audit sink unless this explicit escape hatch is set. */
  readonly allowUnauditedSideEffects?: boolean;
  /** Audit entries are redacted by default; pass false only for trusted local debugging. */
  readonly auditRedaction?: SensitiveRedactionOptions | false;
  readonly requiredPlatformHooks?: readonly AgentToolRequiredHookRefV1[];
  readonly hookRedaction?: SensitiveRedactionOptions;
}

export interface AgentToolExecutionOptions {
  readonly agentName?: string;
  readonly invocationId?: string;
  readonly metadata?: unknown;
  readonly approvalPolicy?: AgentToolApprovalPolicy;
  readonly schemaValidator?: AgentToolSchemaValidator;
  readonly auditSink?: AgentToolAuditSink;
  readonly auditFailureMode?: AgentToolAuditFailureMode;
  readonly retryPolicy?: AgentToolRetryPolicy;
  readonly idempotencyKey?: string;
  /** Whole tool-call deadline override; 0 explicitly disables it. */
  readonly timeoutMs?: number;
  /** Per-call override for the bounded DI scope disposal wait. */
  readonly scopeDisposeTimeoutMs?: number;
  readonly allowUnboundTools?: boolean;
  readonly allowUnvalidatedSchemas?: boolean;
  readonly allowUnauditedSideEffects?: boolean;
  readonly signal?: AbortSignal;
  /** Overrides executor-level audit redaction for this execution. */
  readonly auditRedaction?: SensitiveRedactionOptions | false;
}

interface ApprovalDecision {
  readonly allowed: boolean;
  readonly executionApproval: AgentToolExecutionApproval;
  readonly code?: string;
  readonly message?: string;
  readonly reason?: AgentToolApprovalReason;
}

interface AgentVisibilityDecision {
  readonly allowed: boolean;
  readonly agentName?: string;
  readonly code?: string;
  readonly message?: string;
  readonly status?: "error" | "denied";
}

interface SchemaValidationSettings {
  readonly validator?: AgentToolSchemaValidator;
  readonly allowUnvalidatedSchemas: boolean;
}

interface AuditSettings {
  readonly sink?: AgentToolAuditSink;
  readonly failureMode: AgentToolAuditFailureMode;
}

interface RetrySettings {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly maxDelayMs?: number;
  readonly backoff: AgentToolRetryBackoff;
  readonly retryOnErrorCodes?: ReadonlySet<string>;
}

interface AttemptContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey?: string;
}

interface ToolExecutionState {
  executeStarted: boolean;
  executeCompleted: boolean;
  phase: "pre-execute" | "execute" | "post-execute" | "result-audit";
  deadlineUnixMs?: number;
  beforeEffect?: AgentToolBeforeEffectEventV1;
  retryableCandidate?: boolean;
  callerSignal?: AbortSignal;
  timedOut?: boolean;
}

type PreparedToolValue =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly result: AgentToolResult };

class AgentToolTimeoutError extends Error {
  constructor() {
    super("Tool execution timed out.");
    this.name = "AgentToolTimeoutError";
  }
}

class AgentToolAbortError extends Error {
  constructor() {
    super("Tool execution was aborted.");
    this.name = "AgentToolAbortError";
  }
}

function isPlainJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMetadata(value: unknown): JsonObject {
  const normalized = normalizeJsonValue(value ?? {}, "toolExecution.metadata");
  if (!isPlainJsonObject(normalized)) {
    throw new AgentToolExecutionError("toolExecution.metadata must be a JSON object.");
  }
  return normalized;
}

function assertPositiveInteger(value: number | undefined, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentToolExecutionError(`${field} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number | undefined, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new AgentToolExecutionError(`${field} must be a non-negative integer.`);
  }
}

function normalizeOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AgentToolExecutionError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AgentToolExecutionError(`${field} must be a non-empty string.`);
  }
  return trimmed;
}

function approvalPolicyFunction(policy: AgentToolApprovalPolicy): AgentToolApprovalFunction {
  if (typeof policy === "function") {
    return policy;
  }
  return (request) => policy.approve(request);
}

function auditSinkFunction(sink: AgentToolAuditSink): AgentToolAuditFunction {
  if (typeof sink === "function") {
    return sink;
  }
  return (entry) => sink.record(entry);
}

function auditFailureModeOf(
  value: AgentToolAuditFailureMode | undefined,
  field: string,
): AgentToolAuditFailureMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "fail-closed" && value !== "best-effort") {
    throw new AgentToolExecutionError(`${field} must be fail-closed or best-effort.`);
  }
  return value;
}

function retryBackoffOf(value: AgentToolRetryBackoff | undefined, field: string): AgentToolRetryBackoff | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "none" && value !== "fixed" && value !== "exponential") {
    throw new AgentToolExecutionError(`${field} must be none, fixed or exponential.`);
  }
  return value;
}

function hasExecute(value: unknown): value is AgentExecutableTool {
  return typeof (value as { execute?: unknown }).execute === "function";
}

function isHookDecision(value: unknown): value is AgentToolEnforcementDecisionV1 {
  try {
    if (!isObjectRecord(value) || (value.decision !== "allow" && value.decision !== "deny")) return false;
    const allowed = value.decision === "allow" ? ["decision", "evidence"] : ["decision", "reasonCode", "message", "evidence"];
    if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
    if (value.decision === "deny" && ((value.reasonCode !== undefined && (typeof value.reasonCode !== "string" || value.reasonCode.length > 128)) || (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 512)))) return false;
    if (value.evidence !== undefined) normalizeHookEvidence(value.evidence);
    return true;
  } catch { return false; }
}

function normalizeHookEvidence(value: unknown): JsonObject {
  const normalized = normalizeJsonValue(value, "hook.evidence");
  if (!isPlainJsonObject(normalized)) throw new Error("hook evidence must be a JSON object");
  if (JSON.stringify(normalized).length > 32_768) throw new Error("hook evidence is too large");
  return normalized;
}

function isSettlementResult(value: unknown): value is { readonly status: "recorded"; readonly evidence?: JsonObject } {
  try {
    return isObjectRecord(value) && value.status === "recorded"
      && Object.keys(value).every((key) => key === "status" || key === "evidence")
      && (value.evidence === undefined || (normalizeHookEvidence(value.evidence), true));
  } catch { return false; }
}

type HookOutcome<T> = { readonly kind: "value"; readonly value: T } | { readonly kind: "timeout" } | { readonly kind: "cancelled" } | { readonly kind: "failed" };

async function awaitHook<T>(operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<HookOutcome<T>> {
  // Observe both branches even after the caller's deadline wins: a late hook
  // rejection must never become an unhandled process-level rejection.
  const observed: Promise<HookOutcome<T>> = operation
    .then((value): HookOutcome<T> => ({ kind: "value", value }))
    .catch((): HookOutcome<T> => ({ kind: "failed" }));
  if (signal?.aborted) return { kind: "cancelled" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detach: (() => void) | undefined;
  const boundary = new Promise<HookOutcome<T>>((resolve) => {
    const finish = (outcome: HookOutcome<T>) => {
      if (timer !== undefined) clearTimeout(timer);
      detach?.();
      resolve(outcome);
    };
    if (timeoutMs !== undefined) timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    if (signal) {
      const abort = () => finish({ kind: "cancelled" });
      signal.addEventListener("abort", abort, { once: true });
      detach = () => signal.removeEventListener("abort", abort);
    }
  });
  try {
    return await Promise.race([observed, boundary]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detach?.();
  }
}

function timed<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  abort: () => void,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new AgentToolAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new AgentToolAbortError()));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => finish(() => {
          reject(new AgentToolTimeoutError());
          abort();
        }), timeoutMs);

    operation.then(
      (value) => {
        finish(() => resolve(value));
      },
      (error: unknown) => {
        finish(() => reject(error));
      },
    );
  });
}

function attachAbortForwarding(source: AbortSignal | undefined, target: AbortController): (() => void) | undefined {
  if (source === undefined) return undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return undefined;
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export class AgentToolExecutor {
  private readonly approvalPolicy?: AgentToolApprovalPolicy;
  private readonly schemaValidator?: AgentToolSchemaValidator;
  private readonly auditSink?: AgentToolAuditSink;
  private readonly auditFailureMode: AgentToolAuditFailureMode;
  private readonly retryPolicy: RetrySettings;
  private readonly defaultTimeoutMs?: number;
  private readonly scopeDisposeTimeoutMs: number;
  private readonly allowUnboundTools: boolean;
  private readonly allowUnvalidatedSchemas: boolean;
  private readonly allowUnauditedSideEffects: boolean;
  private readonly auditProjector: ToolAuditProjector;
  private readonly contractValidator = new ToolContractValidator();
  private readonly hookRedaction: SensitiveRedactionOptions;
  private readonly hookSnapshot?: AgentModuleContributionSnapshotV1;
  private readonly requiredPlatformHooks: readonly AgentToolRequiredHookRefV1[];

  constructor(
    private readonly services: ServiceProvider,
    private readonly registry: AgentRegistry,
    options: AgentToolExecutorOptions = {},
  ) {
    assertNonNegativeInteger(options.defaultTimeoutMs, "AgentToolExecutor.defaultTimeoutMs");
    assertPositiveInteger(options.scopeDisposeTimeoutMs, "AgentToolExecutor.scopeDisposeTimeoutMs");
    this.approvalPolicy = options.approvalPolicy;
    this.schemaValidator = options.schemaValidator;
    this.auditSink = options.auditSink;
    this.auditFailureMode = auditFailureModeOf(options.auditFailureMode, "AgentToolExecutor.auditFailureMode") ?? "fail-closed";
    this.retryPolicy = this.normalizeRetryPolicy(options.retryPolicy, "AgentToolExecutor.retryPolicy");
    this.defaultTimeoutMs = options.defaultTimeoutMs === 0
      ? undefined
      : options.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.scopeDisposeTimeoutMs = options.scopeDisposeTimeoutMs ?? DEFAULT_SCOPE_DISPOSE_TIMEOUT_MS;
    this.allowUnboundTools = options.allowUnboundTools === true;
    this.allowUnvalidatedSchemas = options.allowUnvalidatedSchemas === true;
    this.allowUnauditedSideEffects = options.allowUnauditedSideEffects === true;
    this.auditProjector = new ToolAuditProjector(options.auditRedaction ?? {});
    // Hook projections are always canonical redaction (`***` and default
    // depth); callers may only extend the sensitive-key set.
    this.hookRedaction = Object.freeze({ sensitiveKeys: options.hookRedaction?.sensitiveKeys ?? [] });
    const requiredPlatformHooks = options.requiredPlatformHooks;
    if (requiredPlatformHooks !== undefined && !Array.isArray(requiredPlatformHooks)) {
      throw new AgentSetupError("requiredPlatformHooks must be an array.");
    }
    for (const reference of requiredPlatformHooks ?? []) this.assertRequiredPlatformHookRef(reference);
    this.requiredPlatformHooks = Object.freeze([...(requiredPlatformHooks ?? [])]);
    this.hookSnapshot = this.assertHookSetup(this.requiredPlatformHooks);
    if (this.hookSnapshot) {
      for (const tool of this.registry.listTools()) {
        const matches = this.hookSnapshot.tools.filter((entry) => entry.payload.target === tool.target);
        if (matches.length !== 1) throw new AgentSetupError(`Registered Tool "${tool.metadata.name}" must have exactly one owner-bound scoped contribution.`);
      }
    }
  }

  private assertHookSetup(required: readonly AgentToolRequiredHookRefV1[] | undefined): AgentModuleContributionSnapshotV1 | undefined {
    const requiredIdentities = new Set<string>();
    for (const reference of required ?? []) {
      const identity = `${reference.kind}:${reference.id}:${reference.version}`;
      if (requiredIdentities.has(identity)) throw new AgentSetupError(`Duplicate required Agent Tool hook "${identity}".`);
      requiredIdentities.add(identity);
    }
    if (!(this.services instanceof DiContainer)) {
      if (required && required.length > 0) {
        throw new AgentSetupError("requiredPlatformHooks require a framework DiContainer.");
      }
      return undefined;
    }
    const snapshot = getAgentModuleContributionsV1(this.services);
    const mandatory = snapshot.hooks.some(({ payload }) =>
      payload.registration.kind === "enforcement" || payload.registration.kind === "settlement",
    );
    if (mandatory && this.auditSink === undefined) {
      throw new AgentSetupError("Agent Tool enforcement and settlement hooks require constructor auditSink.");
    }
    for (const reference of required ?? []) {
      const found = snapshot.hooks.some(({ payload }) =>
        payload.owner === reference.owner
        && payload.registration.kind === reference.kind
        && payload.registration.id === reference.id
        && payload.registration.version === reference.version,
      );
      if (!found) {
        throw new AgentSetupError(`Required Agent Tool hook "${reference.kind}:${reference.id}@${reference.version}" is not contributed by its exact owner.`);
      }
    }
    return snapshot;
  }

  private assertRequiredPlatformHookRef(reference: unknown): asserts reference is AgentToolRequiredHookRefV1 {
    if (typeof reference !== "object" || reference === null) {
      throw new AgentSetupError("requiredPlatformHooks entries must be hook references.");
    }
    const candidate = reference as Partial<AgentToolRequiredHookRefV1>;
    if (typeof candidate.owner !== "function" && (typeof candidate.owner !== "object" || candidate.owner === null)) {
      throw new AgentSetupError("requiredPlatformHooks entry owner must be an OsnvModuleRef.");
    }
    if (candidate.kind !== "enforcement" && candidate.kind !== "settlement" && candidate.kind !== "observer") {
      throw new AgentSetupError("requiredPlatformHooks entry kind is invalid.");
    }
    assertAgentToolHookIdV1(candidate.id);
    const version = candidate.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
      throw new AgentSetupError("requiredPlatformHooks entry version must be a positive safe integer.");
    }
  }

  async execute(call: AgentToolCall, options: AgentToolExecutionOptions = {}): Promise<AgentToolResult> {
    const startedAt = Date.now();
    try {
      call = agentToolCall(call);
    } catch {
      const original = agentToolResult({
        callId: "invalid-tool-call",
        name: "invalid-tool",
        status: "error",
        error: { code: "TOOL_CALL_INVALID", message: "Tool call is invalid." },
        durationMs: Date.now() - startedAt,
        metadata: {},
      });
      const requestedTimeout = typeof options.timeoutMs === "number" && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 0
        ? (options.timeoutMs === 0 ? undefined : options.timeoutMs)
        : this.defaultTimeoutMs;
      const failed = await this.recordFrameworkTerminalAudit(original, startedAt, options.signal, requestedTimeout);
      return failed
        ? agentToolResult({ ...original, error: { code: "TOOL_HOOK_AUDIT_FAILED", message: "Agent Tool terminal audit could not be recorded." } })
        : original;
    }
    let metadata: JsonObject;
    let timeoutMs: number | undefined;
    try {
      metadata = normalizeMetadata(options.metadata);
      assertNonNegativeInteger(options.timeoutMs, "toolExecution.timeoutMs");
      const toolTimeoutMs = this.registry.getTool(call.name)?.metadata.timeoutMs;
      const configuredTimeoutMs = options.timeoutMs ?? toolTimeoutMs ?? this.defaultTimeoutMs;
      timeoutMs = configuredTimeoutMs === 0 ? undefined : configuredTimeoutMs;
    } catch (error) {
      return this.errorResult(call, "TOOL_EXECUTION_OPTIONS_INVALID", errorMessageOf(error), {}, startedAt);
    }

    const callerSignal = options.signal;
    const abortController = new AbortController();
    const detach = attachAbortForwarding(callerSignal, abortController);
    const state: ToolExecutionState = { executeStarted: false, executeCompleted: false, phase: "pre-execute", ...(timeoutMs === undefined ? {} : { deadlineUnixMs: startedAt + timeoutMs }), ...(callerSignal === undefined ? {} : { callerSignal }) };
    const operation = this.executePipeline(
      call,
      { ...options, signal: abortController.signal },
      state,
      startedAt,
    );
    try {
      return await timed(operation, timeoutMs, () => {
        state.timedOut = true;
        abortController.abort();
      }, abortController.signal);
    } catch (error) {
      const tool = this.registry.getTool(call.name);
      const sideEffecting = tool?.metadata.sideEffect === "write" || tool?.metadata.sideEffect === "external";
      const outcomeUnknown = sideEffecting && state.executeStarted;
      const effectPendingAtBoundary = state.executeStarted && !state.executeCompleted;
      const code = this.interruptionCode(error, tool, state);
      const result = this.errorResult(call, code, errorMessageOf(error), metadata, startedAt, {
        phase: state.phase,
        sideEffect: tool?.metadata.sideEffect ?? null,
      });
      if (this.hookSnapshot?.hooks.some(({ payload }) => payload.registration.kind === "settlement" || payload.registration.kind === "observer")) {
        try {
          const settled = await operation;
          // A pending effect cannot become known through a late hook result.
          // Completed tools retain the independent settlement/observer policy.
          return effectPendingAtBoundary && (settled.status === "success" || (outcomeUnknown && !settled.error?.code?.endsWith("_OUTCOME_UNKNOWN")))
            ? result : settled;
        } catch { return result; }
      }
      return result;
    } finally {
      detach?.();
    }
  }

  private interruptionCode(error: unknown, tool: ToolDefinition | undefined, state: ToolExecutionState): string {
    const unknown = state.executeStarted && (tool?.metadata.sideEffect === "write" || tool?.metadata.sideEffect === "external");
    if (state.timedOut || error instanceof AgentToolTimeoutError) {
      return unknown ? "TOOL_TIMEOUT_OUTCOME_UNKNOWN" : "TOOL_TIMEOUT";
    }
    if (error instanceof AgentToolAbortError) {
      return unknown ? "TOOL_ABORTED_OUTCOME_UNKNOWN" : "TOOL_ABORTED";
    }
    return "TOOL_EXECUTION_FAILED";
  }

  private settlementEvent(
    call: AgentToolCall,
    tool: ToolDefinition,
    result: AgentToolResult,
    options: AgentToolExecutionOptions,
    agentName: string | undefined,
    state: ToolExecutionState,
    attempt?: AttemptContext,
  ): AgentToolSettlementEventV1 {
    const terminal = Object.freeze({
      status: result.status,
      executeStarted: state.executeStarted,
      outcomeKnown: !String(result.error?.code ?? "").includes("OUTCOME_UNKNOWN"),
      retryable: state.retryableCandidate === true,
      ...(result.error ? { errorCode: result.error.code } : {}),
      ...(result.status === "success" ? { output: redactSensitive(result.output, this.hookRedaction) } : {}),
    });
    return Object.freeze({
      type: "agent-tool.settlement/v1",
      callId: call.id,
      toolName: tool.metadata.name,
      ...(options.invocationId === undefined ? {} : { invocationId: options.invocationId }),
      ...(agentName === undefined ? {} : { agentName }),
      ...(attempt === undefined ? {} : { attempt: attempt.attempt }),
      ...(state.beforeEffect === undefined ? {} : { beforeEffect: state.beforeEffect }),
      terminal,
    });
  }

  private async settleHooks(call: AgentToolCall, result: AgentToolResult, metadata: JsonObject, options: AgentToolExecutionOptions, startedAt: number, state: ToolExecutionState, event: AgentToolSettlementEventV1): Promise<AgentToolResult> {
    const snapshot = this.hookSnapshot;
    const tool = this.registry.getTool(call.name);
    if (!snapshot || !tool || snapshot.hooks.every(({ payload }) => payload.registration.kind !== "settlement")) return result;
    for (const record of this.orderedHooks(snapshot.hooks)) {
      const registration = record.payload.registration;
      if (registration.kind !== "settlement") continue;
      const scope = this.services.createScope();
      let terminal: AgentToolResult | undefined;
      let projection: AgentToolAuditHookProjectionV1 = {
        kind: registration.kind, id: registration.id, version: registration.version,
        tier: this.isPlatformHook(record) ? "platform" : "application", order: registration.order ?? 0,
        outcome: "failed",
      };
      const postEffect = state.executeStarted;
      const configuredTimeoutMs = registration.timeoutMs ?? 5_000;
      const remainingMs = !postEffect && state.deadlineUnixMs !== undefined
        ? Math.max(0, state.deadlineUnixMs - Date.now()) : undefined;
      const timeoutMs = remainingMs === undefined ? configuredTimeoutMs : Math.min(configuredTimeoutMs, remainingMs);
      const boundedTimeoutMs = Math.max(1, timeoutMs);
      const controller = new AbortController();
      const detach = postEffect ? undefined : attachAbortForwarding(options.signal, controller);
      try {
        if (!postEffect && (timeoutMs <= 0 || controller.signal.aborted)) {
          // No pre-effect budget remains. Do not activate a handler outside
          // its deadline; caller cancellation wins a simultaneous deadline.
          controller.abort();
          const cancelled = state.callerSignal?.aborted === true;
          const activated = await awaitHook(record.activation.activateAsync(scope), undefined, boundedTimeoutMs);
          if (activated.kind === "value") {
            const handler = activated.value as { settle?: unknown };
            if (typeof handler.settle === "function") {
              // Start the handler under its aborted context but never await it
              // outside the exhausted pre-effect budget.
              await awaitHook(
                Promise.resolve((handler.settle as (value: AgentToolSettlementEventV1, context: AgentToolHookContextV1) => unknown)(event, Object.freeze({ signal: controller.signal, deadlineUnixMs: Date.now() }))),
                controller.signal,
                0,
              );
            }
          }
          projection = { ...projection, outcome: cancelled ? "cancelled" : "timed-out" };
          terminal = this.errorResult(call, "TOOL_HOOK_SETTLEMENT_FAILED", "Agent Tool settlement deadline elapsed.", metadata, startedAt);
        } else {
        if (timeoutMs <= 0) controller.abort();
        const context: AgentToolHookContextV1 = Object.freeze({ signal: controller.signal, deadlineUnixMs: Date.now() + boundedTimeoutMs });
        // Caller cancellation is forwarded to the hook context, but required
        // settlement still invokes and records its terminal evidence.
        const activated = await awaitHook(record.activation.activateAsync(scope), controller.signal, boundedTimeoutMs);
        if (activated.kind !== "value") {
          if (activated.kind === "timeout") controller.abort();
          projection = { ...projection, outcome: activated.kind === "timeout" ? "timed-out" : activated.kind === "cancelled" ? (state.callerSignal?.aborted ? "cancelled" : "timed-out") : "failed" };
          terminal = this.errorResult(call, "TOOL_HOOK_SETTLEMENT_FAILED", "Agent Tool settlement handler was unavailable.", metadata, startedAt);
        } else {
          const handler = activated.value as { settle?: unknown };
          if (typeof handler.settle !== "function") {
            projection = { ...projection, outcome: "failed" };
            terminal = this.errorResult(call, "TOOL_HOOK_SETTLEMENT_FAILED", "Agent Tool settlement handler was unavailable.", metadata, startedAt);
          } else {
            const invocationTimeoutMs = Math.max(0, context.deadlineUnixMs - Date.now());
            const outcome = await awaitHook(Promise.resolve((handler.settle as (value: AgentToolSettlementEventV1, context: AgentToolHookContextV1) => unknown)(event, context)), controller.signal, invocationTimeoutMs);
            if (outcome.kind === "timeout") controller.abort();
            if (outcome.kind !== "value") {
              projection = { ...projection, outcome: outcome.kind === "timeout" ? "timed-out" : outcome.kind === "cancelled" ? (state.callerSignal?.aborted ? "cancelled" : "timed-out") : "failed" };
              terminal = this.errorResult(call, "TOOL_HOOK_SETTLEMENT_FAILED", "Agent Tool settlement failed.", metadata, startedAt);
            } else if (!isSettlementResult(outcome.value)) {
              projection = { ...projection, outcome: "invalid-result" };
              terminal = this.errorResult(call, "TOOL_HOOK_SETTLEMENT_FAILED", "Agent Tool settlement returned an invalid result.", metadata, startedAt);
            } else {
              const evidence = outcome.value.evidence === undefined ? undefined : redactSensitive(normalizeHookEvidence(outcome.value.evidence), this.hookRedaction) as JsonObject;
              projection = { ...projection, outcome: "recorded", ...(evidence === undefined ? {} : { evidence }) };
            }
          }
        }
        }
      } catch {
        projection = { ...projection, outcome: "failed" };
        terminal = this.errorResult(call, "TOOL_HOOK_SETTLEMENT_FAILED", "Agent Tool settlement failed.", metadata, startedAt);
      } finally {
        detach?.();
        const disposeError = await this.disposeScope(scope, this.scopeDisposeTimeoutMs);
        if (disposeError !== undefined) {
          projection = { ...projection, outcome: "failed" };
          terminal = this.errorResult(call, "TOOL_HOOK_SETTLEMENT_FAILED", "Agent Tool settlement disposal failed.", metadata, startedAt);
        }
      }
      const evidenceRemainingMs = postEffect || state.deadlineUnixMs === undefined
        ? registration.timeoutMs ?? 5_000
        : Math.max(0, Math.min(registration.timeoutMs ?? 5_000, state.deadlineUnixMs - Date.now()));
      if (await this.recordMandatoryHook("settlement", call, tool, metadata, options, startedAt, projection, evidenceRemainingMs, postEffect ? undefined : options.signal)) {
        terminal = this.errorResult(call, "TOOL_HOOK_SETTLEMENT_FAILED", "Agent Tool settlement evidence could not be recorded.", metadata, startedAt);
      }
      if (terminal !== undefined) {
        if (result.error?.code === "TOOL_HOOK_CANCELLED" || result.error?.code === "TOOL_ABORTED") return result;
        const unknown = (postEffect || result.status === "success")
          && (tool.metadata.sideEffect === "write" || tool.metadata.sideEffect === "external");
        return unknown
          ? this.errorResult(call, "TOOL_HOOK_SETTLEMENT_OUTCOME_UNKNOWN", "Agent Tool settlement outcome is unknown.", metadata, startedAt)
          : terminal;
      }
    }
    return result;
  }

  private async observeHooks(settlement: AgentToolSettlementEventV1, options: AgentToolExecutionOptions): Promise<void> {
    const snapshot = this.hookSnapshot;
    if (!snapshot) return;
    for (const record of this.orderedHooks(snapshot.hooks)) {
      const registration = record.payload.registration;
      if (registration.kind !== "observer") continue;
      const scope = this.services.createScope();
      let outcome: AgentToolAuditHookProjectionV1["outcome"] = "failed";
      const timeoutMs = registration.timeoutMs ?? 5_000;
      const controller = new AbortController();
      const detach = attachAbortForwarding(options.signal, controller);
      try {
        const context: AgentToolHookContextV1 = Object.freeze({ signal: controller.signal, deadlineUnixMs: Date.now() + timeoutMs });
        const activated = await awaitHook(record.activation.activateAsync(scope), controller.signal, timeoutMs);
        if (activated.kind !== "value") {
          if (activated.kind === "timeout") controller.abort();
          outcome = activated.kind === "timeout" ? "timed-out" : activated.kind === "cancelled" ? "cancelled" : "failed";
        } else {
          const handler = activated.value as { observe?: unknown };
          if (typeof handler.observe !== "function") {
            outcome = "failed";
          } else {
            const observed = await awaitHook(
              Promise.resolve((handler.observe as (event: { readonly type: "agent-tool.observer/v1"; readonly settlement: AgentToolSettlementEventV1 }, context: AgentToolHookContextV1) => unknown)({ type: "agent-tool.observer/v1", settlement }, context)),
              controller.signal,
              Math.max(1, context.deadlineUnixMs - Date.now()),
            );
            if (observed.kind === "timeout" || observed.kind === "value") controller.abort();
            outcome = observed.kind === "value" ? "recorded" : observed.kind === "timeout" ? "timed-out" : observed.kind === "cancelled" ? "cancelled" : "failed";
          }
        }
      } catch {
        outcome = controller.signal.aborted && options.signal?.aborted ? "cancelled" : "failed";
      } finally {
        detach?.();
        if (await this.disposeScope(scope, this.scopeDisposeTimeoutMs) !== undefined) outcome = "failed";
      }
      await this.recordObserverHook(settlement, registration, record, outcome, timeoutMs);
    }
  }

  private async recordObserverHook(
    settlement: AgentToolSettlementEventV1,
    registration: Extract<AgentOwnedHookRegistrationV1["payload"]["registration"], { readonly kind: "observer" }>,
    record: AgentOwnedHookRegistrationV1,
    outcome: AgentToolAuditHookProjectionV1["outcome"],
    timeoutMs: number,
  ): Promise<void> {
    if (!this.auditSink) return;
    const projection: AgentToolAuditHookProjectionV1 = Object.freeze({
      kind: registration.kind, id: registration.id, version: registration.version,
      tier: this.isPlatformHook(record) ? "platform" : "application", order: registration.order ?? 0, outcome,
    });
    const entry: AgentToolAuditEntry = Object.freeze({
      kind: "agent-tool", phase: "observer", callId: settlement.callId, toolName: settlement.toolName,
      input: Object.freeze({}), metadata: Object.freeze({}), hook: projection,
      startedAtUnixMs: Date.now(), finishedAtUnixMs: Date.now(), durationMs: 0,
    });
    // Observer evidence is deliberately best effort and uses an independent
    // bounded write: it cannot alter the already-terminal Tool result.
    await awaitHook(Promise.resolve().then(() => auditSinkFunction(this.auditSink!)(entry)), undefined, timeoutMs);
  }

  private async executePipeline(
    call: AgentToolCall,
    options: AgentToolExecutionOptions,
    executionState: ToolExecutionState,
    startedAt: number,
  ): Promise<AgentToolResult> {
    let metadata: JsonObject;
    let audit: AuditSettings;
    let retry: RetrySettings;
    let idempotencyKey: string | undefined;
    try {
      metadata = normalizeMetadata(options.metadata);
      assertNonNegativeInteger(options.timeoutMs, "toolExecution.timeoutMs");
      assertPositiveInteger(options.scopeDisposeTimeoutMs, "toolExecution.scopeDisposeTimeoutMs");
      retry = this.retrySettings(options);
      idempotencyKey = normalizeOptionalText(options.idempotencyKey, "toolExecution.idempotencyKey");
      audit = this.auditSettings(options);
    } catch (error) {
      return this.errorResult(call, "TOOL_EXECUTION_OPTIONS_INVALID", errorMessageOf(error), {}, startedAt);
    }

    const tool = this.registry.getTool(call.name);
    if (!tool) {
      const original = this.errorResult(
        call,
        "TOOL_NOT_REGISTERED",
        `Tool "${call.name}" is not registered.`,
        metadata,
        startedAt,
      );
      const frameworkAuditFailed = await this.recordFrameworkTerminalAudit(original, startedAt, options.signal, executionState.deadlineUnixMs === undefined ? undefined : Math.max(0, executionState.deadlineUnixMs - Date.now()));
      const result = frameworkAuditFailed
        ? this.errorResult(call, "TOOL_HOOK_AUDIT_FAILED", "Agent Tool terminal audit could not be recorded.", metadata, startedAt)
        : original;
      if (this.hasMandatoryHooks()) return result;
      return this.finish(call, result, startedAt, metadata, options, audit, undefined, undefined, undefined, executionState);
    }

    if (
      (tool.metadata.sideEffect === "write" || tool.metadata.sideEffect === "external")
      && audit.sink === undefined
      && !(options.allowUnauditedSideEffects ?? this.allowUnauditedSideEffects)
    ) {
      const result = this.errorResult(
        call,
        "TOOL_AUDIT_REQUIRED",
        `Tool "${tool.metadata.name}" has side effects and requires an audit sink.`,
        metadata,
        startedAt,
      );
      return this.finish(call, result, startedAt, metadata, options, audit, tool, options.agentName, undefined, executionState);
    }

    const visibility = this.authorizeAgent(tool, options);
    if (!visibility.allowed) {
      const code = visibility.code ?? "TOOL_NOT_VISIBLE_TO_AGENT";
      const message = visibility.message ?? `Tool "${tool.metadata.name}" is not visible to this agent.`;
      if (visibility.status === "denied") {
        const result = this.deniedResult(
          call,
          code,
          message,
          { toolName: tool.metadata.name, agentName: options.agentName ?? "" },
          metadata,
          startedAt,
        );
        return this.finish(call, result, startedAt, metadata, options, audit, tool, options.agentName, undefined, executionState);
      }
      const result = this.errorResult(call, code, message, metadata, startedAt);
      return this.finish(call, result, startedAt, metadata, options, audit, tool, options.agentName, undefined, executionState);
    }

    const schema = this.schemaSettings(options);
    const schemaGate = this.ensureSchemaValidator(call, tool, schema, metadata, startedAt);
    if (schemaGate) {
      return this.finish(call, schemaGate, startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }

    // Validation belongs to the same admitted attempt deadline.  Its promise
    // is observed before racing so a late validator rejection stays handled.
    const validationRemainingMs = executionState.deadlineUnixMs === undefined
      ? undefined
      : Math.max(0, executionState.deadlineUnixMs - Date.now());
    const inputOutcome = await awaitHook(
      this.prepareInput(call, tool, schema, metadata, startedAt),
      options.signal,
      validationRemainingMs,
    );
    if (inputOutcome.kind === "timeout") {
      return this.finish(call, this.errorResult(call, "TOOL_TIMEOUT", "Tool execution timed out during input validation.", metadata, startedAt, { phase: "pre-execute" }), startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }
    if (inputOutcome.kind === "cancelled" || options.signal?.aborted) {
      const cancelled = executionState.callerSignal?.aborted === true;
      return this.finish(call, this.errorResult(call, cancelled ? "TOOL_ABORTED" : "TOOL_TIMEOUT", cancelled ? "Tool execution was aborted during input validation." : "Tool execution timed out during input validation.", metadata, startedAt, { phase: "pre-execute" }), startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }
    if (inputOutcome.kind === "failed") {
      return this.finish(call, this.errorResult(call, "TOOL_SCHEMA_VALIDATION_FAILED", "Tool input schema validation failed.", metadata, startedAt), startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }
    const input = inputOutcome.value;
    if (!input.ok) {
      return this.finish(call, input.result, startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }
    const effectiveCall = this.effectiveCall(call, tool, input.value);
    const effectiveInput = this.freezeToolInput(input.value);

    const approvalRemainingMs = executionState.deadlineUnixMs === undefined
      ? undefined : Math.max(0, executionState.deadlineUnixMs - Date.now());
    const approvalOutcome = await awaitHook(
      this.authorize(effectiveCall, tool, metadata, options, idempotencyKey),
      options.signal,
      approvalRemainingMs,
    );
    if (approvalOutcome.kind !== "value") {
      const code = approvalOutcome.kind === "cancelled" && executionState.callerSignal?.aborted === true ? "TOOL_ABORTED" : "TOOL_TIMEOUT";
      return this.finish(effectiveCall, this.errorResult(effectiveCall, code, code === "TOOL_ABORTED" ? "Tool execution was aborted during approval." : "Tool execution timed out during approval.", metadata, startedAt, { phase: "pre-execute" }), startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }
    const approval = approvalOutcome.value;
    if (options.signal?.aborted) {
      const cancelled = executionState.callerSignal?.aborted === true;
      return this.finish(effectiveCall, this.errorResult(effectiveCall, cancelled ? "TOOL_ABORTED" : "TOOL_TIMEOUT", cancelled ? "Tool execution was aborted during approval." : "Tool execution timed out during approval.", metadata, startedAt, { phase: "pre-execute" }), startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }
    if (!approval.allowed) {
      const result = this.deniedResult(
        effectiveCall,
        approval.code ?? "TOOL_APPROVAL_DENIED",
        approval.message ?? "Tool execution was denied by approval policy.",
        {
          sideEffect: tool.metadata.sideEffect,
          approval: tool.metadata.approval,
          reason: approval.reason ?? tool.metadata.approval,
        },
        metadata,
        startedAt,
      );
      return this.finish(effectiveCall, result, startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }

    const retryGate = this.ensureRetryPolicy(effectiveCall, tool, retry, idempotencyKey, metadata, startedAt);
    if (retryGate) {
      return this.finish(effectiveCall, retryGate, startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    }

    let result: AgentToolResult | undefined;
    let finalAttempt: AttemptContext | undefined;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      executionState.retryableCandidate = false;
      const attemptContext: AttemptContext = Object.freeze({
        attempt,
        maxAttempts: retry.maxAttempts,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      });
      const auditRemainingMs = executionState.deadlineUnixMs === undefined
        ? undefined : Math.max(0, executionState.deadlineUnixMs - Date.now());
      const auditAttemptOutcome = await this.audit(
        this.auditProjector.create("attempt", effectiveCall, startedAt, metadata, options, tool, visibility.agentName, undefined, attemptContext),
        audit,
        effectiveCall,
        metadata,
        startedAt,
        undefined,
        options.signal,
        auditRemainingMs,
      );
      if (auditAttemptOutcome.kind !== "value") {
        const code = auditAttemptOutcome.kind === "cancelled" && executionState.callerSignal?.aborted === true ? "TOOL_ABORTED" : "TOOL_TIMEOUT";
        return this.finish(effectiveCall, this.errorResult(effectiveCall, code, code === "TOOL_ABORTED" ? "Tool execution was aborted during attempt audit." : "Tool execution timed out during attempt audit.", this.attemptMetadata(metadata, attemptContext), startedAt, { phase: "pre-execute" }), startedAt, metadata, options, audit, tool, visibility.agentName, attemptContext, executionState);
      }
      const auditAttemptError = auditAttemptOutcome.value;
      if (options.signal?.aborted) {
        const cancelled = executionState.callerSignal?.aborted === true;
        return this.finish(effectiveCall, this.errorResult(
          effectiveCall,
          cancelled ? "TOOL_ABORTED" : "TOOL_TIMEOUT",
          cancelled ? "Tool execution was aborted during attempt audit." : "Tool execution timed out during attempt audit.",
          this.attemptMetadata(metadata, attemptContext),
          startedAt,
          { phase: "pre-execute" },
        ), startedAt, metadata, options, audit, tool, visibility.agentName, attemptContext, executionState);
      }
      if (auditAttemptError) {
        return this.finish(effectiveCall, auditAttemptError, startedAt, metadata, options, audit, tool, visibility.agentName, attemptContext, executionState);
      }

      finalAttempt = attemptContext;
      const enforcement = await this.enforceHooks(
        effectiveCall,
        tool,
        approval.executionApproval,
        visibility.agentName,
        metadata,
        options,
        startedAt,
        attemptContext,
        executionState,
      );
      if (enforcement !== undefined) {
        result = await this.finish(effectiveCall, enforcement, startedAt, metadata, options, audit, tool, visibility.agentName, attemptContext, executionState);
        break;
      }
      result = await this.executeAttempt(
        effectiveCall,
        tool,
        effectiveInput,
        approval.executionApproval,
        visibility.agentName,
        metadata,
        schema,
        options,
        audit,
        startedAt,
        attemptContext,
        executionState,
      );
      executionState.retryableCandidate = this.shouldRetry(result, retry, attempt);

      result = await this.finish(effectiveCall, result, startedAt, metadata, options, audit, tool, visibility.agentName, attemptContext, executionState);

      if (options.signal?.aborted) {
        return result;
      }

      if (!this.shouldRetry(result, retry, attempt)) {
        break;
      }
      if (await this.delayBeforeRetry(retry, attempt, options.signal)) {
        result = this.errorResult(
          effectiveCall,
          "TOOL_ABORTED",
          "Tool retry was aborted.",
          this.attemptMetadata(metadata, attemptContext),
          startedAt,
          { phase: executionState.phase },
        );
        result = await this.finish(effectiveCall, result, startedAt, metadata, options, audit, tool, visibility.agentName, attemptContext, executionState);
        break;
      }
    }

    if (!result || !finalAttempt) {
      result = this.errorResult(effectiveCall, "TOOL_RETRY_POLICY_INVALID", "Tool retry policy produced no execution attempts.", metadata, startedAt);
    }
    if (!finalAttempt) return this.finish(effectiveCall, result, startedAt, metadata, options, audit, tool, visibility.agentName, undefined, executionState);
    return result;
  }

  private async enforceHooks(
    call: AgentToolCall,
    tool: ToolDefinition,
    approval: AgentToolExecutionApproval,
    agentName: string | undefined,
    metadata: JsonObject,
    options: AgentToolExecutionOptions,
    startedAt: number,
    attempt: AttemptContext,
    executionState: ToolExecutionState,
  ): Promise<AgentToolResult | undefined> {
    const snapshot = this.hookSnapshot;
    if (!snapshot || snapshot.hooks.length === 0) return undefined;
    let event: AgentToolBeforeEffectEventV1;
    try {
      event = Object.freeze({
        type: "agent-tool.before-effect/v1",
        ...(options.invocationId === undefined ? {} : { invocationId: options.invocationId }),
        ...(agentName === undefined ? {} : { agentName }),
        attempt: attempt.attempt,
        maxAttempts: attempt.maxAttempts,
        ...(attempt.idempotencyKey === undefined ? {} : { idempotencyKey: attempt.idempotencyKey }),
        call: Object.freeze({ id: call.id, name: call.name, input: redactSensitive(normalizeJsonValue(call.input, "hook.call.input"), this.hookRedaction), metadata: redactSensitive(normalizeMetadata(metadata), this.hookRedaction) as JsonObject }),
        tool: Object.freeze({ name: tool.metadata.name, description: tool.metadata.description, sideEffect: tool.metadata.sideEffect, approval: tool.metadata.approval, tags: Object.freeze([...(tool.metadata.tags ?? [])]) }),
        executionApproval: approval,
      });
    } catch {
      return this.errorResult(call, "TOOL_HOOK_REDACTION_FAILED", "Agent Tool hook projection could not be safely prepared.", metadata, startedAt);
    }
    executionState.beforeEffect = event;
    const isPlatform = (record: AgentOwnedHookRegistrationV1): boolean => this.isPlatformHook(record);
    const hooks = this.orderedHooks(snapshot.hooks);
    for (const record of hooks) {
      const registration = record.payload.registration;
      if (registration.kind !== "enforcement") continue;
      const scope = this.services.createScope();
      let terminal: AgentToolResult | undefined;
      let projection: AgentToolAuditHookProjectionV1 = {
        kind: registration.kind, id: registration.id, version: registration.version,
        tier: isPlatform(record) ? "platform" : "application", order: registration.order ?? 0,
        outcome: "failed",
      };
      const configuredTimeoutMs = registration.timeoutMs ?? 5_000;
      const remainingMs = executionState.deadlineUnixMs === undefined
        ? undefined : Math.max(0, executionState.deadlineUnixMs - Date.now());
      const timeoutMs = remainingMs === undefined ? configuredTimeoutMs : Math.min(configuredTimeoutMs, remainingMs);
      const controller = new AbortController();
      const detach = attachAbortForwarding(options.signal, controller);
      try {
        if (timeoutMs <= 0) {
          controller.abort();
          projection = { ...projection, outcome: "timed-out" };
          terminal = this.errorResult(call, "TOOL_HOOK_TIMEOUT", "Agent Tool enforcement deadline elapsed.", metadata, startedAt);
        } else {
        const context: AgentToolHookContextV1 = Object.freeze({ signal: controller.signal, deadlineUnixMs: Date.now() + timeoutMs });
        const activated = await awaitHook(record.activation.activateAsync(scope), controller.signal, timeoutMs);
        if (activated.kind !== "value") {
          if (activated.kind === "timeout") controller.abort();
          projection = { ...projection, outcome: activated.kind === "timeout" ? "timed-out" : activated.kind === "cancelled" ? "cancelled" : "failed" };
          terminal = this.errorResult(call, activated.kind === "timeout" ? "TOOL_HOOK_TIMEOUT" : activated.kind === "cancelled" ? "TOOL_HOOK_CANCELLED" : "TOOL_HOOK_UNAVAILABLE", "Agent Tool enforcement handler was unavailable.", metadata, startedAt);
        } else {
          const handler = activated.value as { enforce?: unknown };
          if (typeof handler.enforce !== "function") {
            terminal = this.errorResult(call, "TOOL_HOOK_UNAVAILABLE", "Agent Tool enforcement handler was unavailable.", metadata, startedAt);
          } else {
            const outcome = await awaitHook(Promise.resolve((handler.enforce as (value: AgentToolBeforeEffectEventV1, context: AgentToolHookContextV1) => AgentToolEnforcementDecisionV1 | Promise<AgentToolEnforcementDecisionV1>)(event, context)), controller.signal, Math.max(0, context.deadlineUnixMs - Date.now()));
            if (outcome.kind === "timeout") controller.abort();
            if (outcome.kind === "timeout") { projection = { ...projection, outcome: "timed-out" }; terminal = this.errorResult(call, "TOOL_HOOK_TIMEOUT", "Agent Tool enforcement hook timed out.", metadata, startedAt); }
            else if (outcome.kind === "cancelled") { projection = { ...projection, outcome: "cancelled" }; terminal = this.errorResult(call, "TOOL_HOOK_CANCELLED", "Agent Tool enforcement hook was cancelled.", metadata, startedAt); }
            else if (outcome.kind === "failed") { terminal = this.errorResult(call, "TOOL_HOOK_FAILED", "Agent Tool enforcement hook failed.", metadata, startedAt); }
            else if (!isHookDecision(outcome.value)) { projection = { ...projection, outcome: "invalid-result" }; terminal = this.errorResult(call, "TOOL_HOOK_DECISION_INVALID", "Agent Tool enforcement hook returned an invalid decision.", metadata, startedAt); }
            else {
              const decision = outcome.value;
              projection = { ...projection, outcome: decision.decision === "allow" ? "allowed" : "denied", ...(decision.decision === "deny" && decision.reasonCode ? { reasonCode: decision.reasonCode } : {}), ...(decision.evidence ? { evidence: redactSensitive(normalizeHookEvidence(decision.evidence), this.hookRedaction) as JsonObject } : {}) };
              if (decision.decision === "deny") terminal = this.deniedResult(call, "TOOL_HOOK_DENIED", "Tool execution was denied by an enforcement hook.", {}, metadata, startedAt);
            }
          }
        }
        }
      } catch {
        projection = { ...projection, outcome: "failed" };
        terminal = this.errorResult(call, options.signal?.aborted ? "TOOL_HOOK_CANCELLED" : "TOOL_HOOK_FAILED", "Agent Tool enforcement hook failed.", metadata, startedAt);
      } finally {
        detach?.();
        const disposeError = await this.disposeScope(scope, this.scopeDisposeTimeoutMs);
        if (disposeError !== undefined) {
          projection = { ...projection, outcome: "failed" };
          terminal = this.errorResult(call, "TOOL_HOOK_FAILED", "Agent Tool enforcement hook disposal failed.", metadata, startedAt);
        }
      }
      const evidenceRemainingMs = executionState.deadlineUnixMs === undefined
        ? registration.timeoutMs ?? 5_000
        : Math.max(0, Math.min(registration.timeoutMs ?? 5_000, executionState.deadlineUnixMs - Date.now()));
      // Mandatory evidence records the cancellation terminal itself. It keeps
      // the remaining absolute deadline, but does not inherit the already
      // aborted caller signal and thereby erase that terminal classification.
      if (await this.recordMandatoryHook("enforcement", call, tool, metadata, options, startedAt, projection, evidenceRemainingMs)) {
        return this.errorResult(call, "TOOL_HOOK_AUDIT_FAILED", "Agent Tool enforcement evidence could not be recorded.", metadata, startedAt);
      }
      if (terminal !== undefined) return terminal;
    }
    return undefined;
  }

  private isPlatformHook(record: AgentOwnedHookRegistrationV1): boolean {
    return this.requiredPlatformHooks.some((reference) => reference.owner === record.payload.owner && reference.kind === record.payload.registration.kind && reference.id === record.payload.registration.id && reference.version === record.payload.registration.version);
  }

  private orderedHooks(records: readonly AgentOwnedHookRegistrationV1[]): readonly AgentOwnedHookRegistrationV1[] {
    return [...records].sort((left, right) => {
      const leftRegistration = left.payload.registration;
      const rightRegistration = right.payload.registration;
      return Number(this.isPlatformHook(right)) - Number(this.isPlatformHook(left))
        || (leftRegistration.order ?? 0) - (rightRegistration.order ?? 0)
        || leftRegistration.id.localeCompare(rightRegistration.id)
        || leftRegistration.version - rightRegistration.version
        || left.ownerName.localeCompare(right.ownerName);
    });
  }

  private async recordMandatoryHook(
    phase: "enforcement" | "settlement",
    call: AgentToolCall, tool: ToolDefinition, metadata: JsonObject, options: AgentToolExecutionOptions, startedAt: number,
    hook: AgentToolAuditHookProjectionV1,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.auditSink) return true;
    try {
      const outcome = await awaitHook(Promise.resolve().then(() => auditSinkFunction(this.auditSink!)({ kind: "agent-tool", phase, callId: call.id, toolName: tool.metadata.name, input: redactSensitive(normalizeJsonValue(call.input, "hook.audit.input"), this.hookRedaction), tool: { name: tool.metadata.name, sideEffect: tool.metadata.sideEffect, approval: tool.metadata.approval, tags: tool.metadata.tags ?? [] }, startedAtUnixMs: startedAt, finishedAtUnixMs: Date.now(), durationMs: Date.now() - startedAt, metadata: redactSensitive(metadata, this.hookRedaction) as JsonObject, hook })), signal, timeoutMs);
      return outcome.kind !== "value";
    } catch { return true; }
  }

  private frameworkTerminalAuditTimeout(remainingMs: number | undefined): number {
    const hookBound = this.hookSnapshot!.hooks
      .filter(({ payload }) => payload.registration.kind === "enforcement" || payload.registration.kind === "settlement")
      .reduce((bound, { payload }) => Math.min(bound, payload.registration.timeoutMs ?? 5_000), Number.POSITIVE_INFINITY);
    return remainingMs === undefined ? hookBound : Math.min(hookBound, Math.max(0, remainingMs));
  }

  private async recordFrameworkTerminalAudit(result: AgentToolResult, startedAt: number, signal: AbortSignal | undefined, remainingMs: number | undefined): Promise<boolean> {
    if (!this.hasMandatoryHooks() || !this.auditSink) return false;
    try {
      const timeoutMs = this.frameworkTerminalAuditTimeout(remainingMs);
      const outcome = await awaitHook(Promise.resolve().then(() => auditSinkFunction(this.auditSink!)({
        kind: "agent-tool", phase: "result", callId: result.callId, toolName: result.name,
        input: Object.freeze({}), metadata: Object.freeze({}),
        result: redactSensitive(result, this.hookRedaction) as AgentToolResult,
        startedAtUnixMs: startedAt, finishedAtUnixMs: Date.now(), durationMs: Date.now() - startedAt,
      })), signal, timeoutMs);
      return outcome.kind !== "value";
    } catch { return true; }
  }

  private hasMandatoryHooks(): boolean {
    return this.hookSnapshot?.hooks.some(({ payload }) =>
      payload.registration.kind === "enforcement" || payload.registration.kind === "settlement",
    ) === true;
  }

  private authorizeAgent(
    tool: ToolDefinition,
    options: AgentToolExecutionOptions,
  ): AgentVisibilityDecision {
    const allowUnboundTools = options.allowUnboundTools ?? this.allowUnboundTools;
    if (!options.agentName) {
      if (allowUnboundTools) {
        return { allowed: true };
      }
      return {
        allowed: false,
        code: "TOOL_AGENT_REQUIRED",
        message: `Tool "${tool.metadata.name}" execution requires agentName.`,
        status: "error",
      };
    }

    const agent = this.registry.getAgent(options.agentName);
    if (!agent) {
      return {
        allowed: false,
        code: "AGENT_NOT_REGISTERED",
        message: `Agent "${options.agentName}" is not registered.`,
        status: "error",
      };
    }

    for (let index = 0; index < agent.tools.length; index += 1) {
      const visible = agent.tools[index] as ToolDefinition;
      if (visible.target === tool.target || visible.metadata.name === tool.metadata.name) {
        return { allowed: true, agentName: agent.metadata.name };
      }
    }

    return {
      allowed: false,
      agentName: agent.metadata.name,
      code: "TOOL_NOT_VISIBLE_TO_AGENT",
      message: `Tool "${tool.metadata.name}" is not visible to agent "${agent.metadata.name}".`,
      status: "denied",
    };
  }

  private async authorize(
    call: AgentToolCall,
    tool: ToolDefinition,
    metadata: JsonObject,
    options: AgentToolExecutionOptions,
    idempotencyKey: string | undefined,
  ): Promise<ApprovalDecision> {
    const approval = tool.metadata.approval;
    if (approval === "never") {
      return { allowed: true, executionApproval: "not-required" };
    }

    const policy = options.approvalPolicy ?? this.approvalPolicy;
    if (!policy) {
      if (approval === "policy" && (tool.metadata.sideEffect === "none" || tool.metadata.sideEffect === "read")) {
        return { allowed: true, executionApproval: "not-required" };
      }
      return {
        allowed: false,
        executionApproval: "not-required",
        code: approval === "required" ? "TOOL_APPROVAL_REQUIRED" : "TOOL_APPROVAL_POLICY_MISSING",
        message:
          approval === "required"
            ? `Tool "${tool.metadata.name}" requires explicit approval.`
            : `Tool "${tool.metadata.name}" requires an approval policy.`,
        reason: approval,
      };
    }

    const reason: AgentToolApprovalReason = approval === "required" ? "required" : "policy";
    try {
      const approved = await approvalPolicyFunction(policy)({
        call,
        tool,
        reason,
        agentName: options.agentName,
        invocationId: options.invocationId,
        idempotencyKey,
        metadata,
        signal: options.signal,
      });
      if (approved === true) {
        return { allowed: true, executionApproval: "approved" };
      }
      return {
        allowed: false,
        executionApproval: "not-required",
        code: "TOOL_APPROVAL_DENIED",
        message: `Tool "${tool.metadata.name}" was denied by approval policy.`,
        reason,
      };
    } catch (error) {
      return {
        allowed: false,
        executionApproval: "not-required",
        code: "TOOL_APPROVAL_FAILED",
        message: `Tool approval policy failed: ${errorMessageOf(error)}`,
        reason,
      };
    }
  }

  private schemaSettings(options: AgentToolExecutionOptions): SchemaValidationSettings {
    return {
      validator: options.schemaValidator ?? this.schemaValidator,
      allowUnvalidatedSchemas: options.allowUnvalidatedSchemas ?? this.allowUnvalidatedSchemas,
    };
  }

  private auditSettings(options: AgentToolExecutionOptions): AuditSettings {
    return {
      sink: options.auditSink ?? this.auditSink,
      failureMode: auditFailureModeOf(options.auditFailureMode, "toolExecution.auditFailureMode") ?? this.auditFailureMode,
    };
  }

  private retrySettings(options: AgentToolExecutionOptions): RetrySettings {
    if (options.retryPolicy === undefined) {
      return this.retryPolicy;
    }
    return this.normalizeRetryPolicy(options.retryPolicy, "toolExecution.retryPolicy");
  }

  private normalizeRetryPolicy(policy: AgentToolRetryPolicy | undefined, field: string): RetrySettings {
    if (policy === undefined) {
      return DEFAULT_RETRY_SETTINGS;
    }
    if (!isObjectRecord(policy)) {
      throw new AgentToolExecutionError(`${field} must be an object.`);
    }
    const typedPolicy = policy as AgentToolRetryPolicy;

    assertPositiveInteger(typedPolicy.maxAttempts, `${field}.maxAttempts`);
    assertNonNegativeInteger(typedPolicy.delayMs, `${field}.delayMs`);
    assertNonNegativeInteger(typedPolicy.maxDelayMs, `${field}.maxDelayMs`);

    const retryOnErrorCodes = this.retryOnErrorCodes(typedPolicy.retryOnErrorCodes, `${field}.retryOnErrorCodes`);
    const delayMs = typedPolicy.delayMs ?? 0;
    return Object.freeze({
      maxAttempts: typedPolicy.maxAttempts ?? DEFAULT_RETRY_SETTINGS.maxAttempts,
      delayMs,
      ...(typedPolicy.maxDelayMs !== undefined ? { maxDelayMs: typedPolicy.maxDelayMs } : {}),
      backoff: retryBackoffOf(typedPolicy.backoff, `${field}.backoff`) ?? (delayMs > 0 ? "fixed" : "none"),
      ...(retryOnErrorCodes !== undefined ? { retryOnErrorCodes } : {}),
    });
  }

  private retryOnErrorCodes(values: readonly string[] | undefined, field: string): ReadonlySet<string> | undefined {
    if (values === undefined) {
      return undefined;
    }
    if (!Array.isArray(values)) {
      throw new AgentToolExecutionError(`${field} must be an array of strings.`);
    }
    const normalized = new Set<string>();
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index] as unknown;
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new AgentToolExecutionError(`${field}[${index}] must be a non-empty string.`);
      }
      normalized.add(value.trim());
    }
    return normalized;
  }

  private ensureRetryPolicy(
    call: AgentToolCall,
    tool: ToolDefinition,
    retry: RetrySettings,
    idempotencyKey: string | undefined,
    metadata: JsonObject,
    startedAt: number,
  ): AgentToolResult | undefined {
    if (retry.maxAttempts <= 1) {
      return undefined;
    }
    if (tool.metadata.sideEffect !== "write" && tool.metadata.sideEffect !== "external") {
      return undefined;
    }
    if (idempotencyKey !== undefined) {
      return undefined;
    }
    // A policy that selects only terminal non-retryable codes cannot ever
    // schedule a second write/external attempt, so it does not create the
    // idempotency hazard this gate protects against.
    const retryableCodes = retry.retryOnErrorCodes ?? DEFAULT_RETRYABLE_ERROR_CODES;
    if ([...retryableCodes].every((code) => NEVER_RETRY_ERROR_CODES.has(code))) {
      return undefined;
    }
    return this.errorResult(
      call,
      "TOOL_RETRY_IDEMPOTENCY_REQUIRED",
      `Tool "${tool.metadata.name}" has "${tool.metadata.sideEffect}" side effects and requires idempotencyKey when retryPolicy.maxAttempts is greater than 1.`,
      metadata,
      startedAt,
      {
        toolName: tool.metadata.name,
        sideEffect: tool.metadata.sideEffect,
        maxAttempts: retry.maxAttempts,
      },
    );
  }

  private ensureSchemaValidator(
    call: AgentToolCall,
    tool: ToolDefinition,
    schema: SchemaValidationSettings,
    metadata: JsonObject,
    startedAt: number,
  ): AgentToolResult | undefined {
    if (schema.validator || schema.allowUnvalidatedSchemas) {
      return undefined;
    }
    if (!tool.metadata.input && !tool.metadata.output) {
      return undefined;
    }

    return this.errorResult(
      call,
      "TOOL_SCHEMA_VALIDATOR_MISSING",
      `Tool "${tool.metadata.name}" declares schema classes but no schema validator is configured.`,
      metadata,
      startedAt,
      {
        input: tool.metadata.input ? toolContractName(tool.metadata.input) : null,
        output: tool.metadata.output ? toolContractName(tool.metadata.output) : null,
      },
    );
  }

  private async prepareInput(
    call: AgentToolCall,
    tool: ToolDefinition,
    schema: SchemaValidationSettings,
    metadata: JsonObject,
    startedAt: number,
  ): Promise<PreparedToolValue> {
    if (!tool.metadata.input) {
      return { ok: true, value: call.input };
    }
    return this.bindAndValidateClassContract(
      call,
      tool,
      tool.metadata.input,
      call.input,
      "input",
      schema,
      metadata,
      startedAt,
    );
  }

  private async executeAttempt(
    call: AgentToolCall,
    tool: ToolDefinition,
    input: unknown,
    approval: AgentToolExecutionApproval,
    agentName: string | undefined,
    metadata: JsonObject,
    schema: SchemaValidationSettings,
    options: AgentToolExecutionOptions,
    audit: AuditSettings,
    startedAt: number,
    attempt: AttemptContext,
    executionState: ToolExecutionState,
  ): Promise<AgentToolResult> {
    const scope = this.services.createScope();
    const abortController = new AbortController();
    const detach = attachAbortForwarding(options.signal, abortController);
    const scopeDisposeTimeoutMs = options.scopeDisposeTimeoutMs ?? this.scopeDisposeTimeoutMs;
    if (abortController.signal.aborted) {
      detach?.();
      await this.disposeScope(scope, scopeDisposeTimeoutMs);
      return this.errorResult(
        call,
        "TOOL_ABORTED",
        "Tool execution was aborted before it started.",
        this.attemptMetadata(metadata, attempt),
        startedAt,
        { phase: "pre-execute" },
      );
    }

    const operation = this.executeInScope(
      call,
      tool,
      input,
      approval,
      agentName,
      scope,
      metadata,
      schema,
      options,
      startedAt,
      attempt,
      abortController.signal,
      executionState,
    );
    let result: AgentToolResult;
    try {
      result = await timed(
        operation,
        undefined,
        () => abortController.abort(),
        abortController.signal,
      );
    } catch (error) {
      if (error instanceof AgentToolTimeoutError || error instanceof AgentToolAbortError) {
        this.deferScopeDisposal(scope, operation, call, scopeDisposeTimeoutMs, async (settledResult) => {
          await this.recordDeferredSettlement(
            this.auditProjector.create(
              "settlement",
              call,
              startedAt,
              metadata,
              options,
              tool,
              agentName,
              settledResult,
              attempt,
            ),
            audit,
          );
        });
        const code = this.interruptionCode(error, tool, executionState);
        return this.errorResult(call, code, executionState.timedOut ? "Tool execution timed out." : errorMessageOf(error), this.attemptMetadata(metadata, attempt), startedAt, { phase: executionState.phase });
      }
      result = this.errorResult(
        call,
        "TOOL_EXECUTION_FAILED",
        errorMessageOf(error),
        this.attemptMetadata(metadata, attempt),
        startedAt,
      );
    } finally {
      detach?.();
    }

    const disposeError = await this.disposeScope(scope, scopeDisposeTimeoutMs);
    if (disposeError && result.status === "success") {
      const outcomeUnknown = tool.metadata.sideEffect === "write" || tool.metadata.sideEffect === "external";
      return this.errorResult(
        call,
        outcomeUnknown ? "TOOL_SCOPE_DISPOSE_FAILED_OUTCOME_UNKNOWN" : "TOOL_SCOPE_DISPOSE_FAILED",
        outcomeUnknown
          ? `Tool "${tool.metadata.name}" completed its side effect but scope disposal failed; retry safety is unknown: ${disposeError}`
          : `Tool scope disposal failed: ${disposeError}`,
        this.attemptMetadata(metadata, attempt),
        startedAt,
        outcomeUnknown ? { sideEffect: tool.metadata.sideEffect } : undefined,
      );
    }
    return result;
  }

  private async executeInScope(
    call: AgentToolCall,
    tool: ToolDefinition,
    input: unknown,
    approval: AgentToolExecutionApproval,
    agentName: string | undefined,
    scope: ServiceScope,
    metadata: JsonObject,
    schema: SchemaValidationSettings,
    options: AgentToolExecutionOptions,
    startedAt: number,
    attempt: AttemptContext,
    signal: AbortSignal,
    executionState: ToolExecutionState,
  ): Promise<AgentToolResult> {
    let instance: unknown;
    try {
      const contributed = this.hookSnapshot?.tools.filter((entry) => entry.payload.target === tool.target) ?? [];
      instance = contributed.length === 1
        ? await contributed[0]!.activation.activateAsync(scope)
        : await scope.resolveAsync(tool.target);
    } catch (error) {
      return this.errorResult(
        call,
        "TOOL_RESOLVE_FAILED",
        `Tool resolve failed: ${errorMessageOf(error)}`,
        this.attemptMetadata(metadata, attempt),
        startedAt,
      );
    }

    if (signal.aborted) {
      return this.errorResult(
        call,
        "TOOL_ABORTED",
        "Tool execution was aborted during dependency resolution.",
        this.attemptMetadata(metadata, attempt),
        startedAt,
        { phase: "pre-execute" },
      );
    }

    if (!hasExecute(instance)) {
      return this.errorResult(
        call,
        "TOOL_METHOD_MISSING",
        `Tool "${tool.metadata.name}" must expose execute(input, context).`,
        this.attemptMetadata(metadata, attempt),
        startedAt,
      );
    }

    const context: AgentToolExecutionContext = Object.freeze({
      call,
      tool,
      agentName,
      invocationId: options.invocationId,
      attempt: attempt.attempt,
      maxAttempts: attempt.maxAttempts,
      ...(attempt.idempotencyKey !== undefined ? { idempotencyKey: attempt.idempotencyKey } : {}),
      approval,
      metadata,
      signal,
    });

    let output: unknown;
    try {
      executionState.executeCompleted = false;
      executionState.executeStarted = true;
      executionState.phase = "execute";
      output = await instance.execute(input, context);
      executionState.executeCompleted = true;
      executionState.phase = "post-execute";
    } catch (error) {
      executionState.executeCompleted = true;
      const explicitlyPreCommit = error instanceof AgentToolPreCommitError;
      const outcomeUnknown = !explicitlyPreCommit
        && (tool.metadata.sideEffect === "write" || tool.metadata.sideEffect === "external");
      return this.errorResult(
        call,
        outcomeUnknown ? "TOOL_EXECUTION_FAILED_OUTCOME_UNKNOWN" : "TOOL_EXECUTION_FAILED",
        outcomeUnknown
          ? `Tool "${tool.metadata.name}" threw after side-effect execution started; retry safety is unknown: ${errorMessageOf(error)}`
          : errorMessageOf(error),
        this.attemptMetadata(metadata, attempt),
        startedAt,
        outcomeUnknown ? { sideEffect: tool.metadata.sideEffect, phase: "execute" } : undefined,
      );
    }

    let preparedOutput: PreparedToolValue;
    try {
      preparedOutput = await this.prepareOutput(
        call,
        tool,
        output,
        schema,
        this.attemptMetadata(metadata, attempt),
        startedAt,
      );
    } catch (error) {
      return this.postExecutionOutcome(
        call,
        tool,
        this.errorResult(
          call,
          "TOOL_OUTPUT_INVALID",
          `Tool output processing failed: ${errorMessageOf(error)}`,
          this.attemptMetadata(metadata, attempt),
          startedAt,
        ),
        metadata,
        startedAt,
        attempt,
      );
    }
    if (!preparedOutput.ok) {
      return this.postExecutionOutcome(call, tool, preparedOutput.result, metadata, startedAt, attempt);
    }

    try {
      return agentToolResult({
        callId: call.id,
        name: call.name,
        output: preparedOutput.value,
        durationMs: this.durationMs(startedAt),
        metadata: this.resultMetadata(tool, metadata, approval, agentName, attempt),
      });
    } catch (error) {
      return this.postExecutionOutcome(
        call,
        tool,
        this.errorResult(
          call,
          "TOOL_RESULT_INVALID",
          errorMessageOf(error),
          this.attemptMetadata(metadata, attempt),
          startedAt,
        ),
        metadata,
        startedAt,
        attempt,
      );
    }
  }

  private postExecutionOutcome(
    call: AgentToolCall,
    tool: ToolDefinition,
    result: AgentToolResult,
    metadata: JsonObject,
    startedAt: number,
    attempt: AttemptContext,
  ): AgentToolResult {
    if (tool.metadata.sideEffect !== "write" && tool.metadata.sideEffect !== "external") return result;
    return this.errorResult(
      call,
      "TOOL_POST_EXECUTION_FAILED_OUTCOME_UNKNOWN",
      `Tool "${tool.metadata.name}" completed its side effect but post-execution processing failed; retry safety is unknown.`,
      this.attemptMetadata(metadata, attempt),
      startedAt,
      {
        originalCode: result.error?.code ?? null,
        originalStatus: result.status,
        sideEffect: tool.metadata.sideEffect,
      },
    );
  }

  private async prepareOutput(
    call: AgentToolCall,
    tool: ToolDefinition,
    output: unknown,
    schema: SchemaValidationSettings,
    metadata: JsonObject,
    startedAt: number,
  ): Promise<PreparedToolValue> {
    if (!tool.metadata.output) {
      return { ok: true, value: output };
    }

    const prepared = await this.bindAndValidateClassContract(
      call,
      tool,
      tool.metadata.output,
      output,
      "output",
      schema,
      metadata,
      startedAt,
    );
    if (!prepared.ok) {
      return prepared;
    }
    return { ok: true, value: this.plainObjectFromModel(prepared.value as object) };
  }

  private async bindAndValidateClassContract(
    call: AgentToolCall,
    tool: ToolDefinition,
    contract: Class<object>,
    value: unknown,
    direction: "input" | "output",
    schema: SchemaValidationSettings,
    metadata: JsonObject,
    startedAt: number,
  ): Promise<PreparedToolValue> {
    const prepared = await this.contractValidator.validate(contract, value, direction, tool.metadata.name, schema.validator);
    return prepared.ok ? prepared : {
      ok: false,
      result: this.errorResult(call, prepared.error.code, prepared.error.message, metadata, startedAt, prepared.error.details),
    };
  }

  private plainObjectFromModel(instance: object): JsonObject {
    return agentModelJson(instance, "toolResult.output");
  }

  private effectiveCall(call: AgentToolCall, tool: ToolDefinition, input: unknown): AgentToolCall {
    if (tool.metadata.input === undefined) return call;
    return agentToolCall({
      id: call.id,
      name: call.name,
      input: this.plainObjectFromModel(input as object),
      metadata: call.metadata,
    });
  }

  private freezeToolInput<T>(value: T): T {
    const visit = (item: unknown, seen: WeakSet<object>): void => {
      if (item === null || typeof item !== "object" || seen.has(item)) return;
      seen.add(item);
      for (const child of Object.values(item as Record<string, unknown>)) visit(child, seen);
      Object.freeze(item);
    };
    visit(value, new WeakSet<object>());
    return value;
  }

  private shouldRetry(result: AgentToolResult, retry: RetrySettings, attempt: number): boolean {
    if (attempt >= retry.maxAttempts) {
      return false;
    }
    if (result.status !== "error" || !result.error) {
      return false;
    }
    const code = result.error.code;
    if (!code || NEVER_RETRY_ERROR_CODES.has(code)) {
      return false;
    }
    const retryableCodes = retry.retryOnErrorCodes ?? DEFAULT_RETRYABLE_ERROR_CODES;
    return retryableCodes.has(code);
  }

  private async delayBeforeRetry(
    retry: RetrySettings,
    completedAttempt: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const delayMs = this.retryDelayMs(retry, completedAttempt);
    if (delayMs <= 0) {
      return signal?.aborted === true;
    }
    if (signal?.aborted) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (aborted: boolean): void => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        signal?.removeEventListener("abort", onAbort);
        resolve(aborted);
      };
      const onAbort = () => finish(true);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(false), delayMs);
    });
  }

  private retryDelayMs(retry: RetrySettings, completedAttempt: number): number {
    if (retry.delayMs <= 0 || retry.backoff === "none") {
      return 0;
    }
    const rawDelay =
      retry.backoff === "exponential"
        ? retry.delayMs * 2 ** Math.max(0, completedAttempt - 1)
        : retry.delayMs;
    return retry.maxDelayMs === undefined ? rawDelay : Math.min(rawDelay, retry.maxDelayMs);
  }

  private async finish(
    call: AgentToolCall,
    result: AgentToolResult,
    startedAt: number,
    metadata: JsonObject,
    options: AgentToolExecutionOptions,
    audit: AuditSettings,
    tool?: ToolDefinition,
    agentName?: string,
    attempt?: AttemptContext,
    executionState?: ToolExecutionState,
    alreadySettled = false,
  ): Promise<AgentToolResult> {
    let terminal = result;
    const state = executionState ?? { executeStarted: false, executeCompleted: false, phase: "pre-execute" as const };
    const settlement = tool === undefined
      ? undefined
      : this.settlementEvent(call, tool, terminal, options, agentName, state, attempt);
    if (!alreadySettled && tool !== undefined) {
      const settled = await this.settleHooks(call, terminal, metadata, options, startedAt, state, settlement!);
      terminal = result.error?.code === "TOOL_HOOK_AUDIT_FAILED" ? result : settled;
    }
    if (executionState !== undefined) executionState.phase = "result-audit";
    const auditRemainingMs = executionState?.deadlineUnixMs === undefined
      ? undefined : Math.max(0, executionState.deadlineUnixMs - Date.now());
    const auditOutcome = await this.audit(
      this.auditProjector.create("result", call, startedAt, metadata, options, tool, agentName, terminal, attempt),
      audit,
      call,
      metadata,
      startedAt,
      terminal,
      options.signal,
      auditRemainingMs,
    );
    const auditError = auditOutcome.kind === "value"
      ? auditOutcome.value
      : (() => {
          if (terminal.status !== "success") return terminal;
          const outcomeUnknown = (terminal.status === "success" && (tool?.metadata.sideEffect === "write" || tool?.metadata.sideEffect === "external"))
            || terminal.error?.code?.endsWith("_OUTCOME_UNKNOWN") === true;
          const cancelled = state.callerSignal?.aborted === true;
          return this.errorResult(call,
            cancelled ? (outcomeUnknown ? "TOOL_ABORTED_OUTCOME_UNKNOWN" : "TOOL_ABORTED") : (outcomeUnknown ? "TOOL_TIMEOUT_OUTCOME_UNKNOWN" : "TOOL_TIMEOUT"),
            "Tool result audit did not complete before the execution boundary.", metadata, startedAt,
            { phase: "result-audit", sideEffect: tool?.metadata.sideEffect ?? null });
        })();
    const deadlineExpired = state.deadlineUnixMs !== undefined
      && state.deadlineUnixMs <= Date.now()
      && state.callerSignal?.aborted !== true;
    const deadlineError = auditError === undefined && terminal.status === "success" && deadlineExpired
      ? this.errorResult(call,
        tool?.metadata.sideEffect === "write" || tool?.metadata.sideEffect === "external"
          ? "TOOL_TIMEOUT_OUTCOME_UNKNOWN" : "TOOL_TIMEOUT",
        "Tool execution timed out before result audit completed.", metadata, startedAt,
        { phase: "result-audit", sideEffect: tool?.metadata.sideEffect ?? null })
      : undefined;
    if (settlement !== undefined) {
      // Observers receive the exact immutable redacted object that required
      // settlement received, never a separately reconstructed raw result.
      await this.observeHooks(settlement, options);
    }
    return auditError ?? deadlineError ?? terminal;
  }

  private async audit(
    entry: AgentToolAuditEntry,
    audit: AuditSettings,
    call: AgentToolCall,
    metadata: JsonObject,
    startedAt: number,
    originalResult?: AgentToolResult,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<HookOutcome<AgentToolResult | undefined>> {
    if (!audit.sink) {
      return { kind: "value", value: undefined };
    }

    let recorded: void | Promise<void>;
    try {
      // Invoke the sink synchronously. A void return means the audit is
      // already recorded, including when the caller has just aborted.
      recorded = auditSinkFunction(audit.sink)(entry);
    } catch (error) {
      return { kind: "value", value: this.auditFailure(entry, audit, call, metadata, startedAt, originalResult, error) };
    }
    let then: unknown;
    try {
      then = recorded && (recorded as unknown as { then?: unknown }).then;
    } catch (error) {
      return { kind: "value", value: this.auditFailure(entry, audit, call, metadata, startedAt, originalResult, error) };
    }
    if (typeof then !== "function") {
      return { kind: "value", value: undefined };
    }
    const pending = new Promise<void>((resolve, reject) => {
      try {
        (then as (this: unknown, resolve: () => void, reject: (error: unknown) => void) => unknown).call(recorded, resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
    const settled = pending.then(
      () => ({ ok: true } as const),
      (error: unknown) => ({ ok: false, error } as const),
    );
    const outcome = await awaitHook(settled, signal, timeoutMs);
    if (outcome.kind !== "value") return outcome;
    return outcome.value.ok
      ? { kind: "value", value: undefined }
      : { kind: "value", value: this.auditFailure(entry, audit, call, metadata, startedAt, originalResult, outcome.value.error) };
  }

  private auditFailure(
    entry: AgentToolAuditEntry,
    audit: AuditSettings,
    call: AgentToolCall,
    metadata: JsonObject,
    startedAt: number,
    originalResult: AgentToolResult | undefined,
    error: unknown,
  ): AgentToolResult | undefined {
    if (audit.failureMode === "best-effort") return undefined;
    const sideEffectingSuccess = entry.phase === "result"
      && originalResult?.status === "success"
      && (entry.tool?.sideEffect === "write" || entry.tool?.sideEffect === "external");
    const originalOutcomeUnknown = entry.phase === "result"
      && originalResult?.error?.code?.endsWith("_OUTCOME_UNKNOWN") === true;
    const outcomeUnknown = sideEffectingSuccess || originalOutcomeUnknown;
    return this.errorResult(
        call,
        outcomeUnknown ? "TOOL_AUDIT_FAILED_OUTCOME_UNKNOWN" : "TOOL_AUDIT_FAILED",
        outcomeUnknown
          ? `Tool result audit failed after an outcome-unknown side-effecting operation; retry safety is unknown: ${errorMessageOf(error)}`
          : `Tool audit failed: ${errorMessageOf(error)}`,
        metadata,
        startedAt,
        {
          phase: entry.phase,
          originalStatus: originalResult?.status ?? null,
          originalCode: originalResult?.error?.code ?? null,
          sideEffect: entry.tool?.sideEffect ?? null,
        },
    );
  }

  private async disposeScope(scope: ServiceScope, timeoutMs: number): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disposal = Promise.resolve()
      .then(() => scope.dispose())
      .then(
        () => undefined,
        (error: unknown) => errorMessageOf(error),
      );
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`Tool scope disposal timed out after ${timeoutMs} ms.`), timeoutMs);
    });
    try {
      return await Promise.race([disposal, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private deferScopeDisposal(
    scope: ServiceScope,
    operation: Promise<AgentToolResult>,
    call: AgentToolCall,
    scopeDisposeTimeoutMs: number,
    onSettled: (result: AgentToolResult) => void | Promise<void>,
  ): void {
    void operation
      .then(
        (result) => result,
        (error: unknown) => agentToolResult({
          callId: call.id,
          name: call.name,
          status: "error",
          error: { code: "TOOL_SETTLEMENT_FAILED", message: redactSensitive(errorMessageOf(error)) as string },
        }),
      )
      .then(async (result) => {
        const error = await this.disposeScope(scope, scopeDisposeTimeoutMs);
        if (error !== undefined) {
          console.error("[agent-tool] deferred scope disposal failed:", redactSensitive(error));
        }
        await onSettled(result);
      })
      .catch((error: unknown) => {
        console.error("[agent-tool] deferred settlement handling failed:", redactSensitive(errorMessageOf(error)));
      });
  }

  private async recordDeferredSettlement(entry: AgentToolAuditEntry, audit: AuditSettings): Promise<void> {
    if (audit.sink === undefined) return;
    try {
      await auditSinkFunction(audit.sink)(entry);
    } catch (error) {
      console.error("[agent-tool] deferred settlement audit failed:", redactSensitive(errorMessageOf(error)));
    }
  }


  private errorResult(
    call: AgentToolCall,
    code: string,
    message: string,
    metadata: JsonObject,
    startedAt: number,
    details?: JsonObject,
  ): AgentToolResult {
    const safeMessage = redactSensitive(message) as string;
    const safeDetails = details === undefined ? undefined : redactSensitive(details) as JsonObject;
    return agentToolResult({
      callId: call.id,
      name: call.name,
      status: "error",
      error: safeDetails ? { code, message: safeMessage, details: safeDetails } : { code, message: safeMessage },
      durationMs: this.durationMs(startedAt),
      metadata,
    });
  }

  private deniedResult(
    call: AgentToolCall,
    code: string,
    message: string,
    details: JsonObject,
    metadata: JsonObject,
    startedAt: number,
  ): AgentToolResult {
    const safeMessage = redactSensitive(message) as string;
    const safeDetails = redactSensitive(details) as JsonObject;
    return agentToolResult({
      callId: call.id,
      name: call.name,
      status: "denied",
      error: { code, message: safeMessage, details: safeDetails },
      durationMs: this.durationMs(startedAt),
      metadata,
    });
  }

  private resultMetadata(
    tool: ToolDefinition,
    metadata: JsonObject,
    approval: AgentToolExecutionApproval,
    agentName: string | undefined,
    attempt: AttemptContext,
  ): JsonObject {
    return Object.freeze({
      ...metadata,
      agentName: agentName ?? null,
      toolSideEffect: tool.metadata.sideEffect,
      toolApproval: tool.metadata.approval,
      executionApproval: approval,
      toolAttempt: attempt.attempt,
      toolMaxAttempts: attempt.maxAttempts,
      toolRetried: attempt.attempt > 1,
    });
  }

  private attemptMetadata(metadata: JsonObject, attempt: AttemptContext): JsonObject {
    return Object.freeze({
      ...metadata,
      toolAttempt: attempt.attempt,
      toolMaxAttempts: attempt.maxAttempts,
      toolRetried: attempt.attempt > 1,
    });
  }

  private durationMs(startedAt: number): number {
    return Math.max(0, Date.now() - startedAt);
  }
}
