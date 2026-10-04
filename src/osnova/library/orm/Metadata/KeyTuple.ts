import type { EntityModel, PropertyModel } from "./types";
import { OrmError } from "../errors";

/** Structural, typed primary-key identity; never joins component strings. */
export class KeyTuple {
  private constructor(readonly values: readonly unknown[], private readonly signature: string) {}
  static fromEntity(model: EntityModel, entity: Record<string, unknown>): KeyTuple | undefined {
    const values = model.key.map((property) => entity[property.propertyName]);
    return values.some((value) => value === null || value === undefined) ? undefined : KeyTuple.fromValues(model.key, values);
  }
  static fromInput(model: EntityModel, input: unknown): KeyTuple {
    const properties = model.key;
    const values = properties.length === 1 && (typeof input !== "object" || input === null || input instanceof Date || input instanceof Uint8Array)
      ? [input]
      : readObject(properties, input);
    if (values.some((value) => value === null || value === undefined)) throw new OrmError(`Primary key for "${model.name}" is incomplete.`);
    return KeyTuple.fromValues(properties, values);
  }
  private static fromValues(properties: readonly PropertyModel[], values: readonly unknown[]): KeyTuple {
    return new KeyTuple([...values], JSON.stringify(values.map((value, index) => [properties[index]!.type, stable(value)])));
  }
  equals(other: KeyTuple): boolean { return this.signature === other.signature; }
  toString(): string { return this.signature; }
}
function readObject(properties: readonly PropertyModel[], input: unknown): unknown[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OrmError("Composite primary key requires an object with every key component.");
  const record = input as Record<string, unknown>; const expected = new Set(properties.map((property) => property.propertyName));
  for (const name of Object.keys(record)) if (!expected.has(name)) throw new OrmError(`Primary key has unexpected component "${name}".`);
  return properties.map((property) => { if (!(property.propertyName in record)) throw new OrmError(`Primary key is missing component "${property.propertyName}".`); return record[property.propertyName]; });
}
function stable(value: unknown): unknown {
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value instanceof Uint8Array) return ["bytes", [...value]];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  return [typeof value, value];
}
