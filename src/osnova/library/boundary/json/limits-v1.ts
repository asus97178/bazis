export interface BoundaryJsonLimitsV1 {
  readonly maxEncodedBytes: number;
  readonly maxDepth: number;
  readonly maxValues: number;
  readonly maxObjectMembers: number;
  readonly maxMembersPerObject: number;
  readonly maxArrayItems: number;
  readonly maxItemsPerArray: number;
  readonly maxKeyBytes: number;
  readonly maxStringBytes: number;
  readonly maxTotalStringBytes: number;
  readonly maxNumberTokenBytes: number;
}

export const BOUNDARY_JSON_LIMITS_V1: BoundaryJsonLimitsV1 = Object.freeze({
  maxEncodedBytes: 1_048_576,
  maxDepth: 32,
  maxValues: 100_000,
  maxObjectMembers: 50_000,
  maxMembersPerObject: 4_096,
  maxArrayItems: 50_000,
  maxItemsPerArray: 10_000,
  maxKeyBytes: 256,
  maxStringBytes: 65_536,
  maxTotalStringBytes: 524_288,
  maxNumberTokenBytes: 128,
});

export type BoundaryJsonLimitOverridesV1 = Partial<BoundaryJsonLimitsV1>;

export function boundaryJsonLimitsV1(
  overrides: BoundaryJsonLimitOverridesV1 = {},
): BoundaryJsonLimitsV1 {
  const resolved: Record<keyof BoundaryJsonLimitsV1, number> = { ...BOUNDARY_JSON_LIMITS_V1 };
  for (const key of Object.keys(BOUNDARY_JSON_LIMITS_V1) as (keyof BoundaryJsonLimitsV1)[]) {
    const override = overrides[key];
    if (override === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(override) || override < 1) {
      throw new RangeError(`Boundary JSON limit ${key} must be a positive safe integer.`);
    }
    resolved[key] = Math.min(BOUNDARY_JSON_LIMITS_V1[key], override);
  }
  return Object.freeze(resolved);
}
