import type { BoundaryJsonValue } from "./json/types-v1";

export type OsnovaDiagnosticSeverityV1 = "error" | "warning" | "info";
export type OsnovaDiagnosticStageV1 = "decode" | "schema" | "semantic" | "compile" | "bind";

export interface OsnovaDiagnosticSourceV1 {
  readonly byteOffset: number;
  readonly line: number;
  readonly column: number;
}

export interface OsnovaDiagnosticRepairV1 {
  readonly action: "add" | "remove" | "replace";
  readonly pointer: string;
  readonly value?: BoundaryJsonValue;
}

export interface OsnovaDiagnosticV1 {
  readonly severity: OsnovaDiagnosticSeverityV1;
  readonly stage: OsnovaDiagnosticStageV1;
  readonly code: string;
  readonly message: string;
  readonly pointer: string;
  readonly nodeId?: string;
  readonly flowId?: string;
  readonly source?: OsnovaDiagnosticSourceV1;
  readonly repair?: OsnovaDiagnosticRepairV1;
}

export interface OsnovaDiagnosticsV1 {
  readonly diagnostics: readonly OsnovaDiagnosticV1[];
  readonly truncated: boolean;
}

export const OSNOVA_DIAGNOSTIC_LIMIT_V1 = 100;
const DIAGNOSTIC_MESSAGE_BYTES_V1 = 512;
const DIAGNOSTIC_POINTER_BYTES_V1 = 2_048;
const UTF8 = new TextEncoder();

const SEVERITY_ORDER: Readonly<Record<OsnovaDiagnosticSeverityV1, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function osnovaDiagnosticV1(
  diagnostic: OsnovaDiagnosticV1,
): OsnovaDiagnosticV1 {
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

export function finalizeOsnovaDiagnosticsV1(
  diagnostics: readonly OsnovaDiagnosticV1[],
  limit = OSNOVA_DIAGNOSTIC_LIMIT_V1,
): OsnovaDiagnosticsV1 {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Diagnostic limit must be a positive safe integer.");
  }
  const safeLimit = Math.min(OSNOVA_DIAGNOSTIC_LIMIT_V1, limit);
  const sorted = [...diagnostics].sort(compareDiagnosticsV1);
  if (sorted.length <= safeLimit) {
    return Object.freeze({
      diagnostics: Object.freeze(sorted.map(osnovaDiagnosticV1)),
      truncated: false,
    });
  }

  const visible = sorted.slice(0, Math.max(0, safeLimit - 1)).map(osnovaDiagnosticV1);
  visible.push(osnovaDiagnosticV1({
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

function compareDiagnosticsV1(left: OsnovaDiagnosticV1, right: OsnovaDiagnosticV1): number {
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
