import { describe, expect, test } from "bun:test";
import {
  appendJsonPointerV1,
  finalizeOsnovaDiagnosticsV1,
  type OsnovaDiagnosticV1,
} from "@/library/boundary";

describe("Osnova diagnostics v1", () => {
  test("escapes RFC 6901 pointer segments", () => {
    expect(appendJsonPointerV1("/nodes", "a~/b")).toBe("/nodes/a~0~1b");
    expect(appendJsonPointerV1("", 0)).toBe("/0");
  });

  test("sorts deterministically and truncates at the requested tighter ceiling", () => {
    const diagnostics: OsnovaDiagnosticV1[] = [
      item("/b", "Z", "warning"),
      item("/a", "B", "error"),
      item("/a", "A", "warning"),
      item("/c", "C", "info"),
    ];

    const finalized = finalizeOsnovaDiagnosticsV1(diagnostics, 3);
    expect(finalized.truncated).toBe(true);
    expect(finalized.diagnostics.map((value) => value.code)).toEqual([
      "A",
      "B",
      "WF_DIAGNOSTICS_TRUNCATED",
    ]);
  });
});

function item(
  pointer: string,
  code: string,
  severity: OsnovaDiagnosticV1["severity"],
): OsnovaDiagnosticV1 {
  return {
    severity,
    stage: "schema",
    code,
    message: code,
    pointer,
  };
}
