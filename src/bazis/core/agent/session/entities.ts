import { Column, DbContext, Entity, Index, Key } from "../../../library/orm";

/** Immutable v1 schema. These tables are owned exclusively by AgentSessionDbContext. */
@Entity({ table: "bazis_agent_sessions_v1" })
@Index(["createKey"], { unique: true })
@Index(["sessionId"], { unique: true })
export class AgentSessionRowV1 {
  @Key({ generated: false }) @Column({ type: "uuid" }) id = "";
  @Column({ type: "uuid" }) sessionId = "";
  @Column({ type: "uuid" }) invocationId = "";
  @Column({ type: "text" }) createKey = "";
  @Column({ type: "text" }) requestBinding = "";
  @Column({ type: "text" }) ownerSubject = "";
  @Column({ type: "text", nullable: true }) tenant?: string;
  @Column({ type: "text" }) agentName = "";
  @Column({ type: "text", nullable: true }) taskName?: string;
  @Column({ type: "text" }) implementationVersion = "";
  @Column({ type: "text" }) bindingHash = "";
  @Column({ type: "text" }) state = "created";
  @Column({ type: "integer" }) revision = 0;
  @Column({ type: "integer" }) steps = 0;
  @Column({ type: "boolean" }) stopRequested = false;
  @Column({ type: "integer" }) checkpointRevision = 0;
  @Column({ type: "text", nullable: true }) ownerId?: string;
  @Column({ type: "integer" }) ownerEpoch = 0;
  @Column({ type: "datetime", nullable: true }) ownerLeaseUntil?: Date;
  @Column({ type: "text", nullable: true }) runCommandId?: string;
  @Column({ type: "datetime", nullable: true }) runDeadline?: Date;
  @Column({ type: "integer" }) nextSequence = 1;
  @Column({ type: "integer", nullable: true }) pendingIntentSequence?: number;
  @Column({ type: "boolean" }) admissionReserved = false;
  @Column({ type: "datetime" }) createdAt = new Date();
  @Column({ type: "datetime" }) updatedAt = new Date();
}

@Entity({ table: "bazis_agent_session_checkpoints_v1" })
@Index(["sessionId", "checkpointRevision"], { unique: true })
export class AgentSessionCheckpointRowV1 {
  @Key({ generated: false }) @Column({ type: "uuid" }) id = "";
  @Column({ type: "uuid" }) sessionId = "";
  @Column({ type: "integer" }) checkpointRevision = 0;
  @Column({ type: "text" }) bindingHash = "";
  @Column({ type: "text" }) keyId = "";
  @Column({ type: "text" }) ciphertext = "";
  @Column({ type: "datetime" }) createdAt = new Date();
}

@Entity({ table: "bazis_agent_session_journal_v1" })
@Index(["sessionId", "sequence"], { unique: true })
@Index(["sessionId", "commandId"], { unique: false })
export class AgentSessionJournalRowV1 {
  @Key({ generated: false }) @Column({ type: "uuid" }) id = "";
  @Column({ type: "uuid" }) eventId = "";
  @Column({ type: "uuid" }) sessionId = "";
  @Column({ type: "integer" }) sequence = 0;
  @Column({ type: "integer" }) aggregateRevision = 0;
  @Column({ type: "text" }) kind = "";
  @Column({ type: "text", nullable: true }) commandId?: string;
  @Column({ type: "text" }) projectionJson = "{}";
  @Column({ type: "text", nullable: true }) binding?: string;
  @Column({ type: "datetime" }) occurredAt = new Date();
}

@Entity({ table: "bazis_agent_session_admission_v1" })
@Index(["bucket"], { unique: true })
export class AgentSessionAdmissionRowV1 {
  @Key({ generated: false }) @Column({ type: "uuid" }) id = "";
  @Column({ type: "text" }) bucket = "";
  @Column({ type: "text" }) configHash = "";
  @Column({ type: "integer" }) maxActiveRuns = 8;
  @Column({ type: "integer" }) activeReservations = 0;
  @Column({ type: "datetime" }) updatedAt = new Date();
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
