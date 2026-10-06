import type { UiJsonObject } from "./serialization";

export const UI_PROFILE_V1_API_VERSION = "ui.bazis.dev/v1" as const;
export const UI_PROFILE_V1_KIND = "UiProfile" as const;

export interface UiProfileV1 {
  readonly apiVersion: typeof UI_PROFILE_V1_API_VERSION;
  readonly kind: typeof UI_PROFILE_V1_KIND;
  readonly metadata: UiProfileMetadataV1;
  readonly spec: UiProfileSpecV1;
}

export interface UiProfileMetadataV1 {
  readonly name: string;
  readonly surface: string;
  readonly owner: string;
  readonly extensions?: UiJsonObject;
}

export interface UiProfileSpecV1 {
  readonly resources: readonly UiResourceProfileV1[];
  readonly customPages?: readonly UiCustomPageProfileV1[];
  readonly requiredRendererCapabilities?: readonly string[];
  readonly extensions?: UiJsonObject;
}

export interface UiCustomPageBaseProfileV1 {
  readonly id: string;
  readonly title: string;
  readonly navigation?: UiNavigationProfileV1;
}

export interface UiSettingsPageProfileV1 extends UiCustomPageBaseProfileV1 {
  readonly kind: "settings";
  readonly operations: {
    readonly read: UiOperationRefV1;
    readonly update: UiOperationRefV1;
  };
  readonly form?: UiFormProfileV1;
}

export interface UiDocumentPageProfileV1 extends UiCustomPageBaseProfileV1 {
  readonly kind: "document";
  readonly operation: UiOperationRefV1;
}

export interface UiDashboardBlockProfileV1 {
  readonly id: string;
  readonly kind: "metric" | "document";
  readonly title: string;
  readonly operation: UiOperationRefV1;
}

export interface UiDashboardPageProfileV1 extends UiCustomPageBaseProfileV1 {
  readonly kind: "dashboard";
  readonly blocks: readonly UiDashboardBlockProfileV1[];
}

/** A feature-owned page rendered entirely by a registered client component. */
export interface UiFeaturePageProfileV1 extends UiCustomPageBaseProfileV1 {
  readonly kind: "feature";
  readonly renderer: string;
}

export type UiCustomPageProfileV1 =
  | UiSettingsPageProfileV1
  | UiDocumentPageProfileV1
  | UiDashboardPageProfileV1
  | UiFeaturePageProfileV1;

export interface UiResourceProfileV1 {
  readonly id: string;
  readonly title?: string;
  readonly singularTitle?: string;
  /** Response field whose value identifies a record in renderer routes/actions. */
  readonly keyField?: string;
  readonly navigation?: UiNavigationProfileV1;
  readonly operations?: UiResourceOperationsProfileV1;
  readonly list?: UiListProfileV1;
  readonly detail?: UiDetailProfileV1;
  readonly forms?: UiFormsProfileV1;
  readonly actions?: readonly UiActionProfileV1[];
  readonly extensions?: UiJsonObject;
}

export interface UiNavigationProfileV1 {
  readonly title?: string;
  readonly group?: string;
  readonly icon?: string;
  readonly order?: number;
  readonly hidden?: boolean;
}

export interface UiOperationRefV1 {
  readonly operationId: string;
}

export interface UiResourceOperationsProfileV1 {
  readonly list?: UiOperationRefV1;
  readonly read?: UiOperationRefV1;
  readonly create?: UiOperationRefV1;
  readonly update?: UiOperationRefV1;
  readonly delete?: UiOperationRefV1;
}

export type UiFieldProfileV1 = string;

export interface UiListProfileV1 {
  readonly title?: string;
  readonly columns?: readonly UiFieldProfileV1[];
  readonly selectionFields?: readonly UiFieldProfileV1[];
  readonly defaultSort?: string;
  readonly pageSize?: number;
}

export interface UiDetailProfileV1 {
  readonly titleField?: string;
  readonly subtitleField?: string;
  readonly statusField?: string;
  readonly sections?: readonly UiDetailSectionProfileV1[];
}

export interface UiDetailSectionProfileV1 {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly UiFieldProfileV1[];
}

export interface UiFormsProfileV1 {
  readonly create?: UiFormProfileV1;
  readonly edit?: UiFormProfileV1;
}

export interface UiFormProfileV1 {
  readonly title?: string;
  readonly uiSchema?: UiSchemaElementV1;
}

export type UiSchemaElementV1 =
  | UiSchemaControlV1
  | UiSchemaLabelV1
  | UiSchemaLayoutV1
  | UiSchemaCategorizationV1
  | UiSchemaCategoryV1;

export interface UiSchemaControlV1 {
  readonly type: "Control";
  readonly scope: string;
  readonly label?: string | boolean;
  readonly options?: UiJsonObject;
}

export interface UiSchemaLabelV1 {
  readonly type: "Label";
  readonly text: string;
}

export interface UiSchemaLayoutV1 {
  readonly type: "VerticalLayout" | "HorizontalLayout" | "Group";
  readonly label?: string;
  readonly elements: readonly UiSchemaElementV1[];
}

export interface UiSchemaCategorizationV1 {
  readonly type: "Categorization";
  readonly elements: readonly UiSchemaCategoryV1[];
}

export interface UiSchemaCategoryV1 {
  readonly type: "Category";
  readonly label: string;
  readonly elements: readonly UiSchemaElementV1[];
}

export type UiActionIntentV1 = "primary" | "secondary" | "danger" | "neutral";

export type UiActionPlacementV1 =
  | "list.header"
  | "list.row"
  | "detail.header";

export interface UiActionProfileV1 {
  readonly id: string;
  readonly title: string;
  readonly operation: UiOperationRefV1;
  readonly placements: readonly UiActionPlacementV1[];
  readonly intent?: UiActionIntentV1;
  readonly confirm?: string;
  readonly refresh?: "none" | "resource" | "page" | "all";
  readonly extensions?: UiJsonObject;
}
