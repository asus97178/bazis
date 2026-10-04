import { randomUUID } from "node:crypto";
import { types } from "node:util";

const mapEntries = Map.prototype.entries;
const setValues = Set.prototype.values;
const unsupported = Symbol("unsupported automatic cache argument");

interface ValueNode {
  value?: unknown;
  identity?: string;
}

/** Value snapshots and collection-key identities belong to one service proxy. */
export class AutomaticCacheKey {
  private readonly identities = new WeakMap<object, string>();
  private readonly namespace = randomUUID();
  private nextIdentity = 0;

  /** Unsupported input disables caching for this call; it never invokes application accessors. */
  public build(args: readonly unknown[]): string | undefined {
    const indices = new WeakMap<object, number>();
    const active = new WeakSet<object>();
    const nodes: ValueNode[] = [];
    const encode = (value: unknown, identity = false): unknown => {
      if (value === undefined) return ["undefined"];
      if (value === null) return ["null"];
      if (typeof value === "string") return ["string", value];
      if (typeof value === "boolean") return ["boolean", value];
      if (typeof value === "number") {
        if (Number.isNaN(value)) return ["number", "NaN"];
        if (value === Infinity) return ["number", "+Infinity"];
        if (value === -Infinity) return ["number", "-Infinity"];
        if (Object.is(value, -0)) return ["number", "-0"];
        return ["number", value];
      }
      if (typeof value === "bigint") return ["bigint", value.toString()];
      if (typeof value !== "object" || types.isProxy(value) || active.has(value)) throw unsupported;
      let index = indices.get(value);
      if (index === undefined) {
        index = nodes.length;
        indices.set(value, index);
        nodes.push({});
        active.add(value);
        nodes[index]!.value = contents(value);
        active.delete(value);
      }
      // The same object may have appeared in an earlier argument before its role
      // as a Map key / Set member becomes known. Update its shared node in place.
      if (identity) nodes[index]!.identity = this.identityOf(value);
      return ["ref", index];
    };
    const contents = (value: object): unknown => {
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Date.prototype || prototype === Map.prototype || prototype === Set.prototype) {
        if (Reflect.ownKeys(value).length !== 0) throw unsupported;
        if (prototype === Date.prototype) return ["date", Date.prototype.toISOString.call(value)];
        if (prototype === Map.prototype) {
          const entries: unknown[] = [];
          for (const [key, entry] of mapEntries.call(value as Map<unknown, unknown>)) {
            entries.push([encode(key, true), encode(entry)]);
          }
          return ["map", entries];
        }
        const entries: unknown[] = [];
        for (const entry of setValues.call(value as Set<unknown>)) entries.push(encode(entry, true));
        return ["set", entries];
      }
      const array = Array.isArray(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw unsupported;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (array && key === "length") continue;
        const descriptor = descriptors[key as string]!;
        if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)
          || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) throw unsupported;
      }
      if (array) {
        const entries: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = descriptors[index];
          entries.push(descriptor ? encode(descriptor.value) : ["hole"]);
        }
        return ["array", entries];
      }
      return ["object", prototype === null ? "null-prototype" : "Object",
        Object.keys(descriptors).sort().map((key) => [key, encode(descriptors[key]!.value)])];
    };
    try {
      return JSON.stringify([args.map((value) => encode(value)), nodes]);
    } catch {
      // Includes invalid Date/internal-slot impostors and traversal limits.
      // Explicit key builders and the original method run outside this boundary.
      return undefined;
    }
  }

  private identityOf(value: object): string {
    let identity = this.identities.get(value);
    if (identity === undefined) {
      if (!Number.isSafeInteger(++this.nextIdentity)) throw unsupported;
      identity = `${this.namespace}:${this.nextIdentity}`;
      this.identities.set(value, identity);
    }
    return identity;
  }
}
