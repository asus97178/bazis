export type BoundaryJsonPrimitive = null | boolean | number | string;
export type BoundaryJsonValue = BoundaryJsonPrimitive | BoundaryJsonArray | BoundaryJsonObject;
export type BoundaryJsonArray = readonly BoundaryJsonValue[];

export interface BoundaryJsonObject {
  readonly [key: string]: BoundaryJsonValue;
}

export function isBoundaryJsonObject(value: BoundaryJsonValue): value is BoundaryJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
