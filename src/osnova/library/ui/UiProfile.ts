import type {
  UiControllerClass,
  UiCustomPagesProfileAuthoringOptions,
  UiProfileAuthoringOptions,
  UiRequestClass,
  UiResponseReference,
} from "./uiProfileAuthoring";
import { defineUiProfileAuthoringMetadata } from "./uiProfileAuthoringMetadata";

/**
 * Stores process-local, reference-based UI authoring metadata on a profile
 * class. No JSON normalization or controller/DTO name matching happens here.
 */
export function UiProfile<
  Controller extends UiControllerClass = UiControllerClass,
  Response extends UiResponseReference | undefined = undefined,
  ListRequest extends UiRequestClass | undefined = undefined,
  CreateRequest extends UiRequestClass | undefined = undefined,
  EditRequest extends UiRequestClass | undefined = undefined,
>(
  profile:
    | UiProfileAuthoringOptions<Controller, Response, ListRequest, CreateRequest, EditRequest>
    | UiCustomPagesProfileAuthoringOptions,
) {
  return uiProfileDecorator(profile);
}

function uiProfileDecorator(profile: UiProfileAuthoringOptions<any, any, any, any, any> | UiCustomPagesProfileAuthoringOptions) {
  return (value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    defineUiProfileAuthoringMetadata(value, context.metadata, profile as import("./uiProfileAuthoring").AnyUiProfileAuthoringOptions);
  };
}

export {
  uiOperation,
  uiEndpoint,
} from "./uiProfileAuthoring";
export {
  isUiProfileAuthoringClass,
  uiProfileAuthoringMetadataOf,
} from "./uiProfileAuthoringMetadata";
export type {
  AnyUiProfileAuthoringOptions,
  UiActionIntentOverride,
  UiActionPlacementOverride,
  UiAuthoringClass,
  UiControllerClass,
  UiControllerMethod,
  UiControllerMethodKey,
  UiControllerMethodReference,
  UiCustomPageAuthoring,
  UiCustomPageBaseAuthoring,
  UiCustomPagesProfileAuthoringOptions,
  UiDashboardBlockAuthoring,
  UiDashboardPageAuthoring,
  UiDataFieldKey,
  UiDeleteAuthoringOverride,
  UiDocumentPageAuthoring,
  UiEndpointAuthoringOptions,
  UiEndpointReference,
  UiFeaturePageAuthoring,
  UiFieldSelection,
  UiListFieldOverride,
  UiFormFieldMap,
  UiFormFieldOverride,
  UiFormAuthoringOverride,
  UiListAuthoringOverride,
  UiProfileAuthoringOptions,
  UiProfileNavigationOverride,
  UiProfileOperations,
  UiRequestClass,
  UiResponseReference,
  UiResponseValue,
  UiSettingsPageAuthoring,
  UiSortField,
} from "./uiProfileAuthoring";
export type { UiProfileAuthoringMetadata } from "./uiProfileAuthoringMetadata";
