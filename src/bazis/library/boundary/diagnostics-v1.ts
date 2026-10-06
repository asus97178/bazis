import type { BoundaryJsonValue } from "./json/types-v1";

export type BazisDiagnosticSeverityV1 = "error" | "warning" | "info";
export type BazisDiagnosticStageV1 = "decode" | "schema" | "semantic" | "compile" | "bind";

export interface BazisDiagnosticSourceV1 {
  readonly byteOffset: number;
  readonly line: number;
  readonly column: number;
}

export interface BazisDiagnosticRepairV1 {
  readonly action: "add" | "remove" | "replace";
  readonly pointer: string;
  readonly value?: BoundaryJsonValue;
}

export interface BazisDiagnosticV1 {
  readonly severity: BazisDiagnosticSeverityV1;
  readonly stage: BazisDiagnosticStageV1;
  readonly code: string;
  readonly message: string;
  readonly pointer: string;
  readonly nodeId?: string;
  readonly flowId?: string;
  readonly source?: BazisDiagnosticSourceV1;
  readonly repair?: BazisDiagnosticRepairV1;
}

export interface BazisDiagnosticsV1 {
  readonly diagnostics: readonly BazisDiagnosticV1[];
  readonly truncated: boolean;
}

export const BAZIS_DIAGNOSTIC_LIMIT_V1 = 100;
const DIAGNOSTIC_MESSAGE_BYTES_V1 = 512;
const DIAGNOSTIC_POINTER_BYTES_V1 = 2_048;
const UTF8 = new TextEncoder();

const SEVERITY_ORDER: Readonly<Record<BazisDiagnosticSeverityV1, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function bazisDiagnosticV1(
  diagnostic: BazisDiagnosticV1,
): BazisDiagnosticV1 {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(diagnostic.code)) {
    throw new TypeError("Diagnostic code must be a stable uppercase ASCII identifier.");
  }
  return Object.freeze({
    ...diagnostic,
    message: truncateUtf8(diagnostic.message, DIAGNOSTIC_MESSAGE_BYTES_V1),
    pointer: boundedPointer(diagnostic.pointer),
    source: diagnostic.source === undefined ? undefined : Object.freeze({ ...diagnostic.source }),
    repair: diagnostic.repair === undefined ? undefined : Object.freeze({
      ...diagnostic.repair,
      pointer: boundedPointer(diagnostic.repair.pointer),
    }),
  });
}

export function finalizeBazisDiagnosticsV1(
  diagnostics: readonly BazisDiagnosticV1[],
  limit = BAZIS_DIAGNOSTIC_LIMIT_V1,
): BazisDiagnosticsV1 {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Diagnostic limit must be a positive safe integer.");
  }
  const safeLimit = Math.min(BAZIS_DIAGNOSTIC_LIMIT_V1, limit);
  const sorted = [...diagnostics].sort(compareDiagnosticsV1);
  if (sorted.length <= safeLimit) {
    return Object.freeze({
      diagnostics: Object.freeze(sorted.map(bazisDiagnosticV1)),
      truncated: false,
    });
  }

  const visible = sorted.slice(0, Math.max(0, safeLimit - 1)).map(bazisDiagnosticV1);
  visible.push(bazisDiagnosticV1({
    severity: "error",
    stage: "schema",
    code: "WF_DIAGNOSTICS_TRUNCATED",
    message: "Diagnostics were truncated at the configured framework ceiling.",
    pointer: "",
  }));
  return Object.freeze({ diagnostics: Object.freeze(visible), truncated: true });
}

export function escapeJsonPointerSegmentV1(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function appendJsonPointerV1(pointer: string, segment: string | number): string {
  return pointer + "/" + escapeJsonPointerSegmentV1(String(segment));
}

function compareDiagnosticsV1(left: BazisDiagnosticV1, right: BazisDiagnosticV1): number {
  return compareText(left.pointer, right.pointer)
    || compareText(left.code, right.code)
    || compareText(left.nodeId ?? "", right.nodeId ?? "")
    || compareText(left.flowId ?? "", right.flowId ?? "")
    || SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedPointer(pointer: string): string {
  if (UTF8.encode(pointer).byteLength <= DIAGNOSTIC_POINTER_BYTES_V1) {
    return pointer;
  }
  const segments = pointer.split("/");
  let output = "";
  for (let index = 1; index < segments.length; index += 1) {
    const candidate = output + "/" + segments[index];
    if (UTF8.encode(candidate).byteLength > DIAGNOSTIC_POINTER_BYTES_V1) {
      break;
    }
    output = candidate;
  }
  return output;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (UTF8.encode(value).byteLength <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    const candidate = output + character;
    if (UTF8.encode(candidate).byteLength > maxBytes) break;
    output = candidate;
  }
  return output;
}
