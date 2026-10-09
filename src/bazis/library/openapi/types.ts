export type OpenApiSchema = Readonly<Record<string, unknown>>;

export interface GeneratedOpenApiOperationMetadata {
  readonly response?: OpenApiSchema;
  /** Success status from the method's result helpers (`Created` -> 201). */
  readonly status?: number;
  /** Error statuses returned or thrown in the method body. */
  readonly errors?: readonly number[];
  /** First line of the method's JSDoc. */
  readonly summary?: string;
  /** The rest of the method's JSDoc. */
  readonly description?: string;
}

export interface GeneratedOpenApiMetadata {
  readonly schemas: Readonly<Record<string, OpenApiSchema>>;
  readonly operations: Readonly<Record<string, Readonly<Record<string, GeneratedOpenApiOperationMetadata>>>>;
}

export interface OpenApiDocsOptions {
  /**
   * Enables or disables built-in API docs. When omitted, docs are available in
   * debug environments and disabled in production.
   */
  readonly enabled?: boolean;
  /** Absolute path of the HTML UI. Default: "/docs". */
  readonly path?: string;
  /** Absolute path of the OpenAPI JSON document. Default: "<path>/openapi.json". */
  readonly specPath?: string;
  /** OpenAPI info.title. Default: "Bazis API". */
  readonly title?: string;
  /** OpenAPI info.version. Default: "1.0.0". */
  readonly version?: string;
}

export interface PreparedOpenApiDocs {
  readonly uiPath: string;
  readonly specPath: string;
  readonly document: OpenApiSchema;
  readonly json: string;
  readonly html: string;
}

export type OpenApiParameterLocation = "path" | "query" | "header";

export interface OpenApiParameter {
  readonly name: string;
  readonly in: OpenApiParameterLocation;
  readonly required?: boolean;
  readonly schema?: OpenApiSchema;
  readonly description?: string;
  readonly style?: string;
  readonly explode?: boolean;
  /** Allowed sort field names, without direction prefixes. An empty list forbids sorting. */
  readonly "x-bazis-sort-fields"?: readonly string[];
}

export interface OpenApiCatalogOperation {
  readonly path: string;
  readonly httpMethod: string;
  readonly tag: string;
  readonly operationId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiSchema;
  readonly responses: Readonly<Record<string, OpenApiSchema>>;
  readonly authorized?: boolean;
  readonly versions?: readonly string[];
}

export interface OpenApiDocumentBuildInput {
  readonly title: string;
  readonly version: string;
  readonly operations: readonly OpenApiCatalogOperation[];
  readonly schemas: Readonly<Record<string, OpenApiSchema>>;
  readonly generatedBy?: string;
}
