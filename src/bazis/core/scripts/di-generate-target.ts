import path from "node:path";
import ts from "typescript";

interface TargetConfig {
  readonly entrypoints: readonly string[];
  readonly applicationParts?: readonly string[];
}

export interface CodegenConfig {
  readonly version: 1;
  readonly defaultTarget: string;
  readonly targets: Readonly<Record<string, TargetConfig>>;
}

const TARGET_NAME = /^[a-z][a-z0-9-]*$/;

/** Project-private v1 config validation. Analysis and rendering live in di-generate.ts. */
export async function readCodegenConfig(): Promise<CodegenConfig> {
  let parsed: unknown;
  try {
    parsed = await Bun.file("bazis.config.json").json();
  } catch {
    throw new Error("BAZIS_CODEGEN_CONFIG_INVALID: bazis.config.json");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("BAZIS_CODEGEN_CONFIG_INVALID: root object required");
  const value = parsed as Partial<CodegenConfig>;
  if (value.version !== 1 || typeof value.defaultTarget !== "string" || !value.targets || typeof value.targets !== "object") {
    throw new Error("BAZIS_CODEGEN_CONFIG_INVALID: version=1, defaultTarget and targets are required");
  }
  for (const [name, target] of Object.entries(value.targets)) {
    if (!TARGET_NAME.test(name) || !target || !Array.isArray(target.entrypoints) || target.entrypoints.length === 0) {
      throw new Error(`BAZIS_CODEGEN_CONFIG_INVALID: invalid target ${name}`);
    }
    for (const candidate of [...target.entrypoints, ...(target.applicationParts ?? [])]) normalizeConfiguredPath(candidate);
  }
  if (!Object.hasOwn(value.targets, value.defaultTarget)) throw new Error("BAZIS_CODEGEN_CONFIG_INVALID: defaultTarget is undeclared");
  return value as CodegenConfig;
}

export function normalizeConfiguredPath(value: string): string {
  if (typeof value !== "string" || path.isAbsolute(value) || value.includes("*") || value.includes("?")) {
    throw new Error(`BAZIS_CODEGEN_CONFIG_INVALID: invalid path ${String(value)}`);
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === ".." || normalized !== value) {
    throw new Error(`BAZIS_CODEGEN_CONFIG_INVALID: path must be normalized root-relative: ${value}`);
  }
  return normalized;
}

export function projectPath(fileName: string): string {
  return path.relative(".", fileName).replaceAll("\\", "/");
}

/** Static import/export/literal-import reachability over an already-created Program. */
export function collectTargetReachability(
  program: ts.Program,
  files: ReadonlyMap<string, ts.SourceFile>,
  roots: readonly string[],
): Set<string> {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (reached.has(current)) continue;
    reached.add(current);
    const source = files.get(current);
    if (!source) continue;
    const literals: ts.StringLiteralLike[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        literals.push(node.moduleSpecifier);
      }
      const dynamicArgument = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (dynamicArgument !== undefined && ts.isStringLiteralLike(dynamicArgument)) {
        literals.push(dynamicArgument);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const literal of literals) {
      const resolved = ts.resolveModuleName(literal.text, source.fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
      if (resolved) {
        const next = projectPath(resolved.resolvedFileName);
        if (files.has(next)) pending.push(next);
      }
    }
  }
  return reached;
}
