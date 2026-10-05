import type { UiDiagnosticV1 } from "./diagnostics-v1";
import type {
  UiActionIntentV1,
  UiActionPlacementV1,
  UiDetailProfileV1,
  UiFormProfileV1,
  UiFormsProfileV1,
  UiListProfileV1,
} from "./profile-v1";
import type { UiJsonObject } from "./serialization";

export const COMPILED_UI_SURFACE_V1_API_VERSION = "ui.osnv.dev/v1" as const;
export const COMPILED_UI_SURFACE_V1_KIND = "CompiledUiSurface" as const;

export interface CompiledUiSurfaceV1 {
  readonly apiVersion: typeof COMPILED_UI_SURFACE_V1_API_VERSION;
  readonly kind: typeof COMPILED_UI_SURFACE_V1_KIND;
  readonly metadata: CompiledUiSurfaceMetadataV1;
  readonly links: CompiledUiSurfaceLinksV1;
  readonly spec: CompiledUiSurfaceSpecV1;
  readonly diagnostics?: readonly UiDiagnosticV1[];
}

export interface CompiledUiSurfaceMetadataV1 {
  readonly surface: string;
  readonly revision: string;
}

export interface CompiledUiSurfaceLinksV1 {
  readonly openapi: string;
  readonly session?: string;
}

export interface CompiledUiSurfaceSpecV1 {
  readonly navigation: readonly CompiledUiNavigationItemV1[];
  readonly resources: readonly CompiledUiResourceV1[];
  readonly customPages?: readonly CompiledUiCustomPageV1[];
  readonly requiredRendererCapabilities: readonly string[];
  readonly extensions?: UiJsonObject;
}

export interface CompiledUiNavigationItemV1 {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly resource?: string;
  readonly page?: string;
  readonly group?: string;
  readonly icon?: string;
  readonly order?: number;
}

export interface CompiledUiCustomPageBaseV1 {
  readonly id: string;
  readonly title: string;
  readonly route: string;
}

export interface CompiledUiSettingsPageV1 extends CompiledUiCustomPageBaseV1 {
  readonly kind: "settings";
  readonly operations: {
    readonly read: CompiledUiOperationRefV1;
    readonly update?: CompiledUiOperationRefV1;
  };
  readonly form?: UiFormProfileV1;
}

export interface CompiledUiDocumentPageV1 extends CompiledUiCustomPageBaseV1 {
  readonly kind: "document";
  readonly operation: CompiledUiOperationRefV1;
}

export interface CompiledUiDashboardBlockV1 {
  readonly id: string;
  readonly kind: "metric" | "document";
  readonly title: string;
  readonly operation: CompiledUiOperationRefV1;
}

export interface CompiledUiDashboardPageV1 extends CompiledUiCustomPageBaseV1 {
  readonly kind: "dashboard";
  readonly blocks: readonly CompiledUiDashboardBlockV1[];
}

export interface CompiledUiFeaturePageV1 extends CompiledUiCustomPageBaseV1 {
  readonly kind: "feature";
  readonly renderer: string;
}

export type CompiledUiCustomPageV1 =
  | CompiledUiSettingsPageV1
  | CompiledUiDocumentPageV1
  | CompiledUiDashboardPageV1
  | CompiledUiFeaturePageV1;

export interface CompiledUiOperationRefV1 {
  readonly operationId: string;
}

export interface CompiledUiResourceOperationsV1 {
  readonly list?: CompiledUiOperationRefV1;
  readonly read?: CompiledUiOperationRefV1;
  readonly create?: CompiledUiOperationRefV1;
  readonly update?: CompiledUiOperationRefV1;
  readonly delete?: CompiledUiOperationRefV1;
}

export interface CompiledUiResourceV1 {
  readonly id: string;
  readonly title: string;
  readonly singularTitle?: string;
  readonly keyField?: string;
  readonly route: string;
  readonly operations: CompiledUiResourceOperationsV1;
  readonly list?: UiListProfileV1;
  readonly detail?: UiDetailProfileV1;
  readonly forms?: UiFormsProfileV1;
  readonly actions: readonly CompiledUiActionV1[];
  readonly extensions?: UiJsonObject;
}

export interface CompiledUiActionV1 {
  readonly id: string;
  readonly title: string;
  readonly operation: CompiledUiOperationRefV1;
  readonly placements: readonly UiActionPlacementV1[];
  readonly intent?: UiActionIntentV1;
  readonly confirm?: string;
  readonly refresh?: "none" | "resource" | "page" | "all";
  readonly extensions?: UiJsonObject;
}
