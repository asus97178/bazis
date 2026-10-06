import { describe, expect, test } from "bun:test";
import { Secret } from "@/core/kernel";
import { agentSessionCheckpointProtection } from "../protector";

const sessionId = "11111111-1111-4111-8111-111111111111";
const bindingHash = "b".repeat(64);
function protector(keys: object, readableKeyIds = ["active"]) {
  const values = new Map<string, unknown>([["activeKeyId", "active"], ["readableKeyIds", readableKeyIds], ["keys", keys]]);
  return agentSessionCheckpointProtection({ get: (key: string) => values.get(key), has: (key: string) => values.has(key) } as never).create();
}
describe("Session checkpoint protection", () => {
  test("seals, opens and rejects swapped bindings", async () => {
    const value = protector({ active: new Secret("test-only-key") });
    const sealed = await value.seal({ sessionId, checkpointRevision: 1, bindingHash, canonicalCheckpointJson: '{"messages":[]}' });
    expect(sealed.ciphertext).not.toContain("messages");
    await expect(value.open({ expectedSessionId: sessionId, expectedCheckpointRevision: 1, expectedBindingHash: bindingHash, sealed })).resolves.toBe('{"messages":[]}');
    await expect(value.open({ expectedSessionId: sessionId, expectedCheckpointRevision: 2, expectedBindingHash: bindingHash, sealed })).rejects.toThrow();
  });
  test("rejects getter, duplicate and disabled key shapes without getter execution", () => {
    let reads = 0;
    const hostile = Object.create(Object.prototype, { active: { enumerable: true, get() { reads += 1; return new Secret("x"); } } });
    expect(() => protector(hostile)).toThrow();
    expect(reads).toBe(0);
    expect(() => protector({ active: new Secret("x") }, ["active", "active"])).toThrow();
    expect(() => protector({ active: new Secret("x") }, ["other"])).toThrow();
    const hidden = Object.create(Object.prototype, { active: { enumerable: true, value: new Secret("x") }, hidden: { enumerable: false, value: new Secret("x") } });
    expect(() => protector(hidden)).toThrow();
  });
  test("rejects hostile seal and open requests without invoking their accessors", async () => {
    const value = protector({ active: new Secret("test-only-key") });
    let reads = 0;
    const hostile = Object.create(Object.prototype, { sessionId: { enumerable: true, get() { reads += 1; return sessionId; } } });
    await expect(value.seal(hostile as never)).rejects.toThrow();
    await expect(value.open(new Proxy({} as never, {}))).rejects.toThrow();
    expect(reads).toBe(0);
  });
});
