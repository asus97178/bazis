import type { Class } from "../../di";
import { Environment } from "../../kernel";
import {
  renderOpenApiHtml,
  serveOpenApiDocs,
  type OpenApiDocsOptions,
  type PreparedOpenApiDocs,
} from "../../../library/openapi";
import { buildHttpOpenApiDocument } from "./openApiDocument";
import type { ApiVersioningOptions } from "../options";

interface PrepareOpenApiDocsInput {
  readonly option?: OpenApiDocsOptions | boolean;
  readonly controllers: readonly Class<object>[];
  readonly globalPrefix?: string;
  readonly versioning?: ApiVersioningOptions;
  readonly environment?: Environment;
}

const DEFAULT_UI_PATH = "/docs";
const DEFAULT_TITLE = "Bazis API";
const DEFAULT_VERSION = "1.0.0";

export { serveOpenApiDocs };

export function prepareOpenApiDocs(input: PrepareOpenApiDocsInput): PreparedOpenApiDocs | undefined {
  if (!isEnabled(input.option, input.environment)) {
    return undefined;
  }
  const options = normalizeOptions(input.option);
  const uiPath = normalizeAbsolutePath(options.path ?? DEFAULT_UI_PATH);
  const specPath = normalizeAbsolutePath(options.specPath ?? joinDocsPath(uiPath, "openapi.json"));
  const title = options.title ?? DEFAULT_TITLE;
  const version = options.version ?? DEFAULT_VERSION;
  const document = buildHttpOpenApiDocument({
    controllers: input.controllers,
    globalPrefix: input.globalPrefix,
    versioning: input.versioning,
    title,
    version,
  });
  const json = JSON.stringify(document, null, 2);
  return {
    uiPath,
    specPath,
    document,
    json,
    html: renderOpenApiHtml(title, specPath),
  };
}

function isEnabled(option: OpenApiDocsOptions | boolean | undefined, environment: Environment | undefined): boolean {
  if (typeof option === "boolean") {
    return option;
  }
  if (option !== undefined) {
    return option.enabled ?? true;
  }
  return environment?.debug ?? false;
}

function normalizeOptions(option: OpenApiDocsOptions | boolean | undefined): OpenApiDocsOptions {
  return typeof option === "object" && option !== null ? option : {};
}

function normalizeAbsolutePath(path: string): string {
  const trimmed = path.trim();
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = prefixed.split("/").filter((part) => part.length > 0);
  return `/${parts.join("/")}`;
}

function joinDocsPath(base: string, child: string): string {
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}
