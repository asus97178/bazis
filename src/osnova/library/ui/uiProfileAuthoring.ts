/**
 * Process-local authoring contracts for `@UiProfile()`.
 *
 * These declarations deliberately keep controller and request-model class
 * references. They are application metadata, not the JSON wire contract. A
 * higher layer may resolve them against HTTP/OpenAPI metadata and only then
 * produce a serializable `UiProfileV1`.
 */

export type UiAuthoringClass<T = object> = abstract new (...args: any[]) => T;
export type UiControllerClass<T = object> = UiAuthoringClass<T>;
export type UiRequestClass<T = object> = UiAuthoringClass<T>;

export type UiControllerMethodKey<Controller extends UiControllerClass> = {
  [Key in keyof InstanceType<Controller>]-?: InstanceType<Controller>[Key] extends
    (...args: any[]) => unknown
    ? Key
    : never;
}[keyof InstanceType<Controller>] & string;

export type UiControllerMethod<Controller extends UiControllerClass> =
  InstanceType<Controller>[UiControllerMethodKey<Controller>] & ((...args: any[]) => unknown);

export type UiDataFieldKey<Model> = unknown extends Model
  ? string
  : {
      [Key in keyof Model]-?: Model[Key] extends (...args: any[]) => unknown
        ? never
        : Key;
    }[keyof Model] & string;

export type UiResponseReference<Response = unknown> = UiAuthoringClass<Response>;

export type UiResponseValue<Reference> = Reference extends UiAuthoringClass<infer Response>
  ? Response
  : unknown;

export type UiRequestValue<Reference> = Reference extends UiRequestClass<infer Request>
  ? Request
  : unknown;

export interface UiControllerMethodReference<Controller extends UiControllerClass = UiControllerClass> {
  readonly kind: "ui-controller-method";
  readonly controller: Controller;
  readonly action: UiControllerMethod<Controller>;
}

/** Captures exact controller-action identity for an explicit CRUD operation. */
export function uiOperation<Controller extends UiControllerClass>(
  controller: Controller,
  action: UiControllerMethod<Controller>,
): UiControllerMethodReference<Controller> {
  return Object.freeze({
    kind: "ui-controller-method",
    controller,
    action,
  });
}

export interface UiEndpointAuthoringOptions<
  Request extends UiRequestClass | undefined = undefined,
  Response extends UiResponseReference | undefined = undefined,
> {
  readonly request?: Request;
  readonly response?: Response;
}

export interface UiEndpointReference<
  Controller extends UiControllerClass = UiControllerClass,
  Request extends UiRequestClass | undefined = UiRequestClass | undefined,
  Response extends UiResponseReference | undefined = UiResponseReference | undefined,
> {
  readonly kind: "ui-endpoint";
  readonly controller: Controller;
  readonly action: UiControllerMethod<Controller>;
  readonly request?: Request;
  readonly response?: Response;
}

/**
 * Captures exact controller-action identity plus optional nominal request and
 * response assertions.
 */
export function uiEndpoint<
  Controller extends UiControllerClass,
  Request extends UiRequestClass | undefined = undefined,
  Response extends UiResponseReference | undefined = undefined,
>(
  controller: Controller,
  action: UiControllerMethod<Controller>,
  assertions?: UiEndpointAuthoringOptions<Request, Response>,
): UiEndpointReference<Controller, Request, Response>;
export function uiEndpoint<
  Controller extends UiControllerClass,
  Request extends UiRequestClass | undefined = undefined,
  Response extends UiResponseReference | undefined = undefined,
>(
  controller: Controller,
  action: UiControllerMethod<Controller>,
  assertions: UiEndpointAuthoringOptions<Request, Response> = {},
): UiEndpointReference<Controller, Request, Response> {
  return Object.freeze({
    kind: "ui-endpoint",
    controller,
    action,
    ...(assertions.request !== undefined ? { request: assertions.request } : {}),
    ...(assertions.response !== undefined ? { response: assertions.response } : {}),
  });
}

export interface UiProfileOperations<Controller extends UiControllerClass> {
  readonly list?: UiControllerMethodReference<Controller>;
  readonly read?: UiControllerMethodReference<Controller>;
  readonly create?: UiControllerMethodReference<Controller>;
  readonly update?: UiControllerMethodReference<Controller>;
  readonly delete?: UiControllerMethodReference<Controller>;
}

export interface UiProfileNavigationOverride {
  readonly title?: string;
  readonly group?: string;
  readonly icon?: string;
  readonly order?: number;
  readonly hidden?: boolean;
}

export interface UiListFieldOverride {
  readonly hidden?: boolean;
}

export interface UiFormFieldOverride {
  readonly label?: string;
  readonly hidden?: boolean;
  readonly options?: Readonly<Record<string, unknown>>;
}

/**
 * Typed field selection keyed by real response/request properties.
 */
export type UiFieldSelection<Model = unknown> = Partial<Readonly<Record<
  UiDataFieldKey<Model>,
  UiListFieldOverride
>>>;

export type UiFormFieldMap<Model = unknown> = Partial<Readonly<Record<
  UiDataFieldKey<Model>,
  UiFormFieldOverride
>>>;

export type UiSortField<Model> =
  | UiDataFieldKey<Model>
  | `-${UiDataFieldKey<Model>}`;

export interface UiListAuthoringOverride<
  Response = unknown,
  Request extends UiRequestClass | undefined = undefined,
> {
  /** Optional direct list-request contract; filters/sort are typed from it. */
  readonly request?: Request;
  readonly title?: string;
  readonly columns?: UiFieldSelection<Response>;
  readonly filters?: UiFieldSelection<UiRequestValue<Request>>;
  readonly defaultSort?: UiSortField<UiRequestValue<Request>>;
  readonly pageSize?: number;
}

export interface UiFormAuthoringOverride<
  Request extends UiRequestClass | undefined = undefined,
> {
  /** Direct request contract; validation facts remain owned by this class. */
  readonly request?: Request;
  readonly title?: string;
  readonly fields?: UiFormFieldMap<UiRequestValue<Request>>;
}

export type UiActionIntentOverride = "primary" | "secondary" | "danger" | "neutral";

export type UiActionPlacementOverride =
  | "list.header"
  | "list.row"
  | "detail.header";

export interface UiDeleteAuthoringOverride {
  readonly title?: string;
  readonly intent?: UiActionIntentOverride;
  readonly confirm?: string;
  readonly placements?: readonly UiActionPlacementOverride[];
  readonly refresh?: "none" | "resource" | "page" | "all";
  readonly hidden?: boolean;
}

export interface UiCustomPageBaseAuthoring {
  readonly id: string;
  readonly title: string;
  readonly navigation?: UiProfileNavigationOverride;
}

export interface UiSettingsPageAuthoring extends UiCustomPageBaseAuthoring {
  readonly kind: "settings";
  readonly read: UiEndpointReference;
  readonly update: UiEndpointReference;
  readonly form?: {
    readonly title?: string;
    readonly fields?: UiFormFieldMap<any>;
  };
}

export interface UiDocumentPageAuthoring extends UiCustomPageBaseAuthoring {
  readonly kind: "document";
  readonly load: UiEndpointReference;
}

export interface UiDashboardBlockAuthoring {
  readonly id: string;
  readonly kind: "metric" | "document";
  readonly title: string;
  readonly load: UiEndpointReference;
}

export interface UiDashboardPageAuthoring extends UiCustomPageBaseAuthoring {
  readonly kind: "dashboard";
  readonly blocks: readonly UiDashboardBlockAuthoring[];
}

/** Feature-owned client page. Transport remains outside the UI profile. */
export interface UiFeaturePageAuthoring extends UiCustomPageBaseAuthoring {
  readonly kind: "feature";
  readonly renderer: string;
}

export type UiCustomPageAuthoring =
  | UiSettingsPageAuthoring
  | UiDocumentPageAuthoring
  | UiDashboardPageAuthoring
  | UiFeaturePageAuthoring;

/** Page-only profile; feature modules keep one local profile per owner. */
export interface UiCustomPagesProfileAuthoringOptions {
  readonly surface: string;
  readonly customPages: readonly UiCustomPageAuthoring[];
}

/**
 * Application-facing UI profile. Everything except the process-local source
 * references is presentation intent; transport, validation and authorization
 * remain owned by HTTP/OpenAPI/policy layers.
 */
export interface UiProfileAuthoringOptions<
  Controller extends UiControllerClass = UiControllerClass,
  Response extends UiResponseReference | undefined = undefined,
  ListRequest extends UiRequestClass | undefined = undefined,
  CreateRequest extends UiRequestClass | undefined = undefined,
  EditRequest extends UiRequestClass | undefined = undefined,
> {
  readonly surface: string;
  readonly controller: Controller;
  readonly response?: Response;
  /** Stable UI resource id; inferred from a simple controller prefix when omitted. */
  readonly id?: string;
  readonly title?: string;
  readonly singularTitle?: string;
  readonly navigation?: UiProfileNavigationOverride;
  readonly readonly?: boolean;
  /** Advanced overrides keyed by semantic operation name. */
  readonly operations?: UiProfileOperations<Controller>;
  readonly list?: UiListAuthoringOverride<UiResponseValue<Response>, ListRequest>;
  readonly create?: UiFormAuthoringOverride<CreateRequest>;
  readonly edit?: UiFormAuthoringOverride<EditRequest>;
  readonly delete?: UiDeleteAuthoringOverride;
}

/** Broad runtime form used only by metadata readers. */
/** Broad metadata-reader shape; decorator overloads retain strict authoring types. */
export interface AnyUiProfileAuthoringOptions {
  readonly surface: string;
  readonly controller?: UiControllerClass;
  readonly response?: UiResponseReference;
  readonly id?: string;
  readonly title?: string;
  readonly singularTitle?: string;
  readonly navigation?: UiProfileNavigationOverride;
  readonly readonly?: boolean;
  readonly operations?: UiProfileOperations<any>;
  readonly list?: UiListAuthoringOverride<any, any>;
  readonly create?: UiFormAuthoringOverride<any>;
  readonly edit?: UiFormAuthoringOverride<any>;
  readonly delete?: UiDeleteAuthoringOverride;
  readonly customPages?: readonly UiCustomPageAuthoring[];
}
