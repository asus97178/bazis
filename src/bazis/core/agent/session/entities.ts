import { Column, DbContext, Entity, Index, Key, Nullable } from "../../../library/orm";

/** Immutable v1 schema. These tables are owned exclusively by AgentSessionDbContext. */
@Entity({ table: "bazis_agent_sessions_v1" })
@Index(["createKey"], { unique: true })
@Index(["sessionId"], { unique: true })
export class AgentSessionRowV1 {
  @Key({ generated: false }) @Column({ type: "uuid" }) id = "";
  @Nullable() @Column({ type: "uuid" }) sessionId = "";
  @Nullable() @Column({ type: "uuid" }) invocationId = "";
  @Nullable() @Column({ type: "text" }) createKey = "";
  @Nullable() @Column({ type: "text" }) requestBinding = "";
  @Nullable() @Column({ type: "text" }) ownerSubject = "";
  @Nullable() @Column({ type: "text" }) tenant?: string;
  @Nullable() @Column({ type: "text" }) agentName = "";
  @Nullable() @Column({ type: "text" }) implementationVersion = "";
  @Nullable() @Column({ type: "text" }) bindingHash = "";
  @Nullable() @Column({ type: "text" }) state = "created";
  @Nullable() @Column({ type: "integer" }) revision = 0;
  @Nullable() @Column({ type: "integer" }) steps = 0;
  @Nullable() @Column({ type: "boolean" }) stopRequested = false;
  @Nullable() @Column({ type: "integer" }) checkpointRevision = 0;
  @Nullable() @Column({ type: "text" }) ownerId?: string;
  @Nullable() @Column({ type: "integer" }) ownerEpoch = 0;
  @Nullable() @Column({ type: "datetime" }) ownerLeaseUntil?: Date;
  @Nullable() @Column({ type: "text" }) runCommandId?: string;
  @Nullable() @Column({ type: "datetime" }) runDeadline?: Date;
  @Nullable() @Column({ type: "integer" }) nextSequence = 1;
  @Nullable() @Column({ type: "integer" }) pendingIntentSequence?: number;
  @Nullable() @Column({ type: "boolean" }) admissionReserved = false;
  @Nullable() @Column({ type: "datetime" }) createdAt = new Date();
  @Nullable() @Column({ type: "datetime" }) updatedAt = new Date();
}

@Entity({ table: "bazis_agent_session_checkpoints_v1" })
@Index(["sessionId", "checkpointRevision"], { unique: true })
export class AgentSessionCheckpointRowV1 {
  @Key({ generated: false }) @Column({ type: "uuid" }) id = "";
  @Nullable() @Column({ type: "uuid" }) sessionId = "";
  @Nullable() @Column({ type: "integer" }) checkpointRevision = 0;
  @Nullable() @Column({ type: "text" }) bindingHash = "";
  @Nullable() @Column({ type: "text" }) keyId = "";
  @Nullable() @Column({ type: "text" }) ciphertext = "";
  @Nullable() @Column({ type: "datetime" }) createdAt = new Date();
}

@Entity({ table: "bazis_agent_session_journal_v1" })
@Index(["sessionId", "sequence"], { unique: true })
@Index(["sessionId", "commandId"], { unique: false })
export class AgentSessionJournalRowV1 {
  @Key({ generated: false }) @Column({ type: "uuid" }) id = "";
  @Nullable() @Column({ type: "uuid" }) eventId = "";
  @Nullable() @Column({ type: "uuid" }) sessionId = "";
  @Nullable() @Column({ type: "integer" }) sequence = 0;
  @Nullable() @Column({ type: "integer" }) aggregateRevision = 0;
  @Nullable() @Column({ type: "text" }) kind = "";
  @Nullable() @Column({ type: "text" }) commandId?: string;
  @Nullable() @Column({ type: "text" }) projectionJson = "{}";
  @Nullable() @Column({ type: "text" }) binding?: string;
  @Nullable() @Column({ type: "datetime" }) occurredAt = new Date();
}

@Entity({ table: "bazis_agent_session_admission_v1" })
@Index(["bucket"], { unique: true })
export class AgentSessionAdmissionRowV1 {
  @Key({ generated: false }) @Column({ type: "uuid" }) id = "";
  @Nullable() @Column({ type: "text" }) bucket = "";
  @Nullable() @Column({ type: "text" }) configHash = "";
  @Nullable() @Column({ type: "integer" }) maxActiveRuns = 8;
  @Nullable() @Column({ type: "integer" }) activeReservations = 0;
  @Nullable() @Column({ type: "datetime" }) updatedAt = new Date();
}

export class AgentSessionDbContext extends DbContext {
  readonly sessions = this.set(AgentSessionRowV1);
  readonly checkpoints = this.set(AgentSessionCheckpointRowV1);
  readonly journal = this.set(AgentSessionJournalRowV1);
  readonly admission = this.set(AgentSessionAdmissionRowV1);
}

export const AGENT_SESSION_ENTITIES_V1 = Object.freeze([
  AgentSessionRowV1, AgentSessionCheckpointRowV1, AgentSessionJournalRowV1, AgentSessionAdmissionRowV1,
] as const);
