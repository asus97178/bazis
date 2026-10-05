import type { Secret } from "../../kernel";
import type { OsnvModuleRef } from "../../di";
import type { AgentToolExecutorOptions, AgentToolSchemaValidator } from "../AgentToolExecutor";
import { normalizeJsonValue, type JsonObject, type JsonValue } from "../semantic";
import { Validator } from "../../../library/validation";

const UUID_V1_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgentSessionPrincipalV1 { readonly subject: string; readonly tenant?: string; }
export interface AgentSessionCallContextV1 { readonly principal: AgentSessionPrincipalV1; readonly signal?: AbortSignal; }

export class CreateAgentSessionRequestV1 {
  @Validator({ required: true, pattern: UUID_V1_PATTERN })
  sessionId!: string;
  @Validator({ required: true, pattern: UUID_V1_PATTERN })
  requestId!: string;
  @Validator({ required: true, minLength: 1, maxLength: 128 })
  agentName!: string;
  @Validator({ minLength: 1, maxLength: 128 })
  taskName?: string;
  @Validator({
    required: true,
    // JsonValue deliberately includes null. Keep absence invalid while
    // allowing that exact JSON literal through the existing Validator flow.
    validateIf: (instance) => (instance as CreateAgentSessionRequestV1).input !== null,
    custom: (value) => {
      try {
        normalizeJsonValue(value, "agentSession.input");
        return true;
      } catch {
        return false;
      }
    },
  })
  input!: JsonValue;
  @Validator({ minLength: 1, maxLength: 128 })
  modelProfile?: string;
  @Validator({ min: 1, max: 64, integer: true })
  maxSteps?: number;
  @Validator({ min: 1, max: 64, integer: true })
  maxToolCallsPerStep?: number;
  @Validator({ min: 1, max: 900000, integer: true })
  runTimeoutMs?: number;
}
export class RunAgentSessionRequestV1 {
  @Validator({ required: true, pattern: UUID_V1_PATTERN }) sessionId!: string;
  @Validator({ required: true, pattern: UUID_V1_PATTERN }) commandId!: string;
}
export class ReadAgentSessionRequestV1 { @Validator({ required: true, pattern: UUID_V1_PATTERN }) sessionId!: string; }
export class StopAgentSessionRequestV1 { @Validator({ required: true, pattern: UUID_V1_PATTERN }) sessionId!: string; @Validator({ required: true, pattern: UUID_V1_PATTERN }) commandId!: string; }
export class ResumeAgentSessionRequestV1 { @Validator({ required: true, pattern: UUID_V1_PATTERN }) sessionId!: string; @Validator({ required: true, pattern: UUID_V1_PATTERN }) commandId!: string; }
export class ReadAgentSessionEventsRequestV1 { @Validator({ required: true, pattern: UUID_V1_PATTERN }) sessionId!: string; after?: AgentSessionCursorV1; @Validator({ min: 1, max: 500, integer: true }) limit?: number; }

export type AgentSessionStateV1 = "created" | "running" | "stop-requested" | "stopped" | "completed" | "failed" | "outcome-unknown";
export type AgentSessionCursorV1 = string;
export interface AgentSessionOutcomeV1 { readonly status: "completed" | "failed" | "outcome-unknown"; readonly finalText?: string; readonly output?: JsonValue; readonly error?: { readonly code: string; readonly message: string }; }
export interface AgentSessionViewV1 {
  readonly version: 1; readonly sessionId: string; readonly invocationId: string; readonly agentName: string; readonly taskName?: string;
  readonly tenant?: string; readonly state: AgentSessionStateV1; readonly revision: number; readonly steps: number; readonly stopRequested: boolean;
  readonly resumeAllowed: boolean; readonly createdAt: string; readonly updatedAt: string; readonly outcome?: AgentSessionOutcomeV1;
}
export interface AgentSessionRunResultV1 { readonly session: AgentSessionViewV1; }
export interface AgentSessionStopResultV1 { readonly disposition: "requested" | "already-stopped" | "already-terminal"; readonly session: AgentSessionViewV1; }
export type AgentSessionEventKindV1 = "session-created" | "run-started" | "owner-reclaimed" | "model-dispatch-intent" | "model-result" | "tool-dispatch-intent" | "tool-result" | "stop-requested" | "stopped" | "completed" | "failed" | "outcome-unknown";
export interface AgentSessionEventV1 { readonly version: 1; readonly eventId: string; readonly sessionId: string; readonly sequence: number; readonly kind: AgentSessionEventKindV1; readonly occurredAt: string; readonly projection: JsonObject; }
export interface AgentSessionEventPageV1 { readonly items: readonly AgentSessionEventV1[]; readonly nextCursor: AgentSessionCursorV1; readonly hasMore: boolean; }

export abstract class AgentSessions {
  abstract create(request: CreateAgentSessionRequestV1, context: AgentSessionCallContextV1): Promise<AgentSessionViewV1>;
  abstract run(request: RunAgentSessionRequestV1, context: AgentSessionCallContextV1): Promise<AgentSessionRunResultV1>;
  abstract read(request: ReadAgentSessionRequestV1, context: AgentSessionCallContextV1): Promise<AgentSessionViewV1>;
  abstract stop(request: StopAgentSessionRequestV1, context: AgentSessionCallContextV1): Promise<AgentSessionStopResultV1>;
  abstract resume(request: ResumeAgentSessionRequestV1, context: AgentSessionCallContextV1): Promise<AgentSessionRunResultV1>;
  abstract readEvents(request: ReadAgentSessionEventsRequestV1, context: AgentSessionCallContextV1): Promise<AgentSessionEventPageV1>;
}

export interface AgentSessionAuthorizationTargetV1 { readonly sessionId: string; readonly ownerSubject: string; readonly tenant?: string; readonly agentName: string; readonly taskName?: string; }
export type AgentSessionAuthorizationRequestV1 =
  | { readonly action: "create"; readonly principal: AgentSessionPrincipalV1; readonly candidate: AgentSessionAuthorizationTargetV1 }
  | { readonly action: "run" | "read" | "read-events" | "stop" | "resume"; readonly principal: AgentSessionPrincipalV1; readonly session: AgentSessionAuthorizationTargetV1 & { readonly state: AgentSessionStateV1 } };
export abstract class AgentSessionAuthorizationPolicyV1 { abstract authorize(request: AgentSessionAuthorizationRequestV1): Promise<boolean>; }

export interface AgentSessionCheckpointProtectionConfigV1 { readonly activeKeyId: string; readonly readableKeyIds: readonly string[]; readonly keys: Readonly<Record<string, Secret>>; }
export interface AgentSessionSealRequestV1 { readonly sessionId: string; readonly checkpointRevision: number; readonly bindingHash: string; readonly canonicalCheckpointJson: string; }
export interface AgentSessionSealedCheckpointV1 { readonly envelopeVersion: "osnv.agent-session/sealed/v1"; readonly keyId: string; readonly ciphertext: string; }
export interface AgentSessionOpenRequestV1 { readonly expectedSessionId: string; readonly expectedCheckpointRevision: number; readonly expectedBindingHash: string; readonly sealed: AgentSessionSealedCheckpointV1; }
export abstract class AgentSessionCheckpointProtectorV1 { abstract seal(request: AgentSessionSealRequestV1): Promise<AgentSessionSealedCheckpointV1>; abstract open(request: AgentSessionOpenRequestV1): Promise<string>; }

export interface AgentSessionModuleOptionsV1 {
  readonly imports?: readonly OsnvModuleRef[]; readonly agentModules: readonly OsnvModuleRef[]; readonly implementationVersion: string;
  readonly admission: { readonly bucket: string; readonly maxActiveRuns?: number };
  readonly execution?: { readonly providerCallTimeoutMs?: number; readonly taskSchemaValidator?: AgentToolSchemaValidator; readonly toolExecutorOptions?: Pick<AgentToolExecutorOptions, "approvalPolicy" | "schemaValidator" | "auditSink" | "defaultTimeoutMs" | "scopeDisposeTimeoutMs" | "requiredPlatformHooks" | "hookRedaction">; };
  readonly limits?: { readonly runTimeoutMs?: number; readonly maxSessionSteps?: number; readonly maxToolCallsPerStep?: number; readonly ownerLeaseMs?: number; readonly ownerHeartbeatMs?: number; readonly ownerStopGraceMs?: number; readonly authorizationTimeoutMs?: number; readonly checkpointProtectionTimeoutMs?: number; readonly databaseLockTimeoutMs?: number; readonly databaseStatementTimeoutMs?: number; readonly databaseWaitTimeoutMs?: number; readonly stopCheckIntervalMs?: number; readonly maxInputBytes?: number; readonly maxCheckpointBytes?: number; readonly maxJournalPayloadBytes?: number; readonly maxJournalEntries?: number; readonly reservedControlJournalEntries?: number; readonly defaultJournalPageSize?: number; readonly maxJournalPageSize?: number; };
}
export type AgentSessionErrorCodeV1 = `AGENT_SESSION_${"INVALID_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "OWNER_ACTIVE" | "ADMISSION_UNAVAILABLE" | "NOT_RESUMABLE" | "DEADLINE_EXCEEDED" | "LIMIT_EXCEEDED" | "AMBIENT_TRANSACTION_FORBIDDEN" | "BINDING_MISMATCH" | "CHECKPOINT_UNAVAILABLE" | "CHECKPOINT_CORRUPT" | "OUTCOME_UNKNOWN" | "STORE_CORRUPT" | "STORE_UNAVAILABLE" | "AUTHORIZATION_UNAVAILABLE" | "HOST_STOPPING" | "UNSUPPORTED_VERSION" | "IDEMPOTENCY_CONFLICT" | "COMMIT_OUTCOME_UNKNOWN" | "CONFIG_MISMATCH"}`;
export class AgentSessionError extends Error { constructor(readonly code: AgentSessionErrorCodeV1, readonly retryable = false) { super(code); this.name = "AgentSessionError"; } }
