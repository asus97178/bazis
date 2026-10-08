import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../../../..");
const SRC = path.join(ROOT, "src");
const BAZIS = path.join(SRC, "bazis");
const APP_GENERATED = path.join(SRC, "generated", "bazis");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const TSCONFIG_JSON = path.join(ROOT, "tsconfig.json");

const STABLE_BAZIS_BARRELS = new Set([
  "bazis/core/agent",
  "bazis/core/app",
  "bazis/core/background",
  "bazis/core/cache",
  "bazis/core/di",
  "bazis/core/http-client",
  "bazis/core/http",
  "bazis/core/grpc",
  "bazis/core/infra",
  "bazis/core/kernel",
  "bazis/core/orm",
  "bazis/core/testing",
  "bazis/core/websocket",
  "bazis/library/http-client",
  "bazis/library/boundary",
  "bazis/library/jsonapi",
  "bazis/library/jwt",
  "bazis/library/openapi",
  "bazis/library/orm",
  "bazis/library/redaction",
  "bazis/library/ui",
  "bazis/library/validation",
]);

const ALLOWED_TYPESCRIPT_IMPORTS = new Set([
  posix(path.join(BAZIS, "cli/moduleRegistration.ts")),
  posix(path.join(BAZIS, "core/scripts/agent-codegen.ts")),
  posix(path.join(BAZIS, "core/scripts/di-generate.ts")),
  posix(path.join(BAZIS, "core/scripts/di-generate-target.ts")),
  posix(path.join(BAZIS, "core/scripts/orm-predicate-codegen.ts")),
  posix(path.join(BAZIS, "core/scripts/request-model-codegen.ts")),
  posix(path.join(BAZIS, "library/openapi/codegen.ts")),
]);

const IGNORED_DIRS = new Set(["test", "generated", "node_modules"]);

describe("runtime import boundary", () => {
  test("only real imports count: import-like text in strings and comments is ignored", () => {
    const content = [
      'import { a } from "./value";',
      'import type { B } from "./type-only";',
      'import "./side-effect";',
      'export * from "./reexport";',
      'export type { C } from "./type-reexport";',
      'const lazy = () => import("./dynamic");',
      'const message = `module "${name}" does not import "forbidden-package"`;',
      "const quoted = 'import x from \"also-forbidden\"';",
      '// import { hidden } from "commented-out";',
      '/* export * from "block-commented"; */',
      'const url = "https://example.com//path";',
    ].join("\n");
    expect(valueImportSpecifiers(content)).toEqual(["./value", "./side-effect", "./reexport", "./dynamic"]);
    expect(typeOnlyImportSpecifiers(content)).toEqual(["./type-only", "./type-reexport"]);
  });

  test("runtime source and framework package have no external dependencies", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      readonly private?: boolean;
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
    const framework = JSON.parse(readFileSync(path.join(BAZIS, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(Object.keys(framework.dependencies ?? {})).toEqual([]);

    const offenders: string[] = [];
    for (const base of [BAZIS, path.join(SRC, "app"), APP_GENERATED]) {
      if (!existsSync(base)) continue;
      for (const file of sourceFiles(base)) {
        if (shouldSkipBareImportCheck(file)) continue;
        const content = readFileSync(file, "utf8");
        for (const specifier of valueImportSpecifiers(content)) {
          if (!isAllowedRuntimeSpecifier(specifier)) {
            offenders.push(`${relative(file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("application code imports only public Bazis barrels", () => {
    const offenders: string[] = [];
    const bazisRoot = `${posix(BAZIS)}/`;
    // Application code: the host app when present, otherwise the shipped example.
    for (const base of [path.join(SRC, "app"), path.join(ROOT, "examples/todo/src/app")].filter((dir) => existsSync(dir))) {
      for (const file of sourceFiles(base)) {
        if (file.includes(`${path.sep}test${path.sep}`) || file.endsWith(".test.ts")) continue;
        const content = readFileSync(file, "utf8");
        for (const specifier of allImportSpecifiers(content)) {
          const barrel = specifier.startsWith("bazis/") ? `bazis/${specifier.slice("bazis/".length)}` : specifier;
          if (barrel.startsWith("bazis/") && !isStableBazisBarrel(barrel)) {
            offenders.push(`${relative(file)} -> ${specifier}`);
            continue;
          }
          if (specifier.startsWith("@/")) {
            offenders.push(`${relative(file)} -> ${specifier}`);
            continue;
          }
          const resolved = resolveLocalDependency(file, specifier);
          if (resolved !== undefined && posix(resolved).startsWith(bazisRoot)
            && specifier !== "bazis" && !isStableBazisBarrel(specifier)) {
            offenders.push(`${relative(file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("gRPC runtime, types and test peers do not import external packages", () => {
    const root = path.join(BAZIS, "core/grpc");
    const offenders: string[] = [];
    for (const base of [root, path.join(root, "test")]) {
      for (const file of sourceFiles(base)) {
        for (const specifier of allImportSpecifiers(readFileSync(file, "utf8"))) {
          if (!isAllowedRuntimeSpecifier(specifier)) offenders.push(relative(file) + " -> " + specifier);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("production generated runtime does not import demo sources", () => {
    const offenders: string[] = [];
    if (existsSync(APP_GENERATED)) {
      for (const file of sourceFiles(APP_GENERATED)) {
        // Additional target artifacts intentionally import their own
        // application slice. The default production surface must not.
        if (posix(file).includes("/generated/bazis/targets/")) continue;
        const content = readFileSync(file, "utf8");
        for (const specifier of allImportSpecifiers(content)) {
          if (specifier.includes("/demo/") || specifier.includes("../demo")) {
            offenders.push(`${relative(file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("direct TypeScript compiler imports stay in explicit codegen and CLI tooling files", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(BAZIS)) {
      const content = readFileSync(file, "utf8");
      for (const specifier of allImportSpecifiers(content)) {
        if (specifier === "typescript" && !ALLOWED_TYPESCRIPT_IMPORTS.has(posix(file))) {
          offenders.push(relative(file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("public runtime barrels do not reach the TypeScript compiler API", () => {
    const entrypoints = runtimeEntrypoints();
    const visited = new Set<string>();
    const stack = entrypoints.map((file) => ({ file, via: [relative(file)] }));
    const offenders: string[] = [];

    while (stack.length > 0) {
      const current = stack.pop()!;
      const key = posix(current.file);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      const content = readFileSync(current.file, "utf8");
      for (const dependency of valueImportSpecifiers(content)) {
        if (dependency === "typescript") {
          offenders.push(current.via.join(" -> "));
          continue;
        }
        const resolved = resolveLocalDependency(current.file, dependency);
        if (resolved && !shouldSkipRuntimeGraphFile(resolved)) {
          stack.push({ file: resolved, via: [...current.via, relative(resolved)] });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("library source never depends on core or the root mixed barrel", () => {
    const library = path.join(BAZIS, "library");
    const core = posix(path.join(BAZIS, "core")) + "/";
    const offenders: string[] = [];

    for (const file of sourceFiles(library)) {
      const content = readFileSync(file, "utf8");
      for (const specifier of allImportSpecifiers(content)) {
        if (specifier === "bazis" || specifier.startsWith("bazis/core/") || specifier.startsWith("@/core/")) {
          offenders.push(`${relative(file)} -> ${specifier}`);
          continue;
        }
        const resolved = resolveLocalDependency(file, specifier);
        if (resolved !== undefined && posix(resolved).startsWith(core)) {
          offenders.push(`${relative(file)} -> ${relative(resolved)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function runtimeEntrypoints(): string[] {
  const entrypoints = [
    path.join(BAZIS, "index.ts"),
    path.join(BAZIS, "core/generatedRuntime.ts"),
    path.join(APP_GENERATED, "runtime.ts"),
  ];
  for (const base of [path.join(BAZIS, "core"), path.join(BAZIS, "library")]) {
    for (const file of sourceFiles(base)) {
      if (file.endsWith(`${path.sep}index.ts`) && !shouldSkipRuntimeGraphFile(file)) {
        entrypoints.push(file);
      }
    }
  }
  return [...new Set(entrypoints.map((file) => posix(file)))].map((file) => path.normalize(file));
}

function* sourceFiles(dir: string): Iterable<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (IGNORED_DIRS.has(entry)) {
        continue;
      }
      yield* sourceFiles(full);
      continue;
    }
    if (full.endsWith(".ts")) {
      yield full;
    }
  }
}

function shouldSkipRuntimeGraphFile(file: string): boolean {
  const normalized = posix(file);
  return (
    normalized.includes("/src/bazis/core/scripts/") ||
    normalized.includes("/src/bazis/cli/") ||
    normalized.includes("/test/") ||
    normalized.endsWith("/src/bazis/library/openapi/codegen.ts")
  );
}

function shouldSkipBareImportCheck(file: string): boolean {
  const normalized = posix(file);
  return normalized.includes("/test/")
    || normalized.endsWith(".test.ts")
    || normalized.includes("/src/bazis/core/scripts/")
    || normalized.includes("/src/bazis/cli/")
    || normalized.endsWith("/src/bazis/library/openapi/codegen.ts");
}

function isAllowedRuntimeSpecifier(specifier: string): boolean {
  return specifier.startsWith(".")
    || specifier.startsWith("@/")
    || specifier === "bazis"
    || specifier.startsWith("bazis/")
    || specifier.startsWith("bazis/")
    || specifier === "bun"
    || specifier.startsWith("bun:")
    || specifier.startsWith("node:");
}

function isStableBazisBarrel(specifier: string): boolean {
  return STABLE_BAZIS_BARRELS.has(specifier);
}

function resolveLocalDependency(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    return resolveFile(path.resolve(path.dirname(fromFile), specifier));
  }
  if (specifier.startsWith("@/")) {
    return resolveFile(path.join(BAZIS, specifier.slice(2)));
  }
  if (specifier === "bazis") {
    return path.join(BAZIS, "index.ts");
  }
  if (specifier.startsWith("bazis/")) {
    return resolveFile(path.join(BAZIS, specifier.slice("bazis/".length)));
  }
  return undefined;
}

function resolveFile(base: string): string | undefined {
  const candidates = [
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function allImportSpecifiers(content: string): string[] {
  return [
    ...valueImportSpecifiers(content),
    ...typeOnlyImportSpecifiers(content),
  ];
}

// Parsed, not matched with regular expressions: an import-like phrase inside a
// string or a comment (`does not import "x"`) is not an import.
function valueImportSpecifiers(content: string): string[] {
  return importSpecifiers(content).filter((item) => !item.typeOnly).map((item) => item.specifier);
}

function typeOnlyImportSpecifiers(content: string): string[] {
  return importSpecifiers(content).filter((item) => item.typeOnly).map((item) => item.specifier);
}

interface ImportSpecifier { readonly specifier: string; readonly typeOnly: boolean }

function importSpecifiers(content: string): ImportSpecifier[] {
  const source = ts.createSourceFile("source.ts", content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: ImportSpecifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.importClause?.isTypeOnly === true });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] !== undefined
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function relative(file: string): string {
  return posix(path.relative(ROOT, file));
}

async function isolatedImportExitCode(specifier: string): Promise<number> {
  const child = Bun.spawn([
    process.execPath,
    "-e",
    `await import(${JSON.stringify(specifier)})`,
  ], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  return child.exited;
}

function posix(file: string): string {
  return file.split(path.sep).join("/");
}
