import type { FormIssue, FormSpec } from "../../../../library/workflow";
import { isUuid, pagingOf, type WorkflowActor, type WorkflowPage } from "../../contracts/types";
import { WorkflowError } from "../../contracts/WorkflowError";
import type { WorkflowInputValidator } from "../../contracts/WorkflowInputValidator";
import type { IWorkflowDefinitions } from "../../definitions_module/services/IWorkflowDefinitions.service";
import type { WorkflowEngine } from "../internal/WorkflowEngine";
import type { RuntimeDbContext } from "../model/Runtime.dbContext";
import type { WfHistory } from "../model/WfHistory.model";
import type { WfInstance } from "../model/WfInstance.model";
import type { WfToken } from "../model/WfToken.model";
import {
  IWorkflowRuntime,
  type EmitOptions,
  type EmitResult,
  type HistoryEntry,
  type InstanceDetails,
  type InstanceListQuery,
  type InstanceSummary,
  type StartInstance,
} from "./IWorkflowRuntime.service";

const STATUSES = new Set(["running", "completed", "cancelled", "failed"]);
const EVENT_KEY = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

export class WorkflowRuntime extends IWorkflowRuntime {
  constructor(
    private readonly db: RuntimeDbContext,
    private readonly engine: WorkflowEngine,
    private readonly definitions: IWorkflowDefinitions,
    private readonly validator: WorkflowInputValidator,
  ) {
    super();
  }

  async start(processKey: string, options: StartInstance): Promise<InstanceDetails> {
    actorOf(options.actor);
    const partition = optionalText(options.partition, "partition");
    const businessKey = optionalText(options.businessKey, "businessKey");
    const version = await this.definitions.latest(processKey);
    const start = Object.entries(version.document.nodes).find(([, node]) => node.kind === "manualStart");
    if (!start) throw new WorkflowError("wrong_status", `Process ${processKey} has no manual start`);
    const { value, issues } = await this.validator.validate(version.document.input, options.input, { purpose: "input", processKey, partition });
    if (issues.length > 0) throw new WorkflowError("invalid_input", "The process input is invalid", issues);
    const id = await this.engine.begin(this.engine.cache(version), start[0], { input: value, partition, businessKey, startedVia: "manual", actor: options.actor });
    return await this.instance(id);
  }

  async cancel(instanceId: string, options: { readonly reason?: string | null; readonly actor: WorkflowActor }): Promise<InstanceDetails> {
    actorOf(options.actor);
    const reason = optionalText(options.reason, "reason", 1000);
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const done = await this.engine.inStep(instanceId, async (step) => {
      if (step.instance.status !== "running" && step.instance.status !== "failed") throw new WorkflowError("wrong_status", `Instance is ${step.instance.status}`);
      await this.engine.cancel(step, reason, options.actor);
      return true;
    });
    if (done === null) throw notFound(instanceId);
    return await this.instance(instanceId);
  }

  async retry(instanceId: string, options: { readonly actor: WorkflowActor }): Promise<InstanceDetails> {
    actorOf(options.actor);
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const done = await this.engine.inStep(instanceId, async (step) => {
      if (step.instance.status !== "failed") throw new WorkflowError("wrong_status", `Only a failed instance is retried; this one is ${step.instance.status}`);
      await this.engine.retry(step, options.actor);
      return true;
    });
    if (done === null) throw notFound(instanceId);
    return await this.instance(instanceId);
  }

  async completeToken(tokenId: string, output: unknown, actor: WorkflowActor): Promise<InstanceDetails> {
    actorOf(actor);
    if (!isUuid(tokenId)) throw new WorkflowError("not_found", `Token ${tokenId} does not exist`);
    const token = await this.db.tokens.asNoTracking().firstOrDefault((t) => t.id.eq(tokenId));
    if (!token) throw new WorkflowError("not_found", `Token ${tokenId} does not exist`);
    const done = await this.engine.inStep(token.instanceId, async (step) => {
      const node = step.graph.document.nodes[token.nodeId];
      const current = step.tokens.find((t) => t.id === tokenId);
      if (node?.kind !== "userTask" || !current || current.status !== "waiting" || step.instance.status !== "running") {
        throw new WorkflowError("wrong_status", "The token does not wait for a task");
      }
      const { value, issues } = await this.validator.validate(node.config?.form as FormSpec | undefined, output, { purpose: "task", processKey: step.instance.processKey, partition: step.instance.partition });
      if (issues.length > 0) throw new WorkflowError("invalid_input", "The task form is invalid", issues);
      await this.engine.complete(step, tokenId, value, actor);
      return true;
    });
    if (done === null) throw notFound(token.instanceId);
    return await this.instance(token.instanceId);
  }

  async emit(eventKey: string, payload: unknown = {}, options: EmitOptions = {}): Promise<EmitResult> {
    if (typeof eventKey !== "string" || !EVENT_KEY.test(eventKey)) throw new WorkflowError("invalid_input", "eventKey must look like payments.received");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new WorkflowError("invalid_input", "payload must be a JSON object");
    const data = payload as Record<string, unknown>;
    const correlation = optionalText(options.correlation, "correlation");
    const partition = optionalText(options.partition, "partition");
    const actor = options.actor ?? { kind: "system" as const, id: `event:${eventKey}` };
    actorOf(actor);

    let waits = this.db.subscriptions.asNoTracking().where((s) => s.eventKey.eq(eventKey));
    waits = correlation === null ? waits.where((s) => s.correlation.isNull()) : waits.where((s) => s.correlation.isNull().or(s.correlation.eq(correlation)));
    if (partition !== null) waits = waits.where((s) => s.partition.eq(partition));
    const continued = new Set<string>();
    for (const wait of await waits.orderBy((s) => s.id).toList()) {
      const moved = await this.engine.inStep(wait.instanceId, async (step) => {
        await this.db.subscriptions.asNoTracking().where((s) => s.id.eq(wait.id)).executeDelete();
        return await this.engine.eventReceived(step, wait.tokenId, eventKey, data);
      });
      if (moved === true) continued.add(wait.instanceId);
    }

    const started: string[] = [];
    const rejected: { processKey: string; issues: readonly FormIssue[] }[] = [];
    for (const version of await this.definitions.published()) {
      for (const [nodeId, node] of Object.entries(version.document.nodes)) {
        if (node.kind !== "eventStart" || node.config?.event !== eventKey) continue;
        // An event carries more than a process needs: fields the input does not declare are dropped, not refused.
        const { value, issues: all } = await this.validator.validate(version.document.input, data, { purpose: "input", processKey: version.key, partition });
        const issues = all.filter((issue) => issue.code !== "unknown");
        if (issues.length > 0) {
          rejected.push({ processKey: version.key, issues });
          continue;
        }
        started.push(await this.engine.begin(this.engine.cache(version), nodeId, { input: value, partition, businessKey: correlation, startedVia: "event", actor }));
      }
    }
    return { started, continued: [...continued], rejected };
  }

  async instances(query: InstanceListQuery = {}): Promise<WorkflowPage<InstanceSummary>> {
    const { limit, offset } = pagingOf(query);
    if (query.status !== undefined && !STATUSES.has(query.status)) throw new WorkflowError("invalid_input", "status must be running, completed, cancelled or failed");
    let source = this.db.instances.asNoTracking();
    if (query.partition !== undefined) source = source.where((i) => i.partition.eq(query.partition!));
    if (query.status !== undefined) source = source.where((i) => i.status.eq(query.status!));
    if (query.processKey !== undefined) source = source.where((i) => i.processKey.eq(query.processKey!));
    if (query.businessKey !== undefined) source = source.where((i) => i.businessKey.eq(query.businessKey!));
    if (query.startedById !== undefined) source = source.where((i) => i.startedById.eq(query.startedById!));
    const total = await source.count();
    const rows = await source.orderByDescending((i) => i.id).skip(offset).take(limit).toList();
    return { items: rows.map(summaryOf), total };
  }

  async instance(instanceId: string): Promise<InstanceDetails> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const row = await this.db.instances.asNoTracking().firstOrDefault((i) => i.id.eq(instanceId));
    if (!row) throw notFound(instanceId);
    const tokens = await this.db.tokens.asNoTracking().where((t) => t.instanceId.eq(instanceId)).orderBy((t) => t.id).toList();
    return { ...summaryOf(row), input: row.input, vars: row.vars, nodes: row.nodes, tokens: tokens.map(tokenOf) };
  }

  async history(instanceId: string): Promise<readonly HistoryEntry[]> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const exists = await this.db.instances.asNoTracking().where((i) => i.id.eq(instanceId)).count();
    if (exists === 0) throw notFound(instanceId);
    const rows = await this.db.history.asNoTracking().where((h) => h.instanceId.eq(instanceId)).orderBy((h) => h.id).toList();
    return rows.map(historyOf);
  }
}

function notFound(instanceId: string): WorkflowError {
  return new WorkflowError("not_found", `Instance ${instanceId} does not exist`);
}

function actorOf(actor: WorkflowActor): void {
  if (typeof actor !== "object" || actor === null || (actor.kind !== "user" && actor.kind !== "system") || typeof actor.id !== "string" || actor.id === "" || actor.id.length > 200) {
    throw new WorkflowError("invalid_input", "actor must be { kind: \"user\" | \"system\", id }");
  }
}

function optionalText(value: unknown, name: string, max = 200): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new WorkflowError("invalid_input", `${name} must be a string up to ${max} characters`);
  return value;
}

function summaryOf(row: WfInstance): InstanceSummary {
  return {
    id: row.id,
    processKey: row.processKey,
    version: row.version,
    partition: row.partition,
    status: row.status,
    businessKey: row.businessKey,
    startedVia: row.startedVia,
    startedBy: { kind: row.startedByKind, id: row.startedById },
    error: row.error,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  };
}

function tokenOf(row: WfToken) {
  return { id: row.id, nodeId: row.nodeId, viaFlowId: row.viaFlowId, status: row.status, output: row.output, createdAt: row.createdAt, endedAt: row.endedAt };
}

function historyOf(row: WfHistory): HistoryEntry {
  return {
    id: row.id,
    tokenId: row.tokenId,
    nodeId: row.nodeId,
    type: row.type,
    data: row.data,
    actor: row.actorId === null ? null : { kind: row.actorKind === "system" ? "system" : "user", id: row.actorId },
    at: row.at,
  };
}
