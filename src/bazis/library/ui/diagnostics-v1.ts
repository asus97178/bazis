export type UiDiagnosticSeverityV1 = "error" | "warning" | "info";

export interface UiDiagnosticV1 {
  readonly severity: UiDiagnosticSeverityV1;
  readonly code: string;
  readonly message: string;
  readonly profile?: string;
  readonly resource?: string;
  readonly path?: string;
  readonly source?: string;
}

export function uiDiagnosticV1(
  severity: UiDiagnosticSeverityV1,
  code: string,
  message: string,
  context: Omit<UiDiagnosticV1, "severity" | "code" | "message"> = {},
): UiDiagnosticV1 {
  return Object.freeze({
    severity,
    code: requiredText(code, "diagnostic.code"),
    message: requiredText(message, "diagnostic.message"),
    ...context,
  });
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(field + " must be a non-empty string.");
  }
  return normalized;
}
