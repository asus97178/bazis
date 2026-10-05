import {
  Controller,
  ForbiddenError,
  Get,
  HttpContext,
  NotFoundError,
} from "../../http";
import {
  normalizeUiJsonObject,
  uiDocumentRevision,
  type CompiledUiResourceOperationsV1,
  type CompiledUiResourceV1,
  type CompiledUiCustomPageV1,
  type CompiledUiSurfaceV1,
} from "../../../library/ui";
import { projectOpenApiByOperationIds, type OpenApiSchema } from "../../../library/openapi";
import type {
  RunAppUiSurfaceOptions,
  UiSurfaceHostingOptions,
} from "./uiSurfaceHosting";
import { UiProfileV1Registry } from "./uiProfileResolver";

export const UI_SURFACE_SESSION_V1_API_VERSION = "ui.osnova.dev/v1" as const;
export const UI_SURFACE_SESSION_V1_KIND = "UiSurfaceSession" as const;

export type UiSurfaceOperationRole = keyof CompiledUiResourceOperationsV1;

export interface UiSurfacePolicyResourceInput {
  readonly id: string;
  readonly operations: readonly UiSurfaceOperationRole[];
  readonly actions: readonly string[];
}

export interface UiSurfacePolicyInput {
  readonly surface: string;
  readonly resources: readonly UiSurfacePolicyResourceInput[];
  readonly pages: readonly UiSurfacePolicyPageInput[];
}

export interface UiSurfacePolicyPageInput {
  readonly id: string;
  readonly operations: readonly string[];
}

export interface UiSurfaceResourceDecision {
  readonly resource: string;
  readonly visible: boolean;
  /** Missing/false operation entries are denied. */
  readonly operations?: Readonly<Partial<Record<UiSurfaceOperationRole, boolean>>>;
  /** Explicit action id allow-list. Missing actions are denied. */
  readonly actions?: readonly string[];
}

export interface UiSurfacePolicyDecision {
  readonly resources: readonly UiSurfaceResourceDecision[];
  /** Missing page decisions are denied. */
  readonly pages?: readonly UiSurfacePageDecision[];
}

export interface UiSurfacePageDecision {
  readonly page: string;
  readonly visible: boolean;
  /** Semantic slot allow-list (`read`, `update`, `load`, `blocks.<id>`). */
  readonly operations?: Readonly<Record<string, boolean>>;
}

export interface UiSurfaceSessionUser {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
}

export interface UiSurfaceSessionV1 {
  readonly apiVersion: typeof UI_SURFACE_SESSION_V1_API_VERSION;
  readonly kind: typeof UI_SURFACE_SESSION_V1_KIND;
  readonly metadata: {
    readonly surface: string;
    readonly revision: string;
  };
  readonly app: UiSurfaceHostingOptions["app"];
  readonly currentUser: UiSurfaceSessionUser;
}

interface EffectiveSurface {
  readonly options: RunAppUiSurfaceOptions;
  readonly document: CompiledUiSurfaceV1;
  readonly openApi: OpenApiSchema;
}

interface StaticSurface {
  readonly document: CompiledUiSurfaceV1;
}

/** Compiles declarative profiles once, then applies request policy monotonically. */
export class UiSurfaceDocumentProvider {
  readonly #surfaces = new Map<string, StaticSurface>();

  public constructor(
    private readonly options: UiSurfaceHostingOptions,
    profiles: UiProfileV1Registry,
    private readonly openApiDocument: OpenApiSchema,
  ) {
    const seen = new Set<string>();
    for (const surface of options.surfaces) {
      validateSurfaceRegistration(surface, seen);
      const path = uiSurfacePath(options.apiBasePath, surface.surface);
      const links = Object.freeze({
        openapi: `${path}/openapi`,
        session: `${path}/session`,
      });
      const compiled = profiles.compile(surface.surface, links, openApiDocument);
      this.#surfaces.set(surface.surface, Object.freeze({ document: compiled }));
    }
  }

  public async effective(ctx: HttpContext): Promise<CompiledUiSurfaceV1> {
    return (await this.resolveEffective(ctx)).document;
  }

  public async openApi(ctx: HttpContext): Promise<OpenApiSchema> {
    const effective = await this.resolveEffective(ctx);
    return projectOpenApiByOperationIds(effective.openApi, operationIdsOf(effective.document));
  }

  public async session(ctx: HttpContext): Promise<UiSurfaceSessionV1> {
    const effective = await this.resolveEffective(ctx);
    const user = safeSessionUser(await effective.options.session(ctx));
    return Object.freeze({
      apiVersion: UI_SURFACE_SESSION_V1_API_VERSION,
      kind: UI_SURFACE_SESSION_V1_KIND,
      metadata: {
        surface: effective.document.metadata.surface,
        revision: effective.document.metadata.revision,
      },
      app: this.options.app,
      currentUser: user,
    });
  }

  private async resolveEffective(ctx: HttpContext): Promise<EffectiveSurface> {
    const surface = String(ctx.params["surface"] ?? "").trim();
    const registration = this.options.surfaces.find((item) => item.surface === surface);
    const staticSurface = this.#surfaces.get(surface);
    // Surface enumeration is deliberately checked before invoking auth.
    if (surface.length === 0 || registration === undefined || staticSurface === undefined) {
      throw new NotFoundError("UI surface not found");
    }

    if (!await registration.authorize(ctx)) {
      throw new ForbiddenError();
    }
    const decision = await registration.policy(ctx, policyInputOf(staticSurface.document));
    return {
      options: registration,
      document: effectiveDocument(staticSurface.document, decision),
      openApi: this.openApiDocument,
    };
  }
}

@Controller("ui")
export class UiSurfaceHttpController {
  public constructor(private readonly documents: UiSurfaceDocumentProvider) {}

  @Get(":surface/openapi")
  async openapi(ctx: HttpContext): Promise<Response> {
    const document = await this.documents.openApi(ctx);
    return versionedJson(ctx, document, uiDocumentRevision(document));
  }

  @Get(":surface/session")
  async session(ctx: HttpContext): Promise<Response> {
    const document = await this.documents.session(ctx);
    return jsonResponse(document, {
      "cache-control": "private, no-store",
      vary: "Authorization",
    });
  }

  @Get(":surface")
  async surface(ctx: HttpContext): Promise<Response> {
    const document = await this.documents.effective(ctx);
    return versionedJson(ctx, document, document.metadata.revision);
  }
}

function validateSurfaceRegistration(
  options: RunAppUiSurfaceOptions,
  seen: Set<string>,
): void {
  const surface = options.surface.trim();
  if (surface.length === 0) {
    throw new TypeError("UI surface name must be a non-empty string.");
  }
  if (seen.has(surface)) {
    throw new TypeError(`UI surface ${surface} is registered more than once.`);
  }
  seen.add(surface);
  if (typeof options.authorize !== "function") {
    throw new TypeError(`UI surface ${surface} must declare authorize.`);
  }
  if (typeof options.policy !== "function") {
    throw new TypeError(`UI surface ${surface} must declare a policy projector.`);
  }
  if (typeof options.session !== "function") {
    throw new TypeError(`UI surface ${surface} must declare a safe session mapper.`);
  }
}

function policyInputOf(document: CompiledUiSurfaceV1): UiSurfacePolicyInput {
  return Object.freeze({
    surface: document.metadata.surface,
    resources: Object.freeze(document.spec.resources.map((resource) => Object.freeze({
      id: resource.id,
      operations: Object.freeze(Object.keys(resource.operations) as UiSurfaceOperationRole[]),
      actions: Object.freeze(resource.actions.map((action) => action.id)),
    }))),
    pages: Object.freeze((document.spec.customPages ?? []).map((page) => Object.freeze({
      id: page.id,
      operations: Object.freeze(pageOperationSlots(page)),
    }))),
  });
}

function effectiveDocument(
  source: CompiledUiSurfaceV1,
  policy: UiSurfacePolicyDecision,
): CompiledUiSurfaceV1 {
  if (typeof policy !== "object" || policy === null || !Array.isArray(policy.resources)) {
    throw new TypeError(`UI surface ${source.metadata.surface} policy returned an invalid decision.`);
  }
  const decisions = new Map<string, UiSurfaceResourceDecision>();
  for (const decision of policy.resources) {
    if (decisions.has(decision.resource)) {
      throw new TypeError(`UI policy returned duplicate resource decision ${decision.resource}.`);
    }
    decisions.set(decision.resource, decision);
  }

  const resources = source.spec.resources.flatMap((resource) => {
    const decision = decisions.get(resource.id);
    return decision?.visible === true ? [projectResource(resource, decision)] : [];
  });
  const pageDecisions = new Map<string, UiSurfacePageDecision>();
  for (const decision of policy.pages ?? []) {
    if (pageDecisions.has(decision.page)) {
      throw new TypeError(`UI policy returned duplicate page decision ${decision.page}.`);
    }
    pageDecisions.set(decision.page, decision);
  }
  const customPages = (source.spec.customPages ?? []).flatMap((page) => {
    const decision = pageDecisions.get(page.id);
    if (decision?.visible !== true) {
      return [];
    }
    const projected = projectCustomPage(page, decision);
    return projected === undefined ? [] : [projected];
  });
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const pageIds = new Set(customPages.map((page) => page.id));
  const navigation = source.spec.navigation.filter((item) =>
    (item.resource === undefined || resourceIds.has(item.resource))
      && (item.page === undefined || pageIds.has(item.page)));
  const semanticDocument = {
    apiVersion: source.apiVersion,
    kind: source.kind,
    metadata: { surface: source.metadata.surface },
    links: source.links,
    spec: {
      navigation,
      resources,
      ...(customPages.length > 0 ? { customPages } : {}),
      requiredRendererCapabilities: projectedRendererCapabilities(source, customPages),
      ...(source.spec.extensions !== undefined ? { extensions: source.spec.extensions } : {}),
    },
    ...(source.diagnostics !== undefined ? { diagnostics: source.diagnostics } : {}),
  };
  const revision = uiDocumentRevision({
    document: semanticDocument,
    sourceRevision: source.metadata.revision,
  });
  return normalizeUiJsonObject({
    ...semanticDocument,
    metadata: { surface: source.metadata.surface, revision },
  }, "effectiveUiSurface") as unknown as CompiledUiSurfaceV1;
}

function pageOperationSlots(page: CompiledUiCustomPageV1): string[] {
  switch (page.kind) {
    case "feature": return [];
    case "settings": return ["read", ...(page.operations.update === undefined ? [] : ["update"])];
    case "document": return ["load"];
    case "dashboard": return page.blocks.map((block) => `blocks.${block.id}`);
    default: return assertNeverCompiledCustomPage(page);
  }
}

function projectCustomPage(
  page: CompiledUiCustomPageV1,
  decision: UiSurfacePageDecision,
): CompiledUiCustomPageV1 | undefined {
  switch (page.kind) {
    case "feature":
      return page;
    case "settings":
      if (decision.operations?.["read"] !== true) {
        return undefined;
      }
      const canUpdate = page.operations.update !== undefined && decision.operations?.["update"] === true;
      return Object.freeze({
        id: page.id,
        title: page.title,
        route: page.route,
        kind: page.kind,
        operations: {
          read: page.operations.read,
          ...(canUpdate ? { update: page.operations.update } : {}),
        },
        ...(canUpdate && page.form !== undefined ? { form: page.form } : {}),
      });
    case "document":
      return decision.operations?.["load"] === true ? page : undefined;
    case "dashboard": {
      const blocks = page.blocks.filter((block) => decision.operations?.[`blocks.${block.id}`] === true);
      return blocks.length === 0 ? undefined : Object.freeze({ ...page, blocks: Object.freeze(blocks) });
    }
    default:
      return assertNeverCompiledCustomPage(page);
  }
}

function projectedRendererCapabilities(
  source: CompiledUiSurfaceV1,
  visiblePages: readonly CompiledUiCustomPageV1[],
): readonly string[] {
  // The wire contract does not retain provenance for arbitrary explicit/field
  // capabilities, so keep them intact. Feature renderer ids are compiler-owned
  // capabilities and can be projected exactly from source versus visible pages.
  const sourceFeatureRenderers = new Set(
    (source.spec.customPages ?? [])
      .filter((page) => page.kind === "feature")
      .map((page) => page.renderer),
  );
  const capabilities = new Set(
    source.spec.requiredRendererCapabilities.filter((capability) =>
      !sourceFeatureRenderers.has(capability)),
  );
  for (const page of visiblePages) {
    if (page.kind === "feature") {
      capabilities.add(page.renderer);
    }
  }
  return [...capabilities].sort();
}

function assertNeverCompiledCustomPage(value: never): never {
  throw new TypeError(`Unsupported compiled UI custom page: ${String(value)}`);
}

function projectResource(
  source: CompiledUiResourceV1,
  decision: UiSurfaceResourceDecision,
): CompiledUiResourceV1 {
  const operations = Object.fromEntries(
    Object.entries(source.operations).filter(([role]) => decision.operations?.[role as UiSurfaceOperationRole] === true),
  ) as CompiledUiResourceOperationsV1;
  const allowedActions = new Set(decision.actions ?? []);
  const actions = source.actions.filter((action) => allowedActions.has(action.id));
  return Object.freeze({
    id: source.id,
    title: source.title,
    ...(source.singularTitle !== undefined ? { singularTitle: source.singularTitle } : {}),
    ...(source.keyField !== undefined ? { keyField: source.keyField } : {}),
    route: source.route,
    operations,
    ...(operations.list !== undefined && source.list !== undefined ? { list: source.list } : {}),
    ...(operations.read !== undefined && source.detail !== undefined ? { detail: source.detail } : {}),
    ...(source.forms !== undefined && (operations.create !== undefined || operations.update !== undefined)
      ? {
          forms: {
            ...(operations.create !== undefined && source.forms.create !== undefined
              ? { create: source.forms.create }
              : {}),
            ...(operations.update !== undefined && source.forms.edit !== undefined
              ? { edit: source.forms.edit }
              : {}),
          },
        }
      : {}),
    actions,
    ...(source.extensions !== undefined ? { extensions: source.extensions } : {}),
  });
}

function operationIdsOf(document: CompiledUiSurfaceV1): Set<string> {
  const operationIds = new Set<string>();
  for (const resource of document.spec.resources) {
    for (const operation of Object.values(resource.operations)) {
      if (operation !== undefined) {
        operationIds.add(operation.operationId);
      }
    }
    for (const action of resource.actions) {
      operationIds.add(action.operation.operationId);
    }
  }
  for (const page of document.spec.customPages ?? []) {
    switch (page.kind) {
      case "feature":
        break;
      case "settings":
        operationIds.add(page.operations.read.operationId);
        if (page.operations.update !== undefined) {
          operationIds.add(page.operations.update.operationId);
        }
        break;
      case "document":
        operationIds.add(page.operation.operationId);
        break;
      case "dashboard":
        for (const block of page.blocks) {
          operationIds.add(block.operation.operationId);
        }
        break;
      default:
        assertNeverCompiledCustomPage(page);
    }
  }
  return operationIds;
}

function safeSessionUser(value: UiSurfaceSessionUser): UiSurfaceSessionUser {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("UI surface session mapper must return a user object.");
  }
  const id = requiredSessionText(value.id, "id");
  const kind = requiredSessionText(value.kind, "kind");
  const displayName = requiredSessionText(value.displayName, "displayName");
  // Reconstructing the object prevents accidental claim/role leakage.
  return Object.freeze({ id, kind, displayName });
}

function requiredSessionText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`UI surface session user ${field} must be a non-empty string.`);
  }
  return value;
}

function uiSurfacePath(apiBasePath: string, surface: string): string {
  const base = apiBasePath === "/" ? "" : apiBasePath.replace(/\/+$/, "");
  return `${base}/ui/${encodeURIComponent(surface)}`;
}

function versionedJson(ctx: HttpContext, document: unknown, revision: string): Response {
  const etag = `"${revision}"`;
  const headers = {
    "cache-control": "private, no-cache",
    etag,
    vary: "Authorization",
  };
  if (ctx.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return jsonResponse(document, headers);
}

function jsonResponse(document: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(document), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}
