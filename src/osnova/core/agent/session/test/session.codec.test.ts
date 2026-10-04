import { describe, expect, test } from "bun:test";
import { canonicalBoundaryJsonV1, openSealedCheckpointEnvelopeV1, sealedCheckpointEnvelopeV1, sessionDigestV1 } from "../codec";

const sessionId = "11111111-1111-4111-8111-111111111111";
const binding = "a".repeat(64);

describe("Session checkpoint codec v1", () => {
  test("canonicalizes equivalent objects deterministically", () => {
    expect(canonicalBoundaryJsonV1({ b: 2, a: [true, null] })).toBe('{"a":[true,null],"b":2}');
    expect(sessionDigestV1("osnova.agent-session/checkpoint/v1", { b: 2, a: 1 })).toBe(sessionDigestV1("osnova.agent-session/checkpoint/v1", { a: 1, b: 2 }));
  });
  test("binds and verifies the exact canonical checkpoint", () => {
    const checkpoint = canonicalBoundaryJsonV1({ messages: [] });
    const sealed = sealedCheckpointEnvelopeV1({ sessionId, checkpointRevision: 1, bindingHash: binding, canonicalCheckpointJson: checkpoint });
    expect(openSealedCheckpointEnvelopeV1(sealed, { sessionId, checkpointRevision: 1, bindingHash: binding })).toBe(checkpoint);
  });
  test("fails closed for changed identity and noncanonical payload", () => {
    const checkpoint = canonicalBoundaryJsonV1({ messages: [] });
    const sealed = sealedCheckpointEnvelopeV1({ sessionId, checkpointRevision: 1, bindingHash: binding, canonicalCheckpointJson: checkpoint });
    expect(() => openSealedCheckpointEnvelopeV1(sealed, { sessionId, checkpointRevision: 2, bindingHash: binding })).toThrow();
    expect(() => canonicalBoundaryJsonV1({ constructor: "pollution" })).toThrow();
    expect(() => sealedCheckpointEnvelopeV1({ sessionId, checkpointRevision: 1, bindingHash: binding, canonicalCheckpointJson: '{ "messages": [] }' })).toThrow();
  });
  test("rejects cycles, accessors, holes and unknown envelope fields without reading accessors", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let read = 0;
    const hostile = Object.create(Object.prototype, { value: { enumerable: true, get() { read += 1; return "no"; } } });
    expect(() => canonicalBoundaryJsonV1(cycle)).toThrow();
    expect(() => canonicalBoundaryJsonV1(hostile)).toThrow();
    expect(read).toBe(0);
    expect(() => canonicalBoundaryJsonV1([, "x"])).toThrow();
    const checkpoint = canonicalBoundaryJsonV1({ messages: [] });
    const sealed = sealedCheckpointEnvelopeV1({ sessionId, checkpointRevision: 1, bindingHash: binding, canonicalCheckpointJson: checkpoint });
    expect(() => openSealedCheckpointEnvelopeV1(sealed.slice(0, -1) + ',"extra":1}', { sessionId, checkpointRevision: 1, bindingHash: binding })).toThrow();
  });
  test("accepts aggregate short strings but retains shared structural ceilings", () => {
    const aggregate = Array.from({ length: 80 }, () => "x".repeat(1024));
    const checkpoint = canonicalBoundaryJsonV1({ aggregate });
    expect(checkpoint.length).toBeGreaterThan(64 * 1024);
    const sealed = sealedCheckpointEnvelopeV1({ sessionId, checkpointRevision: 1, bindingHash: binding, canonicalCheckpointJson: checkpoint });
    expect(openSealedCheckpointEnvelopeV1(sealed, { sessionId, checkpointRevision: 1, bindingHash: binding })).toBe(checkpoint);
    expect(() => canonicalBoundaryJsonV1({ value: "x".repeat(65_537) })).toThrow();
    expect(() => canonicalBoundaryJsonV1({ values: Array.from({ length: 17 }, () => "x".repeat(65_000)) })).toThrow();
  });
});
