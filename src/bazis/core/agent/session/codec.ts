import { canonicalBoundaryJsonV1 as libraryCanonicalBoundaryJsonV1, canonicalJsonHashV1, decodeBoundedJsonV1, normalizeBoundedJsonV1 } from "../../../library/boundary";
import { AgentSessionError } from "./contracts";

const MARKER = "bazis.agent-session/plaintext/v1";
const VERSION = "bazis.agent-session/checkpoint/v1";
export const MAX_CHECKPOINT_BYTES_V1 = 2 * 1024 * 1024;

function fail(code: "AGENT_SESSION_INVALID_REQUEST" | "AGENT_SESSION_CHECKPOINT_CORRUPT" | "AGENT_SESSION_LIMIT_EXCEEDED"): never { throw new AgentSessionError(code); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const normalized = normalizeBoundedJsonV1(value);
  if (!normalized.ok || value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value as object).sort().join(",") !== [...keys].sort().join(",")) fail("AGENT_SESSION_CHECKPOINT_CORRUPT");
  return normalized.value as Record<string, unknown>;
}
function decode(text: string): unknown { const decoded = decodeBoundedJsonV1(text); if (!decoded.ok) fail("AGENT_SESSION_CHECKPOINT_CORRUPT"); return decoded.value; }
export function canonicalBoundaryJsonV1(value: unknown): string { try { return libraryCanonicalBoundaryJsonV1(value); } catch { return fail("AGENT_SESSION_INVALID_REQUEST"); } }
export function sessionDigestV1(domain: string, value: unknown): string { try { return canonicalJsonHashV1(domain, value); } catch { return fail("AGENT_SESSION_INVALID_REQUEST"); } }
export function sealedCheckpointEnvelopeV1(request: { readonly sessionId: string; readonly checkpointRevision: number; readonly bindingHash: string; readonly canonicalCheckpointJson: string }): string {
  if (!/^[0-9a-f-]{36}$/i.test(request.sessionId) || !Number.isSafeInteger(request.checkpointRevision) || request.checkpointRevision < 0 || !/^(sha256:)?[0-9a-f]{64}$/.test(request.bindingHash)) fail("AGENT_SESSION_INVALID_REQUEST");
  const checkpoint = decode(request.canonicalCheckpointJson);
  // Raw JSON admission preserves duplicate-key evidence; only the exact output
  // of the shared canonical serializer is accepted as a checkpoint boundary.
  if (canonicalBoundaryJsonV1(checkpoint) !== request.canonicalCheckpointJson) fail("AGENT_SESSION_INVALID_REQUEST");
  const envelope = { marker: MARKER, version: VERSION, sessionId: request.sessionId, checkpointRevision: request.checkpointRevision, bindingHash: request.bindingHash, checkpointDigest: sessionDigestV1(VERSION, checkpoint), checkpoint };
  const result = canonicalBoundaryJsonV1(envelope);
  if (Buffer.byteLength(result) > MAX_CHECKPOINT_BYTES_V1) fail("AGENT_SESSION_LIMIT_EXCEEDED");
  return result;
}
export function openSealedCheckpointEnvelopeV1(text: string, expected: { readonly sessionId: string; readonly checkpointRevision: number; readonly bindingHash: string }): string {
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES_V1) fail("AGENT_SESSION_CHECKPOINT_CORRUPT");
  const envelope = closed(decode(text), ["marker", "version", "sessionId", "checkpointRevision", "bindingHash", "checkpointDigest", "checkpoint"]);
  if (envelope.marker !== MARKER || envelope.version !== VERSION || envelope.sessionId !== expected.sessionId || envelope.checkpointRevision !== expected.checkpointRevision || envelope.bindingHash !== expected.bindingHash || typeof envelope.checkpointDigest !== "string" || envelope.checkpointDigest !== sessionDigestV1(VERSION, envelope.checkpoint) || canonicalBoundaryJsonV1(envelope) !== text) fail("AGENT_SESSION_CHECKPOINT_CORRUPT");
  return canonicalBoundaryJsonV1(envelope.checkpoint);
}
