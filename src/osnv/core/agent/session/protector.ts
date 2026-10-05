import { createToken } from "../../di";
import { reader, type InfraConnector } from "../../infra";
import { type AppConfig, type ConfigRegistry, Secret } from "../../kernel";
import { ValueConverters, type ValueConverter } from "../../../library/orm";
import { types as nodeUtilTypes } from "node:util";
import { AgentSessionError, type AgentSessionCheckpointProtectionConfigV1, type AgentSessionCheckpointProtectorV1, type AgentSessionOpenRequestV1, type AgentSessionSealRequestV1, type AgentSessionSealedCheckpointV1 } from "./contracts";
import { openSealedCheckpointEnvelopeV1, sealedCheckpointEnvelopeV1 } from "./codec";
import { identifyConnector } from "../../infra/connectorIdentity";

export const AGENT_SESSION_CHECKPOINT_PROTECTOR = createToken<AgentSessionCheckpointProtectorV1>("AgentSessionCheckpointProtectorV1");

function closedDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || nodeUtilTypes.isProxy(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function closedStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) return undefined;
  if (Reflect.ownKeys(value).some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)))) return undefined;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
    result.push(descriptor.value);
  }
  return result;
}

function snapshot(config: AppConfig<AgentSessionCheckpointProtectionConfigV1>) {
  const values = reader(config); const activeKeyId = values.get("activeKeyId"); const readableKeyIds = values.get("readableKeyIds"); const keys = values.get("keys");
  const readable = closedStringArray(readableKeyIds);
  if (typeof activeKeyId !== "string" || !activeKeyId || !readable || !keys || typeof keys !== "object" || nodeUtilTypes.isProxy(keys)) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
  const keyRecord = keys as object;
  if (Object.getPrototypeOf(keyRecord) !== Object.prototype || Reflect.ownKeys(keyRecord).some((key) => typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor")) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
  for (const key of Reflect.ownKeys(keyRecord)) {
    const descriptor = Object.getOwnPropertyDescriptor(keyRecord, key as string);
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !(descriptor.value instanceof Secret)) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
  }
  const converters = new Map<string, ValueConverter<string, string>>();
  for (const id of readable) {
    if (typeof id !== "string" || !id || converters.has(id)) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
    const descriptor = Object.getOwnPropertyDescriptor(keyRecord, id);
    if (!descriptor || descriptor.get || descriptor.set || !(descriptor.value instanceof Secret)) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
    const secret = descriptor.value.reveal();
    if (!secret) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
    converters.set(id, ValueConverters.encrypted(secret));
  }
  if (!converters.has(activeKeyId)) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
  return Object.freeze({ activeKeyId, readable: new Set(converters.keys()), converters });
}
class CheckpointProtector implements AgentSessionCheckpointProtectorV1 {
  constructor(private readonly keys: ReturnType<typeof snapshot>) {}
  async seal(request: AgentSessionSealRequestV1): Promise<AgentSessionSealedCheckpointV1> {
    const input = closedDataRecord(request, ["sessionId", "checkpointRevision", "bindingHash", "canonicalCheckpointJson"]);
    if (!input || typeof input.sessionId !== "string" || typeof input.checkpointRevision !== "number" || typeof input.bindingHash !== "string" || typeof input.canonicalCheckpointJson !== "string") throw new AgentSessionError("AGENT_SESSION_INVALID_REQUEST");
    const converter = this.keys.converters.get(this.keys.activeKeyId);
    if (!converter) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
    const sealRequest: AgentSessionSealRequestV1 = {
      sessionId: input.sessionId,
      checkpointRevision: input.checkpointRevision,
      bindingHash: input.bindingHash,
      canonicalCheckpointJson: input.canonicalCheckpointJson,
    };
    return Object.freeze({ envelopeVersion: "osnv.agent-session/sealed/v1", keyId: this.keys.activeKeyId, ciphertext: converter.toProvider(sealedCheckpointEnvelopeV1(sealRequest)) });
  }
  async open(request: AgentSessionOpenRequestV1): Promise<string> {
    const input = closedDataRecord(request, ["expectedSessionId", "expectedCheckpointRevision", "expectedBindingHash", "sealed"]);
    const sealed = input === undefined ? undefined : closedDataRecord(input.sealed, ["envelopeVersion", "keyId", "ciphertext"]);
    if (!input || !sealed || typeof input.expectedSessionId !== "string" || typeof input.expectedCheckpointRevision !== "number" || typeof input.expectedBindingHash !== "string" || sealed.envelopeVersion !== "osnv.agent-session/sealed/v1" || typeof sealed.keyId !== "string" || typeof sealed.ciphertext !== "string" || !this.keys.readable.has(sealed.keyId)) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
    const converter = this.keys.converters.get(sealed.keyId);
    if (!converter) throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_UNAVAILABLE");
    try { return openSealedCheckpointEnvelopeV1(converter.fromProvider(sealed.ciphertext), { sessionId: input.expectedSessionId, checkpointRevision: input.expectedCheckpointRevision, bindingHash: input.expectedBindingHash }); } catch (error) { if (error instanceof AgentSessionError) throw error; throw new AgentSessionError("AGENT_SESSION_CHECKPOINT_CORRUPT"); }
  }
}
export function agentSessionCheckpointProtection(config: AppConfig<AgentSessionCheckpointProtectionConfigV1>): InfraConnector<AgentSessionCheckpointProtectorV1> {
  return identifyConnector(Object.freeze({
    token: AGENT_SESSION_CHECKPOINT_PROTECTOR,
    config,
    create: (configs?: ConfigRegistry) => new CheckpointProtector(snapshot(configs?.get(config) ?? config)),
    connect: () => undefined,
    dispose: () => undefined,
  }), "agent-session-checkpoint-protection");
}
