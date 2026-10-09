import path from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import ts from "typescript";
import {
  createOpenApiCodegenAnalyzer,
  type OpenApiCodegenOperationSpec,
  type OpenApiCodegenSchema,
} from "../../library/openapi/codegen";
import { generateAgentMetadataCatalog, type AgentCodegenSource } from "./agent-codegen";
import {
  analyzeRequestModelHydration,
  type RequestModelHydration,
} from "./request-model-codegen";
import { collectTargetReachability, normalizeConfiguredPath, readCodegenConfig } from "./di-generate-target";
import { analyzeOrmPredicates } from "./orm-predicate-codegen";
import { hashSources } from "../generatedFingerprint";
const FRAMEWORK_DIR = realpathSync(path.resolve(import.meta.dir, "../.."));
/**
 * Project-relative framework source when codegen runs in the framework's own
 * checkout (`src/bazis` there); null when the framework is an installed
 * dependency (node_modules/bazis, vendor/bazis) and not part of the project sources.
 */
const FRAMEWORK_SOURCE = ((): string | null => {
  const relative = path.relative(realpathSync(process.cwd()), FRAMEWORK_DIR).replaceAll("\\", "/");
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return /(^|\/)(node_modules|vendor)(\/|$)/.test(relative) ? null : relative;
  }
  // A checkout linked into the project (src/bazis -> framework) is still its source.
  try { return realpathSync("src/bazis") === FRAMEWORK_DIR ? "src/bazis" : null; } catch { return null; }
})();
const FRAMEWORK_ROOT = FRAMEWORK_SOURCE ?? "src/bazis";
const CORE_AGENT_CATALOG_FILE = `${FRAMEWORK_ROOT}/core/agent/generated/catalog.ts`;
const CORE_AGENT_GENERATED_DIR = `${FRAMEWORK_ROOT}/core/agent/generated`;
const isFrameworkSourcePath = (file: string): boolean => FRAMEWORK_SOURCE !== null && file.startsWith(`${FRAMEWORK_SOURCE}/`);
const APP_GENERATED_DIR = "src/generated/bazis";
let activeGeneratedDir = APP_GENERATED_DIR;
const plannedWrites = new Map<string, string>();
const plannedRemovals = new Set<string>();

// Test-only fault injection for the generator's private disk transaction. It
// deliberately lives at the IO boundary so production analysis/rendering has
// no alternate path or exported surface.
let renameCount = 0;
async function renameGeneratedFile(from: string, to: string): Promise<void> {
  renameCount += 1;
  const failAt = process.env.BAZIS_CODEGEN_TEST_FAIL_RENAME_AT;
  if (failAt !== undefined && Number(failAt) === renameCount) {
    throw new Error(`BAZIS_CODEGEN_TEST_RENAME_FAILURE:${renameCount}`);
  }
  await rename(from, to);
}

function stageWrite(filePath: string, content: string): void {
  plannedWrites.set(filePath, content);
}

function stageRemove(filePath: string): void {
  plannedRemovals.add(filePath);
}

async function commitPlannedWrites(): Promise<void> {
  const transaction = `.bazis-codegen-stage-${crypto.randomUUID()}`;
  const staged: { readonly final: string; readonly staged: string; readonly backup: string; hadFinal: boolean }[] = [];
  const removed: { readonly final: string; readonly backup: string }[] = [];
  renameCount = 0;
  try {
    for (const [final, content] of plannedWrites) {
      const stagedFile = `${transaction}/${final}`;
      await mkdir(path.dirname(stagedFile), { recursive: true });
      await Bun.write(stagedFile, content);
      staged.push({ final, staged: stagedFile, backup: `${transaction}/backup/${final}`, hadFinal: await pathExists(final) });
    }
    for (const final of plannedRemovals) {
      if (!await pathExists(final)) continue;
      const backup = `${transaction}/removed/${final}`;
      await mkdir(path.dirname(backup), { recursive: true });
      await renameGeneratedFile(final, backup);
      removed.push({ final, backup });
    }
    for (const entry of staged) {
      await mkdir(path.dirname(entry.final), { recursive: true });
      if (entry.hadFinal) {
        await mkdir(path.dirname(entry.backup), { recursive: true });
        await renameGeneratedFile(entry.final, entry.backup);
      }
      await renameGeneratedFile(entry.staged, entry.final);
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      if (await pathExists(entry.backup)) {
        if (await pathExists(entry.final)) await rm(entry.final, { recursive: true, force: true });
        await mkdir(path.dirname(entry.final), { recursive: true });
        await renameGeneratedFile(entry.backup, entry.final);
      } else if (!entry.hadFinal && await pathExists(entry.final)) {
        await rm(entry.final, { recursive: true, force: true });
      }
    }
    for (const entry of [...removed].reverse()) {
      if (!await pathExists(entry.backup)) continue;
      if (await pathExists(entry.final)) await rm(entry.final, { recursive: true, force: true });
      await mkdir(path.dirname(entry.final), { recursive: true });
      await renameGeneratedFile(entry.backup, entry.final);
    }
    throw error;
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as { readonly code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function planStaleGeneratedTargetRemoval(configuredNames: readonly string[]): Promise<void> {
  const targetsDirectory = `${APP_GENERATED_DIR}/targets`;
  if (!await pathExists(targetsDirectory)) return;
  const configured = new Set(configuredNames);
  for (const entry of await readdir(targetsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) {
      throw new Error(`BAZIS_CODEGEN_GENERATED_TARGET_INVALID: ${entry.name}`);
    }
    if (!configured.has(entry.name)) stageRemove(`${targetsDirectory}/${entry.name}`);
  }
}

function readRequestedTarget(): string | undefined {
  const args = Bun.argv.slice(2);
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--target") {
    throw new Error("BAZIS_CODEGEN_CONFIG_INVALID: expected --target <name|all>");
  }
  const target = args[1];
  if (target && (target === "all" || /^[a-z][a-z0-9-]*$/.test(target))) return target;
  throw new Error(`BAZIS_CODEGEN_TARGET_UNKNOWN: ${target ?? ""}`);
}

// Framework internals: their classes are excluded from the auto-deps map (they
// wire their own services explicitly). Auto-deps magic targets user code only.
const FRAMEWORK_INTERNAL_PREFIXES = FRAMEWORK_SOURCE === null ? [] : [
  "core/di/", "core/kernel/", "core/http/", "core/grpc/", "core/http-client/", "core/background/",
  "core/agent/", "core/websocket/", "core/cache/", "library/validation/", "library/boundary/",
  "library/orm/", "library/jwt/", "library/jsonapi/", "library/openapi/", "core/orm/", "core/infra/",
  "core/app/", "library/http-client/",
].map((prefix) => `${FRAMEWORK_SOURCE}/${prefix}`);

// A declaration is an identity; short names are local to their source/module.
interface CollectedDependency { readonly name: string; readonly target?: ts.ClassDeclaration; readonly lazy?: boolean; readonly optional?: boolean; }
interface ConstructorDependencies {
  readonly deps: CollectedDependency[];
  readonly unsupportedInheritedParameter?: string;
  /** An own constructor parameter whose type cannot name a DI dependency (`string`, `number`, an inline type). */
  readonly unsupportedParameter?: { readonly index: number; readonly name: string; readonly type: string };
}
let classDeps = new Map<ts.ClassDeclaration, readonly CollectedDependency[]>();
let inferredDiClasses = new Set<ts.ClassDeclaration>();
let explicitlyBoundDiClasses = new Set<ts.ClassDeclaration>();
// Known runtime token names: createToken descriptions + class names usable as class-tokens.
let tokenDescriptions = new Set<string>();
// defineConfig<T>("prefix") declarations by the name of T: a ConfigView<T>
// constructor parameter binds to the token of that declaration.
let configPrefixesByType = new Map<string, Set<string>>();
let knownClassNames = new Set<string>();
let warnings: string[] = [];
let fatalErrors: string[] = [];

// HTTP binding conventions inferred from controller method signatures.
interface HttpBindingSpec {
  source: "route" | "query" | "body" | "context" | "request" | "response" | "list";
  name?: string;
  type?: "int" | "number" | "bool" | "string";
  optional?: boolean;
  model?: string;
  array?: boolean;
}
let httpBindings: Record<string, Record<string, HttpBindingSpec[]>> = {};
interface GrpcRequestBinding {
  readonly method: string;
  readonly model: ts.ClassDeclaration;
  readonly requestStream: boolean;
}
let grpcBindings = new Map<ts.ClassDeclaration, GrpcRequestBinding[]>();
let httpControllerFiles: Record<string, string> = {};
let openApiSchemas: Record<string, OpenApiCodegenSchema> = {};
let openApiOperations: Record<string, Record<string, OpenApiCodegenOperationSpec>> = {};
interface OpenApiSchemaModelImport {
  readonly declaration: ts.ClassDeclaration;
  readonly schemaName: string;
}
let uiProfileResponseModels = new Map<ts.ClassDeclaration, string>();
let openApiSchemaModels = new Map<ts.ClassDeclaration, string>();
let requestModelClassNames = new Set<string>();
// Names of classes extending `ListRequest` — bound as universal list-query
// params (source "list"), not as request bodies. Collected in a pre-pass so the
// decision is independent of file scan order.
let listRequestClassNames = new Set<string>();
// Declaration file of every scanned class (by name). Used to auto-import body
// models into the generated registry. A name seen in two files is ambiguous.
let classFilesByName = new Map<string, string>();
let classDeclarationsByName = new Map<string, ts.ClassDeclaration>();
let ambiguousClassNames = new Set<string>();
// Exact roots that do not need convention name resolution: @RequestModel()
// classes used by generated transport schemas.
let explicitRequestModelRoots = new Set<ts.ClassDeclaration>();
let agentCodegenSources: AgentCodegenSource[] = [];

const ROUTE_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "All"]);
const CODEGEN_CHANNEL_DECORATORS = new Set(["Controller", "GrpcController", "Agent", "Tool", "Prompt", "RequestModel", "UiProfile"]);
const PRIMITIVE_QUERY_TYPES: Record<string, HttpBindingSpec["type"]> = {
  string: "string",
  number: "number",
  boolean: "bool",
};
const CONTEXT_TYPES: Record<string, HttpBindingSpec["source"]> = {
  HttpContext: "context",
  Request: "request",
  ResponseBuilder: "response",
};
let program: ts.Program;
let programFiles = new Map<string, ts.SourceFile>();
// Framework sources outside the scanned project (node_modules/bazis, vendor/bazis).
// Only their class and token names are read, so app constructor dependencies on
// framework classes are not discarded as unknown; their own wiring ships with them.
let installedFrameworkSources: ts.SourceFile[] = [];
let sourceFilePathSet = new Set<string>();
let checker: ts.TypeChecker;
let sourceEntries: { filePath: string; source: ts.SourceFile }[] = [];
let openApiCodegen: ReturnType<typeof createOpenApiCodegenAnalyzer>;

// TypeScript / platform types that appear in constructors but are never DI tokens.
const BUILTIN_DEPENDENCY_NAMES = new Set([
  "Array",
  "Map",
  "Partial",
  "Promise",
  "Readonly",
  "ReadonlyArray",
  "ReadonlyMap",
  "Record",
  "Required",
  "Set",
]);

function isScannableFile(filePath: string): boolean {
  if (filePath.startsWith("../") || path.isAbsolute(filePath)) return false;
  if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts") || /\.(test|spec)\.ts$/.test(filePath)) return false;
  if (
    filePath === CORE_AGENT_CATALOG_FILE ||
    filePath.startsWith(`${APP_GENERATED_DIR}/`)
  ) {
    return false;
  }
  return !/(^|\/)(test|tests|__tests__|fixture|fixtures|__fixtures__|generated|node_modules|vendor|dist|build|bin|coverage|examples)(\/|$)/.test(filePath) && !filePath.startsWith("admin-ui/");
}

function isInstalledFrameworkSource(source: ts.SourceFile): boolean {
  if (source.isDeclarationFile) return false;
  let file: string;
  try { file = realpathSync(source.fileName); } catch { return false; }
  return file.startsWith(`${FRAMEWORK_DIR}${path.sep}`) && !/[\\/](test|tests|__tests__)[\\/]|\.(test|spec)\.ts$/.test(file);
}

function createTypeScriptProgram(): ts.Program {
  const configPath = ts.findConfigFile(".", ts.sys.fileExists, "tsconfig.json");
  if (configPath === undefined) {
    return ts.createProgram([], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      noEmit: true,
    });
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
  });
}

function duplicateOpenApiSchemaName(input: { readonly name: string; readonly filePath: string }): string {
  const normalized = input.filePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const appIndex = parts.findIndex((part, index) => part === "modules" && parts[index - 1] === "app");
  if (appIndex >= 0 && parts[appIndex + 1] !== undefined) {
    return `App${toPascalIdentifier(parts[appIndex + 1] as string)}${input.name}`;
  }
  const context = parts.slice(Math.max(0, parts.length - 3), Math.max(0, parts.length - 1)).map(toPascalIdentifier).join("");
  return context.length === 0 ? input.name : `${context}${input.name}`;
}

function toPascalIdentifier(value: string): string {
  return value
    .replace(/\.[^.]+$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

await runConfiguredTargets();

async function runConfiguredTargets(): Promise<void> {
  const totalStartedAt = performance.now();
  const configStartedAt = performance.now();
  const config = await readCodegenConfig();
  await planStaleGeneratedTargetRemoval(Object.keys(config.targets));
  // Test sources remain excluded from the broad candidate scan. A test-only
  // target can still opt a single fixture in explicitly through its declared
  // entrypoint/application part, and receives the same isolated descriptor as
  // every other target.
  const explicitTargetSources = new Set<string>();
  for (const target of Object.values(config.targets)) {
    for (const source of [...target.entrypoints, ...(target.applicationParts ?? [])]) {
      explicitTargetSources.add(normalizeConfiguredPath(source));
    }
  }
  const configMs = performance.now() - configStartedAt;
  const programStartedAt = performance.now();
  program = createTypeScriptProgram();
  programFiles = new Map();
  installedFrameworkSources = [];
  // In the framework's own checkout its sources are scanned project files.
  const frameworkInstalled = FRAMEWORK_SOURCE === null;
  for (const source of program.getSourceFiles()) {
    const filePath = normalizeProjectPath(source.fileName);
    if (isScannableFile(filePath) || explicitTargetSources.has(filePath)) {
      programFiles.set(filePath, source);
    } else if (frameworkInstalled && isInstalledFrameworkSource(source)) {
      installedFrameworkSources.push(source);
    }
  }
  checker = program.getTypeChecker();
  const programMs = performance.now() - programStartedAt;
  const discoveryStartedAt = performance.now();
  const requested = readRequestedTarget() ?? config.defaultTarget;
  if (requested !== "all" && !Object.hasOwn(config.targets, requested)) {
    throw new Error(`BAZIS_CODEGEN_TARGET_UNKNOWN: ${requested}`);
  }
  const names = requested === "all"
    ? Object.keys(config.targets).sort((left, right) => left.localeCompare(right))
    : [requested];
  const reachableByTarget = new Map<string, Set<string>>();
  for (const name of Object.keys(config.targets)) {
    const target = config.targets[name] as { entrypoints: readonly string[]; applicationParts?: readonly string[] };
    const roots = [...target.entrypoints, ...(target.applicationParts ?? [])].map(normalizeConfiguredPath);
    for (const root of roots) {
      if (!programFiles.has(root)) throw new Error(`BAZIS_CODEGEN_ENTRY_NOT_IN_PROGRAM: ${name}:${root}`);
    }
    reachableByTarget.set(name, collectTargetReachability(program, programFiles, roots));
  }
  const owners = new Map<string, string[]>();
  for (const [name, files] of reachableByTarget) for (const file of files) {
    if (isFrameworkSourcePath(file)) continue;
    const current = owners.get(file) ?? [];
    current.push(name);
    owners.set(file, current);
  }
  // Shared source is legitimate: every target gets its own immutable analysis
  // slice and renderer state. Only a collision *inside* that slice is fatal.
  const candidateIndex = createSourceCandidateIndex(programFiles);
  const boundaryDiagnostics: string[] = [];
  for (const [file] of programFiles) {
    if (isFrameworkSourcePath(file)) continue;
    if (!owners.has(file) && candidateIndex.get(file)) boundaryDiagnostics.push(`BAZIS_CODEGEN_SOURCE_UNASSIGNED: ${file}`);
  }
  for (const [name, reachable] of reachableByTarget) {
    for (const file of reachable) {
      const source = programFiles.get(file);
      if (source !== undefined && !isFrameworkSourcePath(file)) collectDynamicImportDiagnostics(source, name, boundaryDiagnostics);
    }
  }
  if (boundaryDiagnostics.length > 0) throw new Error(boundaryDiagnostics.sort((left, right) => left.localeCompare(right)).join("\n"));
  const discoveryMs = performance.now() - discoveryStartedAt;
  const targetStartedAt = performance.now();
  let analysisMs = 0;
  let renderMs = 0;
  let eligible = 0;
  let candidates = 0;
  for (const name of names) {
    const metrics = await generateTarget(name, reachableByTarget.get(name) as Set<string>, name === config.defaultTarget);
    analysisMs += metrics.analysisMs;
    renderMs += metrics.renderMs;
    eligible += metrics.eligible;
    candidates += metrics.candidates;
  }
  const targetMs = performance.now() - targetStartedAt;
  const writeStartedAt = performance.now();
  await commitPlannedWrites();
  const writeMs = performance.now() - writeStartedAt;
  console.log(`[di:generate] programFactories=1 programSources=${programFiles.size} targets=${names.join(",")} configMs=${configMs.toFixed(1)} programMs=${programMs.toFixed(1)} discoveryMs=${discoveryMs.toFixed(1)} analysisMs=${analysisMs.toFixed(1)} targetMs=${targetMs.toFixed(1)} renderMs=${renderMs.toFixed(1)} writeMs=${writeMs.toFixed(1)} totalMs=${(performance.now() - totalStartedAt).toFixed(1)} eligible=${eligible} candidates=${candidates} outputs=${plannedWrites.size}`);
}

function createSourceCandidateIndex(files: ReadonlyMap<string, ts.SourceFile>): ReadonlyMap<string, boolean> {
  for (const [file, source] of files) {
    if (!FRAMEWORK_INTERNAL_PREFIXES.some((prefix) => file.startsWith(prefix))) collectDiClassRegistrations(source);
  }
  return new Map([...files].map(([file, source]) => [file, sourceHasCodegenCandidate(source)]));
}

/** Same target-owned marker vocabulary used by target collection/rendering. */
function sourceHasCodegenCandidate(source: ts.SourceFile): boolean {
  let candidate = false;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const decorators = ts.getDecorators(node) ?? [];
      const constructorDeps = readConstructorTypeNames(node);
      // Shared all-channel boundary index: any class that feeds DI/HTTP,
      // request/list, OpenAPI/UI, Agent/Tool/Prompt analysis must
      // be owned by exactly one configured target before rendering begins.
      if (
        decorators.some((decorator) => {
          const name = decoratorCall(decorator)?.name;
          return name !== undefined && (CODEGEN_CHANNEL_DECORATORS.has(name)
          || name === "Module");
        })
        || node.heritageClauses?.some((clause) => clause.types.some((type) => type.expression.getText(source) === "ListRequest"))
        // Constructor metadata feeds the DI channel even when a class has no
        // decorator of its own (providers may be registered by a module).
        || ((constructorDeps.deps.length > 0
          && (dependencyClassExportName(node) !== undefined || inferredDiClasses.has(node)))
          || (inferredDiClasses.has(node) && constructorDeps.unsupportedInheritedParameter !== undefined))
      ) {
        candidate = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return candidate;
}

function collectDynamicImportDiagnostics(source: ts.SourceFile, target: string, diagnostics: string[]): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && (node.arguments[0] === undefined || !ts.isStringLiteralLike(node.arguments[0]))) {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      diagnostics.push(`BAZIS_CODEGEN_DYNAMIC_EDGE_UNRESOLVED: ${target}:${normalizeProjectPath(source.fileName)}:${location.line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function resetTargetAnalysis(files: Set<string>, generatedDir: string): void {
  activeGeneratedDir = generatedDir;
  classDeps = new Map(); inferredDiClasses = new Set(); explicitlyBoundDiClasses = new Set();
  tokenDescriptions = new Set(); configPrefixesByType = new Map(); knownClassNames = new Set(); warnings = []; fatalErrors = [];
  httpBindings = {}; httpControllerFiles = {}; openApiSchemas = {}; openApiOperations = {};
  grpcBindings = new Map();
  uiProfileResponseModels = new Map(); openApiSchemaModels = new Map(); requestModelClassNames = new Set(); listRequestClassNames = new Set();
  classFilesByName = new Map(); classDeclarationsByName = new Map(); ambiguousClassNames = new Set(); explicitRequestModelRoots = new Set(); agentCodegenSources = [];
  sourceEntries = [...files].sort((a, b) => a.localeCompare(b)).map((filePath) => ({ filePath, source: programFiles.get(filePath) as ts.SourceFile }));
  sourceFilePathSet = new Set(sourceEntries.map((entry) => entry.filePath));
  openApiCodegen = createOpenApiCodegenAnalyzer({ checker, sourceFiles: sourceEntries.map((entry) => entry.source), schemaNameForDuplicate: duplicateOpenApiSchemaName });
}

async function generateTarget(name: string, reachable: Set<string>, production: boolean): Promise<{ analysisMs: number; renderMs: number; eligible: number; candidates: number }> {
  const startedAt = performance.now();
  const generatedDir = production ? APP_GENERATED_DIR : `${APP_GENERATED_DIR}/targets/${name}`;
  resetTargetAnalysis(reachable, generatedDir);
  for (const { source } of sourceEntries) collectListRequestClasses(source);
  for (const { filePath, source } of sourceEntries) {
    if (!FRAMEWORK_INTERNAL_PREFIXES.some((prefix) => filePath.startsWith(prefix))) collectDiClassRegistrations(source);
  }
  const prepassMs = performance.now() - startedAt;
  for (const source of installedFrameworkSources) collectTokenDescriptions(source);
  for (const { filePath, source } of sourceEntries) {
    fatalErrors.push(...analyzeOrmPredicates(checker, source));
    collectTokenDescriptions(source);
    if (!FRAMEWORK_INTERNAL_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      collectClassDeps(source);
      collectGrpcBindings(source);
      agentCodegenSources.push({ filePath, sourceFile: source });
    }
    collectHttpBindings(source); collectOpenApiSchemas(source); collectUiProfileResponseModels(source);
  }
  resolveConfigViewDeps();
  validateDepsAgainstKnownTokens();
  const requestModelImports = resolveRequestModelImports();
  const requestModelHydration = resolveRequestModelHydration(requestModelImports);
  const listModelImports = resolveListModelImports();
  const agent = generateAgentMetadataCatalog(agentCodegenSources, {
    generatedDir, frameworkImports: "public", schemaNameForDeclaration: openApiCodegen.schemaNameForDeclaration,
  });
  const schemaModels = resolveOpenApiSchemaModelImports(agent.schemaModels, agent.schemaNames);
  classifyAgentWarnings(agent.warnings); failOnFatalErrors();
  const analysisMs = performance.now() - startedAt;
  const renderStartedAt = performance.now();
  const requestModels = renderRequestModels(requestModelImports, requestModelHydration);
  const listModels = renderListModels(listModelImports);
  const openApi = renderOpenApiMetadata(openApiSchemas, openApiOperations, "app", agent.schemaNames, schemaModels);
  stageWrite(`${generatedDir}/deps.ts`, renderTargetDeps());
  stageWrite(`${generatedDir}/bindings.ts`, renderTargetBindings());
  stageWrite(`${generatedDir}/httpRequestModels.ts`, requestModels);
  stageWrite(`${generatedDir}/httpListModels.ts`, listModels);
  stageWrite(`${generatedDir}/openapi.ts`, openApi);
  stageWrite(`${generatedDir}/agentCatalog.ts`, agent.output);
  stageWrite(`${generatedDir}/runtime.ts`, renderGeneratedRuntime(name));
  if (production) stageWrite(`${generatedDir}/fingerprint.ts`, renderSourceFingerprint());
  // The framework's own empty agent catalog (a fixture of agent.metadata.test)
  // is refreshed only when the framework source is part of this project.
  if (production) {
    if (FRAMEWORK_SOURCE !== null) {
      stageWrite(CORE_AGENT_CATALOG_FILE, generateAgentMetadataCatalog([], CORE_AGENT_GENERATED_DIR).output);
    }
  } else {
    stageWrite(`${generatedDir}/bootstrap.ts`, 'import { registerBazisGeneratedRuntime } from "./runtime";\n\nawait registerBazisGeneratedRuntime();\n');
  }
  for (const warning of warnings) console.warn(`[di:generate] WARNING: ${warning}`);
  console.log(`[di:generate] target=${name} sources=${sourceEntries.length} deps=${classDeps.size} controllers=${Object.keys(httpBindings).length} requestModels=${requestModelImports.length} listModels=${listModelImports.length} agents=${agent.agentCount} prepassMs=${prepassMs.toFixed(1)} analysisMs=${analysisMs.toFixed(1)} totalMs=${(performance.now() - startedAt).toFixed(1)}`);
  return {
    analysisMs,
    renderMs: performance.now() - renderStartedAt,
    eligible: sourceEntries.length,
    candidates: classDeps.size + Object.keys(httpBindings).length + requestModelImports.length + listModelImports.length + agent.agentCount,
  };
}

function classifyAgentWarnings(agentWarnings: readonly string[]): void {
  for (let index = 0; index < agentWarnings.length; index += 1) {
    const warning = agentWarnings[index] as string;
    if (warning.includes("ambiguous") || warning.includes("declared in more than one file")) {
      fatalErrors.push(warning);
    } else {
      warnings.push(warning);
    }
  }
}

function failOnFatalErrors(): void {
  if (fatalErrors.length === 0) {
    return;
  }
  for (let index = 0; index < fatalErrors.length; index += 1) {
    console.error(`[di:generate] ERROR: ${fatalErrors[index]}`);
  }
  throw new Error(`di:generate failed with ${fatalErrors.length} fatal codegen error(s).`);
}

function renderGeneratedRuntime(targetId: string): string {
  if (activeGeneratedDir !== APP_GENERATED_DIR) {
    return [
      "// This file is auto-generated by `bazis codegen`.",
      "// Do not edit manually.",
      "",
      'import { registerBazisGeneratedTargetDescriptor } from "bazis/core/generatedRuntime";',
      "",
      "let load: Promise<void> | undefined;",
      "",
      "export function registerBazisGeneratedRuntime(): Promise<void> {",
      "  load ??= loadTarget().catch((error) => { load = undefined; throw error; });",
      "  return load;",
      "}",
      "",
      "async function loadTarget(): Promise<void> {",
      "  const [deps, bindings, requests, lists, openApi, agentCatalog] = await Promise.all([import(\"./deps\"), import(\"./bindings\"), import(\"./httpRequestModels\"), import(\"./httpListModels\"), import(\"./openapi\"), import(\"./agentCatalog\")]);",
      `  await registerBazisGeneratedTargetDescriptor({ id: ${JSON.stringify(targetId)}, classDeps: deps.GENERATED_TARGET_CLASS_DEPS, bindings: bindings.GENERATED_TARGET_BINDINGS, providerAttachments: bindings.GENERATED_PROVIDER_ATTACHMENTS, requestModels: requests.GENERATED_REQUEST_MODELS, requestShapes: requests.GENERATED_REQUEST_MODEL_SHAPES, listModels: lists.GENERATED_LIST_MODELS, openApi: openApi.GENERATED_OPENAPI_METADATA, openApiSchemaModels: openApi.GENERATED_OPENAPI_SCHEMA_MODELS, agentMetadata: agentCatalog.GENERATED_AGENT_METADATA });`,
      "}",
      "",
    ].join("\n");
  }
  return [
    "// This file is auto-generated by `bazis codegen`.",
    "// Do not edit manually.",
    "",
    "let registered: Promise<void> | undefined;",
    "",
    "export async function registerBazisGeneratedRuntime(): Promise<void> {",
    "  registered ??= loadTarget().catch((error) => { registered = undefined; throw error; });",
    "  return registered;",
    "}",
    "",
    "async function loadTarget(): Promise<void> {",
    "  // Test-only owner-private hook: it is inert unless an isolated test installs it before loading this generated module.",
    '  (globalThis as { __bazisGeneratedRuntimeTestHook?: (target: string) => void }).__bazisGeneratedRuntimeTestHook?.("production");',
    '  const { registerBazisGeneratedTargetDescriptor, warnIfGeneratedSourcesChanged } = await import("bazis/core/generatedRuntime");',
    "  const [deps, bindings, requests, lists, openApi, agentCatalog] = await Promise.all([import(\"./deps\"), import(\"./bindings\"), import(\"./httpRequestModels\"), import(\"./httpListModels\"), import(\"./openapi\"), import(\"./agentCatalog\")]);",
    `  await registerBazisGeneratedTargetDescriptor({ id: ${JSON.stringify(targetId)}, classDeps: deps.GENERATED_TARGET_CLASS_DEPS, bindings: bindings.GENERATED_TARGET_BINDINGS, providerAttachments: bindings.GENERATED_PROVIDER_ATTACHMENTS, requestModels: requests.GENERATED_REQUEST_MODELS, requestShapes: requests.GENERATED_REQUEST_MODEL_SHAPES, listModels: lists.GENERATED_LIST_MODELS, openApi: openApi.GENERATED_OPENAPI_METADATA, openApiSchemaModels: openApi.GENERATED_OPENAPI_SCHEMA_MODELS, agentMetadata: agentCatalog.GENERATED_AGENT_METADATA });`,
    "  // Started from sources edited after codegen: say so instead of silently missing routes.",
    '  warnIfGeneratedSourcesChanged(import.meta.dir, (await import("./fingerprint")).GENERATED_SOURCE_FINGERPRINT);',
    "}",
    "",
  ].join("\n");
}

/** Sources of this target as codegen saw them; read back by the generated runtime. */
function renderSourceFingerprint(): string {
  const files = sourceEntries.map((entry) => entry.filePath).sort();
  const framework = JSON.parse(readFileSync(path.join(FRAMEWORK_DIR, "package.json"), "utf8")).version as string;
  const fingerprint = { root: path.relative(activeGeneratedDir, ".").replaceAll("\\", "/"), framework, files, hash: hashSources(".", files) };
  return [
    "// This file is auto-generated by `bazis codegen`.",
    "// Do not edit manually.",
    "",
    `export const GENERATED_SOURCE_FINGERPRINT = ${JSON.stringify(fingerprint, null, 2)} as const;`,
    "",
  ].join("\n");
}

/** Target-local descriptor renderer over the mature collector output. */
function renderTargetDeps(): string {
  const entries = [...classDeps.entries()].sort(([left], [right]) =>
    left.name!.text.localeCompare(right.name!.text)
    || left.getSourceFile().fileName.localeCompare(right.getSourceFile().fileName)
    || left.pos - right.pos);
  const references = new Map<ts.ClassDeclaration, string>();
  for (let index = 0; index < entries.length; index++) references.set(entries[index]![0], `TargetClass_${index}`);
  for (const [, dependencies] of entries) {
    for (const dependency of dependencies) {
      if (dependency.target && !references.has(dependency.target)) references.set(dependency.target, `DependencyClass_${references.size}`);
    }
  }
  const lines = ["// This file is auto-generated by `bazis codegen`.", "// Do not edit manually."];
  const helpers = ["lazyDependency", "optionalDependency"].filter((helper) => entries.some(([, deps]) =>
    deps.some((dep) => dep.target && (helper === "lazyDependency" ? dep.lazy : dep.optional))));
  if (helpers.length > 0) lines.push(`import { ${helpers.join(", ")} } from "bazis/core/di";`);
  for (const [declaration, reference] of references) {
    const name = dependencyClassExportName(declaration);
    if (!name) throw new Error(`BAZIS_DI_CLASS_UNIMPORTABLE: ${sourceLocation(declaration)}`);
    lines.push(`import { ${name} as ${reference} } from ${JSON.stringify(toModuleSpecifierFrom(activeGeneratedDir, normalizeProjectPath(declaration.getSourceFile().fileName)))};`);
  }
  lines.push("export const GENERATED_TARGET_CLASS_DEPS = Object.freeze([");
  for (const [declaration, dependencies] of entries) {
    const values = dependencies.map(dependency => {
      if (!dependency.target) return JSON.stringify(dependency.optional ? `optional:${dependency.name}` : dependency.name);
      const reference = references.get(dependency.target)!;
      return dependency.lazy ? `lazyDependency(${reference})` : dependency.optional ? `optionalDependency(${reference})` : reference;
    });
    lines.push(`  [${references.get(declaration)}, [${values.join(", ")}]] as const,`);
  }
  lines.push("]);" );
  return `${lines.join("\n")}\n`;
}

/** Export aliases and default exports still refer to the same class symbol. */
function dependencyClassExportName(declaration: ts.ClassDeclaration): string | undefined {
  const sourceSymbol = checker.getSymbolAtLocation(declaration.getSourceFile());
  const classSymbol = declaration.name && checker.getSymbolAtLocation(declaration.name);
  if (sourceSymbol && classSymbol) {
    for (const exported of checker.getExportsOfModule(sourceSymbol)) {
      // `export type { LocalClass }` exposes only a type: the generated runtime
      // must skip it and keep looking for an actual value alias/default export.
      if (exported.declarations?.every((entry) => ts.isExportSpecifier(entry)
        && (entry.isTypeOnly || (ts.isExportDeclaration(entry.parent.parent) && entry.parent.parent.isTypeOnly)))) continue;
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (target === classSymbol) return exported.name;
    }
  }
  return undefined;
}

/** Only executable, exported classes can supply an exact runtime constructor. */
function dependencyClass(node: ts.TypeNode): ts.ClassDeclaration | undefined {
  if (!ts.isTypeReferenceNode(node)) return undefined;
  let symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.find(ts.isClassDeclaration);
  return declaration && !declaration.getSourceFile().isDeclarationFile && dependencyClassExportName(declaration)
    ? declaration : undefined;
}

/** Target-local HTTP descriptor renderer over the mature binding collector output. */
function renderTargetBindings(): string {
  // Controller-scoped OpenAPI metadata must include controllers which have no
  // bindable parameters as well as ordinary binding-bearing controllers.
  const entries = [...new Set([...Object.keys(httpBindings), ...Object.keys(openApiOperations)])]
    .sort((a, b) => a.localeCompare(b));
  const lines = ["// This file is auto-generated by `bazis codegen`.", "// Do not edit manually."];
  for (let index = 0; index < entries.length; index += 1) {
    const name = entries[index] as string;
    const file = httpControllerFiles[name] ?? classFilesByName.get(name);
    if (file === undefined) throw new Error(`BAZIS_CODEGEN_CONTROLLER_SOURCE_MISSING: ${name}`);
    lines.push(`import { ${name} as TargetController_${index} } from ${JSON.stringify(toModuleSpecifierFrom(activeGeneratedDir, normalizeProjectPath(file)))};`);
  }
  lines.push("export const GENERATED_TARGET_BINDINGS = Object.freeze([");
  for (let index = 0; index < entries.length; index += 1) {
    const name = entries[index] as string;
    lines.push(`  [TargetController_${index}, ${JSON.stringify(httpBindings[name] ?? {})}] as const,`);
  }
  lines.push("]);" );
  lines.push(...renderGrpcBindings());
  return `${lines.join("\n")}\n`;
}

function renderGrpcBindings(): string[] {
  const entries = [...grpcBindings.entries()];
  const lines: string[] = [];
  const aliases = new Map<ts.ClassDeclaration, string>();
  if (entries.length > 0) lines.push('import { GRPC_REQUEST_BINDINGS } from "bazis/core/grpc";');
  for (const [controller, bindings] of entries) {
    for (const declaration of [controller, ...bindings.map((binding) => binding.model)]) {
      if (aliases.has(declaration)) continue;
      const alias = `GrpcClass_${aliases.size}`;
      aliases.set(declaration, alias);
      lines.push(`import { ${declaration.name!.text} as ${alias} } from ${JSON.stringify(toModuleSpecifier(sourcePathForDeclaration(declaration)))};`);
    }
  }
  lines.push("export const GENERATED_PROVIDER_ATTACHMENTS = Object.freeze([");
  for (const [controller, bindings] of entries) {
    const methods = bindings.map((binding) => `${JSON.stringify(binding.method)}: { model: ${aliases.get(binding.model)}, requestStream: ${binding.requestStream} }`);
    lines.push(`  { channel: GRPC_REQUEST_BINDINGS, target: ${aliases.get(controller)}, value: { ${methods.join(", ")} } },`);
  }
  lines.push("]);" );
  return lines;
}

function collectTokenDescriptions(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length > 0) {
      const firstArg = node.arguments[0];
      if (firstArg && ts.isStringLiteralLike(firstArg)) {
        if (node.expression.text === "createToken" || node.expression.text === "createOpenGenericTokenFamily") {
          tokenDescriptions.add(firstArg.text);
        }
        if (node.expression.text === "defineConfig") {
          // The same description defineConfig gives its token.
          const prefix = firstArg.text || "default";
          tokenDescriptions.add(`Config:${prefix}`);
          const typeName = node.typeArguments?.[0] && getDependencyTypeName(node.typeArguments[0]);
          if (typeName) configPrefixesByType.set(typeName, (configPrefixesByType.get(typeName) ?? new Set()).add(prefix));
        }
      }
    }
    if (ts.isClassDeclaration(node) && node.name) {
      knownClassNames.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
}

/**
 * Replaces each `ConfigView<T>` placeholder with the token of the one
 * `defineConfig<T>(...)` declaration. Runs after every source was read, because
 * a service may come before the file that declares its configuration.
 */
function resolveConfigViewDeps(): void {
  for (const [declaration, deps] of classDeps) {
    let changed = false;
    const resolved: CollectedDependency[] = [];
    for (const [index, dep] of deps.entries()) {
      const typeName = /^ConfigView<(.+)>$/.exec(dep.name)?.[1];
      if (typeName === undefined) {
        resolved.push(dep);
        continue;
      }
      const prefixes = [...(configPrefixesByType.get(typeName) ?? [])];
      if (prefixes.length !== 1) {
        classDeps.delete(declaration);
        if (needsInferredDiDeps(declaration)) {
          fatalErrors.push(prefixes.length === 0
            ? `BAZIS_DI_CONFIG_UNKNOWN: ${sourceLocation(declaration)}: constructor parameter ${index + 1} of "${declaration.name?.text}" has type "ConfigView<${typeName}>", but no defineConfig<${typeName}>(...) declaration was found. Declare the configuration with an explicit type argument, for example defineConfig<${typeName}>("name", { default: {...} }).`
            : `BAZIS_DI_CONFIG_AMBIGUOUS: ${sourceLocation(declaration)}: constructor parameter ${index + 1} of "${declaration.name?.text}" has type "ConfigView<${typeName}>", which matches several declarations: ${prefixes.map((prefix) => `"${prefix}"`).join(", ")}. Give each declaration its own type, or pass the token explicitly: scoped(Service, Service, [config.token]).`);
        }
        changed = false;
        break;
      }
      resolved.push({ name: `Config:${prefixes[0]}`, ...(dep.optional ? { optional: true } : {}) });
      changed = true;
    }
    if (changed && classDeps.has(declaration)) classDeps.set(declaration, resolved);
  }
}

function validateDepsAgainstKnownTokens(): void {
  for (const [declaration, deps] of classDeps) {
    for (let index = 0; index < deps.length; index += 1) {
      const rawName = deps[index]!.name;
      const depName = rawName.startsWith("lazy:") ? rawName.slice("lazy:".length) : rawName;
      if (
        tokenDescriptions.has(depName) ||
        knownClassNames.has(depName) ||
        depName.startsWith("IRepository<") ||
        depName.startsWith("IRepository:")
      ) {
        continue;
      }
      // An optional trailing parameter of a type DI does not know (`options: Options = {}`)
      // is not injected: the constructor gets its default, as without codegen.
      if (deps[index]!.optional) {
        classDeps.set(declaration, deps.slice(0, index));
        break;
      }
      classDeps.delete(declaration);
      // A class DI must construct cannot lose a dependency silently: the app
      // would fail later, far from the cause. Other classes need no entry.
      if (needsInferredDiDeps(declaration)) {
        fatalErrors.push(declaration.members.some(ts.isConstructorDeclaration)
          ? `BAZIS_DI_DEPENDENCY_UNKNOWN: ${sourceLocation(declaration)}: constructor parameter ${index + 1} of "${declaration.name?.text}" has type "${depName}", which is neither a DI token (createToken) nor a class known to codegen. Register it, import it from the framework package, or bind the class with an explicit factory.`
          : `BAZIS_DI_CONSTRUCTOR_UNRESOLVED: ${sourceLocation(declaration)}: inherited constructor dependency "${depName}" has no known DI token.`);
      }
      break;
    }
  }
}

function collectClassDeps(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const result = readConstructorTypeNames(node);
      if (result.unsupportedParameter !== undefined && needsInferredDiDeps(node)) {
        const { index, name, type } = result.unsupportedParameter;
        fatalErrors.push(`BAZIS_DI_DEPENDENCY_UNKNOWN: ${sourceLocation(node)}: constructor parameter ${index + 1} "${name}" of "${node.name.text}" has type "${type}", which cannot be injected: DI resolves dependencies by class, contract or token, and a plain type does not say which value to inject. Declare a token with the same name as a type alias (export type Prefix = string; export const Prefix = createToken<Prefix>("Prefix")) and register a value, or pass the deps explicitly: scoped(${node.name.text}, ${node.name.text}, [TOKEN] as const).`);
      }
      if (result.unsupportedInheritedParameter !== undefined && needsInferredDiDeps(node)) {
        fatalErrors.push(`BAZIS_DI_CONSTRUCTOR_UNRESOLVED: ${sourceLocation(node)}: cannot infer inherited constructor parameter "${result.unsupportedInheritedParameter}" for "${node.name.text}". The parameter needs a runtime DI token or an explicit value/factory binding.`);
      }
      if (result.deps.length > 0) {
        if (dependencyClassExportName(node)) {
          // Abstract bases supply inherited signatures, never concrete DI targets.
          if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword)) {
            classDeps.set(node, result.deps);
          }
        } else if (needsInferredDiDeps(node)) {
          fatalErrors.push(`BAZIS_DI_CLASS_UNIMPORTABLE: ${sourceLocation(node)}: DI class "${node.name.text}" must be exported (an export alias is sufficient) so constructor dependencies can bind to its exact identity.`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
}

/** Only registrations that need inference require an importable constructor.
 * Local helpers and deliberately explicit registrations need no generated entry.
 */
function collectDiClassRegistrations(source: ts.SourceFile): void {
  const record = (expression: ts.Expression | undefined, explicit = false): void => {
    if (!expression) return;
    const declaration = classDeclarationForExpression(expression)
      ?? checker.getTypeAtLocation(expression).getConstructSignatures()[0]?.getReturnType().getSymbol()?.declarations?.find(ts.isClassDeclaration);
    if (declaration) (explicit ? explicitlyBoundDiClasses : inferredDiClasses).add(declaration);
  };
  const objectFor = (expression: ts.Expression | undefined, seen = new Set<ts.Node>()): ts.ObjectLiteralExpression | undefined => {
    if (!expression || seen.has(expression)) return undefined;
    seen.add(expression);
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) return objectFor(expression.expression, seen);
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration) ? objectFor(declaration.initializer, seen) : undefined;
  };
  const propertiesOf = (node: ts.ObjectLiteralExpression) => new Map(node.properties.filter(ts.isPropertyAssignment)
    .map((property) => [property.name.getText().replace(/["']/g, ""), property.initializer]));
  const recordProvider = (expression: ts.Expression | undefined): void => {
    const object = objectFor(expression);
    if (!object) return;
    const properties = propertiesOf(object);
    if (properties.has("provide") && properties.has("useClass")
      && (!properties.has("deps") || properties.get("deps")!.getText() === "undefined")) record(properties.get("useClass"));
  };
  const visitedModules = new Set<ts.ObjectLiteralExpression>();
  const recordModule = (expression: ts.Expression | undefined): void => {
    const object = objectFor(expression);
    if (!object || visitedModules.has(object)) return;
    visitedModules.add(object);
    const properties = propertiesOf(object);
    for (const name of ["controllers", "grpcControllers", "background", "tools"]) {
      const classes = properties.get(name);
      if (classes && ts.isArrayLiteralExpression(classes)) for (const entry of classes.elements) record(entry);
    }
    const imports = properties.get("imports");
    if (imports && ts.isArrayLiteralExpression(imports)) for (const entry of imports.elements) recordModule(entry);
  };
  const hasContextualProperty = (node: ts.ObjectLiteralExpression, property: string, suffix: string): boolean => {
    const type = checker.getContextualType(node);
    return (type?.isUnion() ? type.types : type ? [type] : []).some((part) =>
      part.getProperty(property)?.declarations?.some((declaration) => declaration.getSourceFile().fileName.replace(/\\/g, "/").endsWith(suffix)));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      let symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.declarations?.find((entry) => ts.isFunctionDeclaration(entry) || ts.isMethodDeclaration(entry));
      const file = declaration?.getSourceFile().fileName.replace(/\\/g, "/");
      const name = declaration && "name" in declaration && declaration.name && ts.isIdentifier(declaration.name)
        ? declaration.name.text : undefined;
      if (file?.endsWith("/core/di/module/shortcuts.ts") && ["singleton", "scoped", "transient"].includes(name ?? "")) {
        // Explicit deps apply to this registration, not every use of the class.
        if (node.arguments[2] === undefined || node.arguments[2].getText(source) === "undefined") record(node.arguments[1] ?? node.arguments[0]);
      } else if (file?.endsWith("/core/di/module/DI.ts")) {
        if (name === "classProvider" && (node.arguments[2] === undefined || node.arguments[2].getText(source) === "undefined")) {
          record(node.arguments[1]);
        } else if (name === "bindDeps" || name === "injectFor") record(node.arguments[0], true);
        else if (["singleton", "scoped", "transient", "keyedSingleton", "keyedScoped", "keyedTransient"].includes(name ?? "")) {
          recordProvider(node.arguments[node.arguments.length - 1]);
        }
      } else if ((file?.endsWith("/core/di/module/Module.ts") && name === "Module")
        || (file?.endsWith("/core/di/module/createContainer.ts") && name === "createContainer")
        || (file?.endsWith("/core/kernel/Bazis.ts") && name === "createBuilder")) {
        recordModule(node.arguments[0]);
      } else if (file?.endsWith("/core/di/ServiceCollection.ts") || file?.endsWith("/core/di/module/ModuleRegistrar.ts")) {
        for (const argument of node.arguments) recordProvider(argument);
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      if (hasContextualProperty(node, "useClass", "/core/di/provider/types/ClassProvider.ts")) recordProvider(node);
      if (hasContextualProperty(node, "background", "/core/di/module/types/BazisModule.ts")) recordModule(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function hasStaticClassDeps(node: ts.ClassDeclaration): boolean {
  if (!node.name) return false;
  const symbol = checker.getSymbolAtLocation(node.name);
  if (!symbol) return false;
  const type = checker.getTypeOfSymbolAtLocation(symbol, node);
  return type.getProperty("inject") !== undefined || type.getProperty("deps") !== undefined;
}

function needsInferredDiDeps(node: ts.ClassDeclaration): boolean {
  return inferredDiClasses.has(node) && !explicitlyBoundDiClasses.has(node) && !hasStaticClassDeps(node);
}

/** The checker substitutes type parameters across all inherited constructors.
 * Reading only the base declaration would incorrectly bind T instead of X in Base<X>.
 */
function readInheritedConstructorDeps(node: ts.ClassDeclaration): ConstructorDependencies {
  if (!node.name || !node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) return { deps: [] };
  const symbol = checker.getSymbolAtLocation(node.name);
  const signature = symbol && checker.getTypeOfSymbolAtLocation(symbol, node).getConstructSignatures()[0];
  if (!signature) return { deps: [] };
  const parameters = signature.getParameters();
  let lastRequired = -1;
  for (let index = parameters.length - 1; index >= 0; index--) {
    const declaration = parameters[index]!.valueDeclaration;
    if (declaration && ts.isParameter(declaration) && !declaration.questionToken && !declaration.initializer) {
      lastRequired = index;
      break;
    }
  }
  const deps: CollectedDependency[] = [];
  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index]!;
    const parameterDeclaration = parameter.valueDeclaration;
    const optional = parameterDeclaration !== undefined && ts.isParameter(parameterDeclaration)
      && (parameterDeclaration.questionToken !== undefined || parameterDeclaration.initializer !== undefined);
    let type = checker.getTypeOfSymbolAtLocation(parameter, node);
    const declaration = parameter.valueDeclaration;
    // A default before a required argument still occupies a DI position. The
    // checker adds undefined to that parameter; the original annotation did not.
    if (declaration && ts.isParameter(declaration) && declaration.initializer && type.isUnion()) {
      const defined = type.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined));
      if (defined.length === 1) type = defined[0]!;
    }
    if (optional && type.isUnion()) {
      const defined = type.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined));
      if (defined.length === 1) type = defined[0]!;
    }
    const dependency = dependencyFromType(type);
    if (!dependency && index > lastRequired) break;
    if (!dependency) return { deps: [], unsupportedInheritedParameter: parameter.name };
    deps.push(optional && !dependency.lazy ? { ...dependency, optional: true } : dependency);
  }
  return { deps };
}

function dependencyFromType(type: ts.Type): CollectedDependency | undefined {
  if (type.flags & ts.TypeFlags.TypeParameter) return undefined;
  const symbol = type.getSymbol();
  const declaration = symbol?.declarations?.find(ts.isClassDeclaration);
  // Structural type aliases have the synthetic symbol __type; named DI tokens
  // retain their declared alias. A concrete class still uses constructor identity.
  const name = declaration?.name?.text ?? type.aliasSymbol?.name ?? symbol?.name;
  if (!name || BUILTIN_DEPENDENCY_NAMES.has(name)) return undefined;
  const arguments_ = type.flags & ts.TypeFlags.Object ? checker.getTypeArguments(type as ts.TypeReference) : [];
  if (name === "ConfigView") {
    const configType = arguments_[0];
    const configTypeName = configType && (configType.aliasSymbol?.name ?? configType.getSymbol()?.name);
    return configTypeName ? { name: `ConfigView<${configTypeName}>` } : undefined;
  }
  if (name === "Lazy" || name === "IRepository") {
    const inner = arguments_[0] && dependencyFromType(arguments_[0]);
    if (!inner) return undefined;
    return name === "Lazy" ? { ...inner, name: `lazy:${inner.name}`, lazy: true } : { name: `IRepository<${inner.name}>` };
  }
  const target = declaration && !declaration.getSourceFile().isDeclarationFile && dependencyClassExportName(declaration) ? declaration : undefined;
  return { name, target };
}

function readConstructorTypeNames(node: ts.ClassDeclaration): ConstructorDependencies {
  const ctor = node.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member));
  if (!ctor) {
    return readInheritedConstructorDeps(node);
  }

  const deps: CollectedDependency[] = [];
  const lastRequiredParamIndex = findLastRequiredParameterIndex(ctor);
  for (let index = 0; index < ctor.parameters.length; index += 1) {
    const param = ctor.parameters[index];
    if (!param) {
      continue;
    }
    // Optional parameters (`cache?: ICache`, `clock: Clock = new SystemClock()`)
    // are injected when registered and left unset otherwise.
    const optional = param.questionToken !== undefined || param.initializer !== undefined;
    const trailing = index > lastRequiredParamIndex;
    const paramType = param.type;
    const refName = paramType ? getDependencyTypeName(paramType) : undefined;
    if (!refName || BUILTIN_DEPENDENCY_NAMES.has(refName)) {
      if (trailing) break;
      return { deps: [], unsupportedParameter: { index, name: param.name.getText(), type: paramType?.getText() ?? "(no type)" } };
    }
    const optionalFlag = optional ? { optional: true } : {};

    // `Lazy<X>` is a deferred dependency on X: encode it with a marker prefix
    // so the runtime injects a Lazy wrapper instead of resolving X eagerly.
    if (refName === "Lazy" && paramType && ts.isTypeReferenceNode(paramType)) {
      const innerType = paramType.typeArguments?.[0];
      const innerName = innerType ? getDependencyTypeName(innerType) : undefined;
      if (!innerName) {
        return { deps: [] };
      }
      deps.push({ name: `lazy:${innerName}`, target: dependencyClass(innerType!), lazy: true });
      continue;
    }

    if (refName === "ConfigView" && paramType && ts.isTypeReferenceNode(paramType)) {
      const configType = paramType.typeArguments?.[0];
      const configTypeName = configType ? getDependencyTypeName(configType) : undefined;
      if (configTypeName) {
        deps.push({ name: `ConfigView<${configTypeName}>`, ...optionalFlag });
        continue;
      }
    }

    if (refName === "IRepository" && paramType && ts.isTypeReferenceNode(paramType)) {
      const entityType = paramType.typeArguments?.[0];
      const entityName = entityType ? getDependencyTypeName(entityType) : undefined;
      if (entityName) {
        deps.push({ name: `IRepository<${entityName}>`, ...optionalFlag });
        continue;
      }
    }

    deps.push({ name: refName, target: dependencyClass(paramType!), ...optionalFlag });
  }

  return { deps };
}

/** Resolve imported type aliases/re-exports; runtime named binding stays module-scoped. */
/** The element keyword of an array type: `string[]`, `Array<string>`, `readonly string[]` -> "string". */
function arrayElementKeyword(node: ts.TypeNode): string | undefined {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return arrayElementKeyword(node.type);
  if (ts.isArrayTypeNode(node)) return node.elementType.getText().trim();
  if (ts.isTypeReferenceNode(node) && ["Array", "ReadonlyArray"].includes(node.typeName.getText()) && node.typeArguments?.length === 1) {
    return node.typeArguments[0]!.getText().trim();
  }
  return undefined;
}

function getDependencyTypeName(node: ts.TypeNode): string | undefined {
  if (!ts.isTypeReferenceNode(node)) return undefined;
  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
    const target = checker.getAliasedSymbol(symbol);
    const declaration = target.declarations?.find(ts.isClassDeclaration);
    return declaration?.name?.text ?? target.name;
  }
  return getTypeReferenceName(node);
}

function findLastRequiredParameterIndex(ctor: ts.ConstructorDeclaration): number {
  for (let index = ctor.parameters.length - 1; index >= 0; index -= 1) {
    const param = ctor.parameters[index];
    if (!param) {
      continue;
    }
    if (param.questionToken === undefined && param.initializer === undefined) {
      return index;
    }
  }
  return -1;
}

// ── HTTP binding conventions ─────────────────────────────────────────────────

function decoratorCall(decorator: ts.Decorator): { name: string; call?: ts.CallExpression } | undefined {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return { name: expression.expression.text, call: expression };
  }
  if (ts.isIdentifier(expression)) {
    return { name: expression.text };
  }
  return undefined;
}

function hasDecorator(node: ts.HasDecorators, name: string): boolean {
  const decorators = ts.getDecorators(node);
  return decorators?.some((decorator) => decoratorCall(decorator)?.name === name) ?? false;
}

/** Route parameter names from all route decorators of a method (":id(int)" -> "id"). */
/**
 * Route parameter names of an action: the `@Controller` prefix and the method
 * template, parsed like `Routing/template.ts` (`:name`, `:name(int)`, `*name`,
 * and a bare `*` named `rest`).
 */
function routeParamNames(controller: ts.ClassDeclaration, method: ts.MethodDeclaration): Set<string> {
  const names = new Set<string>();
  const templates: string[] = [];
  const sources: readonly [readonly ts.Decorator[], (name: string) => boolean][] = [
    [ts.getDecorators(controller) ?? [], (name) => name === "Controller"],
    [ts.getDecorators(method) ?? [], (name) => ROUTE_DECORATORS.has(name)],
  ];
  for (const [decorators, accepts] of sources) {
    for (const decorator of decorators) {
      const info = decoratorCall(decorator);
      const firstArg = info?.call?.arguments[0];
      if (info && accepts(info.name) && firstArg && ts.isStringLiteralLike(firstArg)) templates.push(firstArg.text);
    }
  }
  for (const template of templates) {
    for (const segment of template.split("/")) {
      const param = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(segment);
      if (param) names.add(param[1] as string);
      else if (segment.startsWith("*")) names.add(segment.length > 1 ? segment.slice(1) : "rest");
    }
  }
  return names;
}

/** Reuses the request hydration graph; no reflection metadata/runtime TS imports. */
function collectGrpcBindings(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name && hasDecorator(node, "GrpcController")) {
      const bindings: GrpcRequestBinding[] = [];
      // Include inherited methods, resolving the most-derived signature.
      for (const property of checker.getTypeAtLocation(node).getProperties()) {
        const member = property.declarations?.find((declaration): declaration is ts.MethodDeclaration =>
          ts.isMethodDeclaration(declaration) && hasDecorator(declaration, "GrpcMethod"));
        if (!member) continue;
        const decorator = (ts.getDecorators(member) ?? []).map(decoratorCall).find((entry) => entry?.name === "GrpcMethod");
        const explicit = decorator?.call?.arguments[1];
        if (explicit !== undefined && explicit.getText() !== "undefined") {
          const declaration = classDeclarationForExpression(explicit);
          if (declaration) explicitRequestModelRoots.add(declaration);
          continue;
        }
        const parameter = member.parameters[0];
        if (!parameter?.type) continue;
        let type = checker.getNonNullableType(checker.getTypeAtLocation(parameter));
        const requestStream = ["AsyncIterable", "AsyncIterableIterator", "AsyncGenerator"].includes(type.getSymbol()?.name ?? "");
        if (requestStream) {
          const element = checker.getTypeArguments(type as ts.TypeReference)[0];
          if (!element) continue;
          type = checker.getNonNullableType(element);
        }
        if (type.isUnionOrIntersection() && type.types.some((part) => classDeclarationForSymbol(part.getSymbol()))) {
          fatalErrors.push(`${sourceLocation(member)}: gRPC request must have one concrete DTO class; bind it explicitly with @GrpcMethod(name, Model).`);
          continue;
        }
        const model = classDeclarationForSymbol(type.getSymbol());
        // Interfaces/inline objects retain their existing raw protobuf behavior.
        if (!model) continue;
        if (!isNamedExportedTopLevelClass(node) || !isNamedExportedTopLevelClass(model)
          || !isScannedProjectDeclaration(model) || isFrameworkInternalDeclaration(model)) {
          fatalErrors.push(`${sourceLocation(member)}: gRPC DTO/controller must be named project exports; use an explicit @GrpcMethod(name, Model) binding otherwise.`);
          continue;
        }
        if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
          fatalErrors.push(`${sourceLocation(member)}: gRPC DTO inference requires a named method; bind its DTO explicitly.`);
          continue;
        }
        bindings.push({ method: member.name.text, model, requestStream });
      }
      if (bindings.length > 0) grpcBindings.set(node, bindings);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

/** Infers HTTP route/query/body conventions from controller method signatures. */
function collectHttpBindings(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      recordClassDeclaration(node, source.fileName);
      if (hasDecorator(node, "RequestModel")) {
        requestModelClassNames.add(node.name.text);
        explicitRequestModelRoots.add(node);
      }
      if (hasDecorator(node, "Controller")) {
        collectControllerBindings(node, node.name.text, source.fileName);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function classDeclarationForExpression(expression: ts.Expression): ts.ClassDeclaration | undefined {
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return classDeclarationForSymbol(symbol);
}

function classDeclarationForSymbol(symbol: ts.Symbol | undefined): ts.ClassDeclaration | undefined {
  if (symbol === undefined) {
    return undefined;
  }
  return symbol.declarations?.find(ts.isClassDeclaration);
}

/** Pre-pass: records names of classes that (directly) extend `ListRequest`. */
function collectListRequestClasses(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name && extendsListRequest(node)) {
      listRequestClassNames.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function collectOpenApiSchemas(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const schema = openApiCodegen.schemaFromDeclaration(node);
      openApiSchemaModels.set(node, openApiCodegen.schemaNameForDeclaration(node.name.text, node));
      if (Object.keys(schema.properties as Record<string, unknown>).length > 0) {
        openApiSchemas[openApiCodegen.schemaNameForDeclaration(node.name.text, node)] = schema;
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      const schema = openApiCodegen.schemaFromDeclaration(node);
      if (Object.keys(schema.properties as Record<string, unknown>).length > 0) {
        openApiSchemas[openApiCodegen.schemaNameForDeclaration(node.name.text, node)] = schema;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

/**
 * Records runtime response constructors referenced by @UiProfile so generated
 * OpenAPI metadata can bind each constructor to its exact component schema.
 * This keeps code-first consumers nominal and avoids `class.name` matching.
 */
function collectUiProfileResponseModels(source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      for (const decorator of ts.getDecorators(node) ?? []) {
        const call = decoratorCall(decorator);
        if (call?.name !== "UiProfile" || call.call === undefined) {
          continue;
        }
        const options = call.call.arguments[0];
        if (options === undefined || !ts.isObjectLiteralExpression(options)) {
          fatalErrors.push(
            `@UiProfile on ${node.name?.text ?? "<anonymous>"} must receive one object literal so codegen can resolve response identity.`,
          );
          continue;
        }
        const responseProperties: ts.PropertyAssignment[] = [];
        const topLevel = options.properties.find((property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && uiProfileOptionName(property.name) === "response");
        if (topLevel !== undefined) {
          responseProperties.push(topLevel);
        }
        const collectEndpointResponses = (candidate: ts.Node): void => {
          if (ts.isCallExpression(candidate) && expressionName(candidate.expression) === "uiEndpoint") {
            const assertions = candidate.arguments[2];
            if (assertions !== undefined && ts.isObjectLiteralExpression(assertions)) {
              const response = assertions.properties.find((property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) && uiProfileOptionName(property.name) === "response");
              if (response !== undefined) {
                responseProperties.push(response);
              }
            }
          }
          ts.forEachChild(candidate, collectEndpointResponses);
        };
        collectEndpointResponses(options);
        for (const responseProperty of responseProperties) {
          const declaration = classDeclarationForExpression(responseProperty.initializer);
          if (declaration?.name === undefined) {
            fatalErrors.push(
              `@UiProfile response on ${node.name?.text ?? "<anonymous>"} must reference an exported runtime class.`,
            );
            continue;
          }
          if (!isNamedExportedTopLevelClass(declaration)) {
            fatalErrors.push(
              `@UiProfile response ${declaration.name.text} must be a named exported top-level class.`,
            );
            continue;
          }
          uiProfileResponseModels.set(
            declaration,
            openApiCodegen.schemaNameForDeclaration(declaration.name.text, declaration),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function expressionName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function uiProfileOptionName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function resolveUiProfileResponseModelImports(): OpenApiSchemaModelImport[] {
  const out: OpenApiSchemaModelImport[] = [];
  for (const [declaration, schemaName] of uiProfileResponseModels) {
    if (openApiSchemas[schemaName] === undefined) {
      fatalErrors.push(
        `@UiProfile response ${declaration.name?.text ?? "<anonymous>"} has no generated OpenAPI schema ${schemaName}.`,
      );
      continue;
    }
    out.push({ declaration, schemaName });
  }
  return out.sort((left, right) =>
    left.schemaName.localeCompare(right.schemaName)
      || sourcePathForDeclaration(left.declaration).localeCompare(sourcePathForDeclaration(right.declaration)));
}

/** Agent DTOs and their referenced classes share the existing nominal OpenAPI registry. */
function resolveOpenApiSchemaModelImports(agentModels: readonly ts.ClassDeclaration[], agentNames: readonly string[]): OpenApiSchemaModelImport[] {
  const models = new Map(resolveUiProfileResponseModelImports().map((model) => [model.declaration, model.schemaName]));
  // Empty class contracts still have a real object schema and must survive filtering.
  for (const declaration of agentModels) {
    const name = openApiCodegen.schemaNameForDeclaration(declaration.name!.text, declaration);
    openApiSchemas[name] ??= openApiCodegen.schemaFromDeclaration(declaration);
    models.set(declaration, name);
  }
  const reachable = new Set<string>();
  const add = (name: string | undefined): void => {
    if (name === undefined || reachable.has(name)) return;
    reachable.add(name);
    collectSchemaRefs(openApiSchemas[name], add);
  };
  for (const name of agentNames) add(name);
  for (const [declaration, name] of openApiSchemaModels) {
    if (!reachable.has(name)) continue;
    if (!isNamedExportedTopLevelClass(declaration)) {
      fatalErrors.push(`BAZIS_AGENT_SCHEMA_MODEL_UNIMPORTABLE: Agent schema ${name} must be a named exported top-level class (${sourcePathForDeclaration(declaration)}).`);
      continue;
    }
    openApiSchemas[name] ??= openApiCodegen.schemaFromDeclaration(declaration);
    models.set(declaration, name);
  }
  return [...models].map(([declaration, schemaName]) => ({ declaration, schemaName })).sort((left, right) =>
    left.schemaName.localeCompare(right.schemaName)
      || sourcePathForDeclaration(left.declaration).localeCompare(sourcePathForDeclaration(right.declaration)));
}

function collectOpenApiOperation(controllerName: string, method: ts.MethodDeclaration): void {
  if (!ts.isIdentifier(method.name)) {
    return;
  }
  (openApiOperations[controllerName] ??= {})[method.name.text] = openApiCodegen.operationFromMethod(method);
}

/** True if the class has an `extends ListRequest` (with or without type args). */
function extendsListRequest(node: ts.ClassDeclaration): boolean {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const type of clause.types) {
      const expression = type.expression;
      if (ts.isIdentifier(expression) && expression.text === "ListRequest") {
        return true;
      }
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === "ListRequest") {
        return true;
      }
    }
  }
  return false;
}

function collectControllerBindings(node: ts.ClassDeclaration, controllerName: string, filePath: string): void {
  const previousFile = httpControllerFiles[controllerName];
  if (previousFile && previousFile !== filePath) {
    fatalErrors.push(
      `duplicate controller name "${controllerName}" in "${previousFile}" and "${filePath}". ` +
        `Generated bindings are keyed by class name; rename one of the controllers.`,
    );
  }
  httpControllerFiles[controllerName] = filePath;

  for (const { name, routes, member } of controllerActions(node)) {
    collectOpenApiOperation(controllerName, member);
    const routeParams = routeParamNames(node, routes);
    const specs: HttpBindingSpec[] = [];
    let bodyCount = 0;
    let failed: string | undefined;

    for (const param of member.parameters) {
      if (!ts.isIdentifier(param.name)) {
        failed = "destructured parameters are not supported";
        break;
      }
      const paramName = param.name.text;
      const optional = param.questionToken !== undefined || param.initializer !== undefined;
      const typeNode = param.type;
      const keywordType = typeNode ? typeNode.getText().trim() : undefined;
      const refName = typeNode ? getTypeReferenceName(typeNode) : undefined;

      if (refName && CONTEXT_TYPES[refName] !== undefined) {
        specs.push({ source: CONTEXT_TYPES[refName] as HttpBindingSpec["source"] });
        continue;
      }
      if (routeParams.has(paramName)) {
        // Constraint conversion happens in the router; add type only for plain :params.
        const type = keywordType !== undefined ? PRIMITIVE_QUERY_TYPES[keywordType] : undefined;
        specs.push({ source: "route", name: paramName, type: type === "string" ? undefined : type, optional });
        continue;
      }
      // `tag: string[]`, `Array<number>`, `readonly boolean[]` -> every ?tag= value.
      const elementKeyword = typeNode ? arrayElementKeyword(typeNode) : undefined;
      const elementType = elementKeyword !== undefined ? PRIMITIVE_QUERY_TYPES[elementKeyword] : undefined;
      if (elementType !== undefined) {
        specs.push({ source: "query", name: paramName, type: elementType === "string" ? undefined : elementType, optional, array: true });
        continue;
      }
      const primitiveType =
        keywordType !== undefined ? PRIMITIVE_QUERY_TYPES[keywordType] : inferTypeFromInitializer(param.initializer);
      if (primitiveType !== undefined) {
        specs.push({ source: "query", name: paramName, type: primitiveType === "string" ? undefined : primitiveType, optional });
        continue;
      }
      if (refName !== undefined) {
        // Class extending ListRequest -> universal list-query param (not a body).
        if (listRequestClassNames.has(refName)) {
          specs.push({ source: "list", model: refName, optional });
          continue;
        }
        bodyCount += 1;
        if (bodyCount > 1) {
          failed = "more than one body (class-typed) parameter";
          break;
        }
        specs.push({ source: "body", model: refName, optional });
        continue;
      }
      failed = `parameter "${paramName}" has no type annotation usable for conventions`;
      break;
    }

    if (failed) {
      fatalErrors.push(
        `BAZIS_HTTP_BINDING_UNRESOLVED: controller "${controllerName}.${name}" (${filePath}): cannot infer bindings (${failed}). ` +
          `Use supported parameter types; read headers or raw bodies through HttpContext, and inject services in the constructor.`,
      );
      continue;
    }
    (httpBindings[controllerName] ??= {})[name] = specs;
  }
}

interface ControllerAction {
  readonly name: string;
  /** Declaration whose route decorators give the routes. */
  readonly routes: ts.MethodDeclaration;
  /** Declaration that runs: its parameters are bound. */
  readonly member: ts.MethodDeclaration;
}

/**
 * Route methods of a controller, including those inherited from base classes,
 * as the runtime sees them: the nearest declaration with route decorators
 * gives the routes (a subclass's own decorators replace the base's), the
 * nearest implementation gives the parameters (an override without
 * decorators keeps the base routes with its own signature).
 */
function controllerActions(node: ts.ClassDeclaration): ControllerAction[] {
  const routes = new Map<string, ts.MethodDeclaration>();
  const members = new Map<string, ts.MethodDeclaration>();
  const seen = new Set<ts.ClassDeclaration>();
  for (let current: ts.ClassDeclaration | undefined = node; current && !seen.has(current); current = baseClassDeclaration(current)) {
    seen.add(current);
    for (const member of current.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const name = member.name.text;
      if (!members.has(name) && member.body !== undefined) members.set(name, member);
      if (!routes.has(name) && hasRouteDecorator(member)) routes.set(name, member);
    }
  }
  return [...routes].map(([name, declaration]) => ({ name, routes: declaration, member: members.get(name) ?? declaration }));
}

function hasRouteDecorator(member: ts.MethodDeclaration): boolean {
  return (ts.getDecorators(member) ?? []).some((decorator) => {
    const info = decoratorCall(decorator);
    return info !== undefined && ROUTE_DECORATORS.has(info.name);
  });
}

function baseClassDeclaration(node: ts.ClassDeclaration): ts.ClassDeclaration | undefined {
  const clause = node.heritageClauses?.find((item) => item.token === ts.SyntaxKind.ExtendsKeyword);
  const base = clause?.types[0]?.expression;
  return base === undefined ? undefined : classDeclarationForExpression(base);
}

/** `limit = 100` has no type annotation — infer the primitive from the default value. */
function inferTypeFromInitializer(initializer: ts.Expression | undefined): HttpBindingSpec["type"] | undefined {
  if (!initializer) {
    return undefined;
  }
  if (ts.isNumericLiteral(initializer)) {
    return "number";
  }
  if (
    ts.isPrefixUnaryExpression(initializer) &&
    initializer.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(initializer.operand)
  ) {
    return "number";
  }
  if (ts.isStringLiteralLike(initializer)) {
    return "string";
  }
  if (initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) {
    return "bool";
  }
  return undefined;
}

/** Records the declaration file of a class by name; flags cross-file duplicates as ambiguous. */
function recordClassDeclaration(declaration: ts.ClassDeclaration, filePath: string): void {
  const name = declaration.name?.text;
  if (name === undefined) {
    return;
  }
  const existing = classFilesByName.get(name);
  if (existing === undefined) {
    classFilesByName.set(name, filePath);
    classDeclarationsByName.set(name, declaration);
  } else if (existing !== filePath || classDeclarationsByName.get(name) !== declaration) {
    ambiguousClassNames.add(name);
    classDeclarationsByName.delete(name);
  }
}

interface RequestModelImport {
  readonly className: string;
  readonly importPath: string;
  readonly declaration: ts.ClassDeclaration;
}

/**
 * Resolves every convention body model to the file that declares it, so the
 * generated registry can import and register it automatically — no
 * `@RequestModel()` decorator and no manual side-effect import required.
 */
function resolveRequestModelImports(): RequestModelImport[] {
  const modelNames = new Set<string>();
  for (const methods of Object.values(httpBindings)) {
    for (const specs of Object.values(methods)) {
      for (const spec of specs) {
        if (spec.source === "body" && spec.model !== undefined) {
          modelNames.add(spec.model);
        }
      }
    }
  }

  const imports: RequestModelImport[] = [];
  for (const className of [...modelNames].sort((a, b) => a.localeCompare(b))) {
    if (ambiguousClassNames.has(className)) {
      fatalErrors.push(
        `body model "${className}" is declared in more than one file; ` +
          `rename one of the classes.`,
      );
      continue;
    }
    const filePath = classFilesByName.get(className);
    const declaration = classDeclarationsByName.get(className);
    if (filePath === undefined) {
      // Not declared in scanned sources (e.g. external) — fall back to a
      // manual @RequestModel() so the body still resolves at runtime.
      if (!requestModelClassNames.has(className)) {
        warnings.push(
          `body model "${className}" was not found in scanned sources. ` +
            `Add @RequestModel() to the class.`,
        );
      }
      continue;
    }
    // Framework-internal models (e.g. test fixtures) self-register via their own
    // @RequestModel() decorator; the generated registry targets app code only.
    if (FRAMEWORK_INTERNAL_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      continue;
    }
    if (declaration === undefined) {
      fatalErrors.push(`body model "${className}" could not be resolved to one class declaration.`);
      continue;
    }
    imports.push({ className, importPath: toModuleSpecifier(filePath), declaration });
  }
  return imports;
}

/**
 * Resolves every ListRequest subclass used as a list-query param to its
 * declaring file, so the generated registry can import and register it (the
 * binder resolves the class by name at startup).
 */
function resolveListModelImports(): RequestModelImport[] {
  const modelNames = new Set<string>();
  for (const methods of Object.values(httpBindings)) {
    for (const specs of Object.values(methods)) {
      for (const spec of specs) {
        if (spec.source === "list" && spec.model !== undefined) {
          modelNames.add(spec.model);
        }
      }
    }
  }

  const imports: RequestModelImport[] = [];
  for (const className of [...modelNames].sort((a, b) => a.localeCompare(b))) {
    if (ambiguousClassNames.has(className)) {
      fatalErrors.push(
        `list model "${className}" is declared in more than one file; rename one of the classes.`,
      );
      continue;
    }
    const filePath = classFilesByName.get(className);
    if (filePath === undefined || FRAMEWORK_INTERNAL_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      continue;
    }
    const declaration = classDeclarationsByName.get(className);
    if (declaration === undefined) {
      fatalErrors.push(`list model "${className}" could not be resolved to one class declaration.`);
      continue;
    }
    imports.push({ className, importPath: toModuleSpecifier(filePath), declaration });
  }
  return imports;
}

/**
 * Builds the transitive DTO graph used by the runtime hydrator. TypeScript
 * source is the source of truth; no `emitDecoratorMetadata` or reflect runtime
 * dependency is required.
 */
function resolveRequestModelHydration(conventionRoots: readonly RequestModelImport[]): RequestModelHydration {
  const requiredRoots = [...conventionRoots.map((entry) => entry.declaration), ...[...grpcBindings.values()].flatMap((bindings) => bindings.map((binding) => binding.model))];
  const roots = new Set<ts.ClassDeclaration>(requiredRoots);
  for (const declaration of explicitRequestModelRoots) {
    if (!isFrameworkInternalDeclaration(declaration) && isScannedProjectDeclaration(declaration)) {
      roots.add(declaration);
    }
  }
  const hydration = analyzeRequestModelHydration({
    checker,
    roots: [...roots],
    requiredRoots,
    isProjectDeclaration: isScannedProjectDeclaration,
    isExcludedDeclaration: isFrameworkInternalDeclaration,
    isNamedExportedTopLevelClass,
    sourcePathForDeclaration,
    sourceLocation,
  });
  fatalErrors.push(...hydration.errors);
  return hydration;
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}

function isNamedExportedTopLevelClass(declaration: ts.ClassDeclaration): boolean {
  if (declaration.name === undefined || !ts.isSourceFile(declaration.parent)) {
    return false;
  }
  if (
    hasModifier(declaration, ts.SyntaxKind.ExportKeyword) &&
    !hasModifier(declaration, ts.SyntaxKind.DefaultKeyword)
  ) {
    return true;
  }
  // Also support `class Dto {}; export { Dto };` without weakening the
  // generated named-import contract (renamed/default exports remain explicit
  // codegen errors).
  const moduleSymbol = checker.getSymbolAtLocation(declaration.parent);
  if (moduleSymbol === undefined) {
    return false;
  }
  return checker.getExportsOfModule(moduleSymbol).some((exported) => {
    if (exported.getName() !== declaration.name?.text) {
      return false;
    }
    const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
    return target.declarations?.includes(declaration) ?? false;
  });
}

function sourcePathForDeclaration(declaration: ts.ClassDeclaration): string {
  const fileName = declaration.getSourceFile().fileName.replaceAll("\\", "/");
  return normalizeProjectPath(fileName);
}

function normalizeProjectPath(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  return path.isAbsolute(normalized) ? path.relative(".", normalized).replaceAll("\\", "/") : normalized;
}

function isScannedProjectDeclaration(declaration: ts.ClassDeclaration): boolean {
  return sourceFilePathSet.has(sourcePathForDeclaration(declaration));
}

function isFrameworkInternalDeclaration(declaration: ts.ClassDeclaration): boolean {
  const filePath = sourcePathForDeclaration(declaration);
  return FRAMEWORK_INTERNAL_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function sourceLocation(node: ts.Node): string {
  const source = node.getSourceFile();
  const location = source.getLineAndCharacterOfPosition(node.getStart(source));
  const fileName = path.isAbsolute(source.fileName) ? path.relative(".", source.fileName) : source.fileName;
  return `${fileName.replaceAll("\\", "/")}:${location.line + 1}`;
}

function renderListModels(imports: readonly RequestModelImport[]): string {
  const lines: string[] = [];
  lines.push("// This file is auto-generated by `bazis codegen`.");
  lines.push("// Do not edit manually.");
  lines.push("//");
  lines.push("// Target-local immutable descriptor; runtime publication is staged by runtime.ts.");
  lines.push("");
  if (imports.length === 0) {
    lines.push("export const GENERATED_LIST_MODELS = Object.freeze([]);");
    lines.push("");
    return lines.join("\n");
  }
  for (const entry of imports) {
    lines.push(`import { ${entry.className} } from ${JSON.stringify(entry.importPath)};`);
  }
  lines.push("");
  lines.push("export const GENERATED_LIST_MODELS = Object.freeze([");
  for (const entry of imports) lines.push(`  ${entry.className},`);
  lines.push("]);" );
  lines.push("");
  return lines.join("\n");
}

/** Relative, extension-less module specifier from the generated dir to `filePath`. */
function toModuleSpecifier(filePath: string): string {
  return toModuleSpecifierFrom(activeGeneratedDir, filePath);
}

function toModuleSpecifierFrom(fromDir: string, filePath: string): string {
  const withoutExt = filePath.replace(/\.tsx?$/, "");
  let relative = path.relative(fromDir, withoutExt).replaceAll("\\", "/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
}

function renderRequestModels(
  imports: readonly RequestModelImport[],
  hydration: RequestModelHydration,
): string {
  const lines: string[] = [];
  lines.push("// This file is auto-generated by `bazis codegen`.");
  lines.push("// Do not edit manually.");
  lines.push("//");
  lines.push("// Registers convention body models (class-typed action params) so they are");
  lines.push("// Target-local immutable descriptor; runtime publication is staged by runtime.ts.");
  lines.push("");
  if (imports.length === 0 && hydration.declarations.length === 0) {
    lines.push("export const GENERATED_REQUEST_MODELS = Object.freeze([]);");
    lines.push("export const GENERATED_REQUEST_MODEL_SHAPES = Object.freeze([]);");
    lines.push("");
    return lines.join("\n");
  }
  const aliases = new Map<ts.ClassDeclaration, string>();
  for (let index = 0; index < hydration.declarations.length; index += 1) {
    const declaration = hydration.declarations[index] as ts.ClassDeclaration;
    const alias = `RequestModel_${index}`;
    aliases.set(declaration, alias);
    lines.push(
      `import { ${declaration.name?.text ?? ""} as ${alias} } from ` +
        `${JSON.stringify(toModuleSpecifier(sourcePathForDeclaration(declaration)))};`,
    );
  }
  lines.push("");
  lines.push("export const GENERATED_REQUEST_MODELS = Object.freeze([");
  for (const entry of imports) {
    const alias = aliases.get(entry.declaration); if (alias !== undefined) lines.push(`  ${alias},`);
  }
  lines.push("]);" );
  lines.push("export const GENERATED_REQUEST_MODEL_SHAPES = Object.freeze([");
  for (const declaration of hydration.declarations) {
    const alias = aliases.get(declaration);
    const shape = hydration.fields.get(declaration);
    if (alias !== undefined && shape !== undefined) {
      const fields = shape.map((field) => `${JSON.stringify(field.property)}: { ${field.primitive === undefined ? `model: ${aliases.get(field.model!)}` : `primitive: ${JSON.stringify(field.primitive)} as const`},${field.array ? " array: true," : ""}${field.nullable ? " nullable: true," : ""}${field.elementNullable ? " elementNullable: true," : ""} }`).join(", ");
      lines.push(`  [${alias}, Object.freeze({ ${fields} })] as const,`);
    }
  }
  lines.push("]);" );
  lines.push("");
  return lines.join("\n");
}

function renderOpenApiMetadata(
  schemas: Record<string, OpenApiCodegenSchema>,
  operations: Record<string, Record<string, OpenApiCodegenOperationSpec>>,
  target: "app" | "core",
  extraSchemaNames: readonly string[] = [],
  schemaModels: readonly OpenApiSchemaModelImport[] = [],
): string {
  const sortedSchemas = sortRecord(filterRecord(
    schemas,
    usedOpenApiSchemaNames(
      schemas,
      operations,
      [...extraSchemaNames, ...schemaModels.map((model) => model.schemaName)],
    ),
  ));
  const sortedOperations: Record<string, Record<string, OpenApiCodegenOperationSpec>> = {};
  for (const controllerName of Object.keys(operations).sort((a, b) => a.localeCompare(b))) {
    sortedOperations[controllerName] = sortRecord(operations[controllerName] as Record<string, OpenApiCodegenOperationSpec>);
  }

  const lines: string[] = [];
  lines.push("// This file is auto-generated by `bazis codegen`.");
  lines.push("// Do not edit manually.");
  lines.push("");
  lines.push(
    target === "app"
      ? 'import type { GeneratedOpenApiMetadata } from "bazis/library/openapi";'
      : 'import type { GeneratedOpenApiMetadata } from "../../../library/openapi";',
  );
  if (target === "app") {
    for (let index = 0; index < schemaModels.length; index += 1) {
      const model = schemaModels[index] as OpenApiSchemaModelImport;
      lines.push(
        `import { ${model.declaration.name?.text ?? ""} as UiSchemaModel_${index} } from ` +
          `${JSON.stringify(toModuleSpecifier(sourcePathForDeclaration(model.declaration)))};`,
      );
    }
  }
  lines.push("");
  lines.push("export const GENERATED_OPENAPI_METADATA: GeneratedOpenApiMetadata = {");
  lines.push(`  schemas: ${JSON.stringify(sortedSchemas, null, 2).replaceAll("\n", "\n  ")},`);
  lines.push(`  operations: ${JSON.stringify(sortedOperations, null, 2).replaceAll("\n", "\n  ")},`);
  lines.push("};");
  if (target === "app") {
    lines.push("");
    lines.push("export const GENERATED_OPENAPI_SCHEMA_MODELS = Object.freeze([");
    for (let index = 0; index < schemaModels.length; index += 1) lines.push(`  [UiSchemaModel_${index}, ${JSON.stringify((schemaModels[index] as OpenApiSchemaModelImport).schemaName)}] as const,`);
    lines.push("]);" );
  } else lines.push("export const GENERATED_OPENAPI_SCHEMA_MODELS = Object.freeze([]);");
  lines.push("");
  return lines.join("\n");
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    out[key] = record[key] as T;
  }
  return out;
}

function filterRecord<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    if (keys.has(key)) {
      out[key] = record[key] as T;
    }
  }
  return out;
}

function usedOpenApiSchemaNames(
  schemas: Record<string, OpenApiCodegenSchema>,
  operations: Record<string, Record<string, OpenApiCodegenOperationSpec>>,
  extraSchemaNames: readonly string[] = [],
): Set<string> {
  const used = new Set<string>();
  const queue: string[] = [];
  const add = (name: string | undefined): void => {
    if (name !== undefined && schemas[name] !== undefined && !used.has(name)) {
      used.add(name);
      queue.push(name);
    }
  };

  for (const methods of Object.values(httpBindings)) {
    for (const specs of Object.values(methods)) {
      for (const spec of specs) {
        if ((spec.source === "body" || spec.source === "list") && spec.model !== undefined) {
          add(spec.model);
        }
      }
    }
  }
  for (const methods of Object.values(operations)) {
    for (const operation of Object.values(methods)) {
      collectSchemaRefs(operation.response, add);
    }
  }
  for (const name of extraSchemaNames) add(name);
  for (let index = 0; index < queue.length; index += 1) {
    const schema = schemas[queue[index] as string];
    collectSchemaRefs(schema, add);
  }
  return used;
}

function collectSchemaRefs(value: unknown, add: (name: string | undefined) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSchemaRefs(item, add);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref === "string") {
    const prefix = "#/components/schemas/";
    add(ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined);
  }
  for (const item of Object.values(record)) {
    collectSchemaRefs(item, add);
  }
}



function getTypeReferenceName(node: ts.TypeNode): string | undefined {
  if (!ts.isTypeReferenceNode(node)) {
    return undefined;
  }
  const typeName = node.typeName;
  if (ts.isIdentifier(typeName)) {
    return typeName.text;
  }
  if (ts.isQualifiedName(typeName)) {
    return typeName.right.text;
  }
  return undefined;
}
