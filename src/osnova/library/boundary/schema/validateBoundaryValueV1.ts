import {
  finalizeOsnovaDiagnosticsV1,
  osnovaDiagnosticV1,
  type OsnovaDiagnosticsV1,
  type OsnovaDiagnosticV1,
} from "../diagnostics-v1";
import { normalizeBoundedJsonV1 } from "../json/normalizeBoundedJsonV1";
import { collectBoundaryValueDiagnosticsV1 } from "./collectBoundaryValueDiagnosticsV1";
import { decodeBoundarySchemaV1 } from "./decodeBoundarySchemaV1";

export interface ValidateBoundaryValueV1Options {
  readonly pointer?: string;
}

export type ValidateBoundaryValueV1Result =
  | ({ readonly ok: true } & OsnovaDiagnosticsV1)
  | ({ readonly ok: false } & OsnovaDiagnosticsV1);

export function validateBoundaryValueV1(
  schema: unknown,
  value: unknown,
  options: ValidateBoundaryValueV1Options = {},
): ValidateBoundaryValueV1Result {
  const decodedSchema = decodeBoundarySchemaV1(schema);
  if (!decodedSchema.ok) {
    return Object.freeze({
      ok: false,
      diagnostics: decodedSchema.diagnostics,
      truncated: decodedSchema.truncated,
    });
  }

  const normalized = normalizeBoundedJsonV1(value);
  if (!normalized.ok) {
    const pointer = options.pointer ?? "";
    const diagnostics = pointer === ""
      ? normalized.diagnostics
      : Object.freeze(normalized.diagnostics.map((item) => osnovaDiagnosticV1({
          ...item,
          pointer: pointer + item.pointer,
        })));
    return Object.freeze({
      ok: false,
      diagnostics,
      truncated: normalized.truncated,
    });
  }

  const diagnostics: OsnovaDiagnosticV1[] = [];
  collectBoundaryValueDiagnosticsV1(
    decodedSchema.schema,
    normalized.value,
    options.pointer ?? "",
    diagnostics,
  );
  const finalized = finalizeOsnovaDiagnosticsV1(diagnostics);
  return Object.freeze({ ok: finalized.diagnostics.length === 0, ...finalized });
}
