import { createHash } from "node:crypto";
import type { OsnvDiagnosticV1 } from "../diagnostics-v1";
import { normalizeBoundedJsonV1 } from "../json/normalizeBoundedJsonV1";
import type { BoundaryJsonValue } from "../json/types-v1";

const UTF8 = new TextEncoder();

export class BoundaryCanonicalizationErrorV1 extends TypeError {
  readonly diagnostics: readonly OsnvDiagnosticV1[];

  constructor(diagnostics: readonly OsnvDiagnosticV1[]) {
    super(diagnostics[0]?.message ?? "Value cannot be canonicalized as bounded JSON.");
    this.name = "BoundaryCanonicalizationErrorV1";
    this.diagnostics = diagnostics;
  }
}

/**
 * RFC 8785 / JCS canonical JSON for an untrusted in-memory value.
 *
 * The input first passes the same bounded structural normalizer used by agent
 * authoring. Raw JSON text must use decodeBoundedJsonV1 before this function so
 * duplicate properties are still observable.
 */
export function canonicalBoundaryJsonV1(input: unknown): string {
  const normalized = normalizeBoundedJsonV1(input);
  if (!normalized.ok) {
    throw new BoundaryCanonicalizationErrorV1(normalized.diagnostics);
  }
  return serializeCanonicalValue(normalized.value);
}

export function canonicalBoundaryJsonBytesV1(input: unknown): Uint8Array {
  return UTF8.encode(canonicalBoundaryJsonV1(input));
}

export function canonicalJsonHashV1(domain: string, input: unknown): string {
  if (!/^[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/.test(domain)) {
    throw new TypeError("Canonical JSON hash domain must be a stable versioned ASCII identifier.");
  }
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalBoundaryJsonV1(input), "utf8")
    .digest("hex");
  return "sha256:" + digest;
}

function serializeCanonicalValue(value: BoundaryJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(serializeCanonicalValue).join(",") + "]";
  }

  const object = value as Readonly<Record<string, BoundaryJsonValue>>;
  const entries = Object.keys(object)
    .sort(compareUtf16)
    .map((key) => JSON.stringify(key) + ":" + serializeCanonicalValue(object[key]!));
  return "{" + entries.join(",") + "}";
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
