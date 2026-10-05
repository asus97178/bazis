import type { OpenApiSchema } from "../../openapi";
import type { CompiledUiSurfaceV1 } from "../compiled-v1";
import type { UiDiagnosticV1 } from "../diagnostics-v1";
import type { UiProfileV1 } from "../profile-v1";

export interface CompileUiSurfaceV1Options {
  readonly surface: string;
  readonly profiles: readonly UiProfileV1[];
  readonly openApi: OpenApiSchema;
  readonly links: {
    readonly openapi: string;
    readonly session?: string;
  };
}

export type CompileUiSurfaceV1Result =
  | {
      readonly ok: true;
      readonly document: CompiledUiSurfaceV1;
      readonly diagnostics: readonly UiDiagnosticV1[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly UiDiagnosticV1[];
    };
