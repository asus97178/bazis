import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../../..");
const SRC = path.join(ROOT, "src");
const OSNV = path.join(SRC, "osnv");
const APP_GENERATED = path.join(SRC, "generated", "osnv");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const TSCONFIG_JSON = path.join(ROOT, "tsconfig.json");

const STABLE_OSNV_BARRELS = new Set([
  "osnv/core/agent",
  "osnv/core/app",
  "osnv/core/background",
  "osnv/core/cache",
  "osnv/core/di",
  "osnv/core/http-client",
  "osnv/core/http",
  "osnv/core/grpc",
  "osnv/core/infra",
  "osnv/core/kernel",
  "osnv/core/orm",
  "osnv/core/websocket",
  "osnv/library/http-client",
  "osnv/library/boundary",
  "osnv/library/jsonapi",
  "osnv/library/jwt",
  "osnv/library/openapi",
  "osnv/library/orm",
  "osnv/library/redaction",
  "osnv/library/ui",
  "osnv/library/validation",
]);

const ALLOWED_TYPESCRIPT_IMPORTS = new Set([
  posix(path.join(OSNV, "cli/moduleRegistration.ts")),
  posix(path.join(OSNV, "core/scripts/agent-codegen.ts")),
  posix(path.join(OSNV, "core/scripts/di-generate.ts")),
  posix(path.join(OSNV, "core/scripts/di-generate-target.ts")),
  posix(path.join(OSNV, "core/scripts/orm-predicate-codegen.ts")),
  posix(path.join(OSNV, "core/scripts/request-model-codegen.ts")),
  posix(path.join(OSNV, "library/openapi/codegen.ts")),
]);

const IGNORED_DIRS = new Set(["test", "generated", "node_modules"]);

describe("runtime import boundary", () => {
  test("runtime source and framework package have no external dependencies", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
      readonly private?: boolean;
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
    const framework = JSON.parse(readFileSync(path.join(OSNV, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(Object.keys(framework.dependencies ?? {})).toEqual([]);

    const offenders: string[] = [];
    for (const base of [OSNV, path.join(SRC, "app"), APP_GENERATED]) {
      if (!existsSync(base)) continue;
      for (const file of sourceFiles(base)) {
        if (shouldSkipBareImportCheck(file)) continue;
        const content = stripComments(readFileSync(file, "utf8"));
        for (const specifier of valueImportSpecifiers(content)) {
          if (!isAllowedRuntimeSpecifier(specifier)) {
            offenders.push(`${relative(file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("application code imports only public Osnv barrels", () => {
    const offenders: string[] = [];
    const osnvRoot = `${posix(OSNV)}/`;
    // Application code: the host app when present, otherwise the shipped example.
    for (const base of [path.join(SRC, "app"), path.join(ROOT, "examples/todo/src/app")].filter((dir) => existsSync(dir))) {
      for (const file of sourceFiles(base)) {
        if (file.includes(`${path.sep}test${path.sep}`) || file.endsWith(".test.ts")) continue;
        const content = stripComments(readFileSync(file, "utf8"));
        for (const specifier of allImportSpecifiers(content)) {
          const barrel = specifier.startsWith("osnv/") ? `osnv/${specifier.slice(5)}` : specifier;
          if (barrel.startsWith("osnv/") && !isStableOsnvBarrel(barrel)) {
            offenders.push(`${relative(file)} -> ${specifier}`);
            continue;
          }
          if (specifier.startsWith("@/")) {
            offenders.push(`${relative(file)} -> ${specifier}`);
            continue;
          }
          const resolved = resolveLocalDependency(file, specifier);
          if (resolved !== undefined && posix(resolved).startsWith(osnvRoot)
            && specifier !== "osnv" && !isStableOsnvBarrel(specifier)) {
            offenders.push(`${relative(file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("gRPC runtime, types and test peers do not import external packages", () => {
    const root = path.join(OSNV, "core/grpc");
    const offenders: string[] = [];
    for (const base of [root, path.join(root, "test")]) {
      for (const file of sourceFiles(base)) {
        for (const specifier of allImportSpecifiers(stripComments(readFileSync(file, "utf8")))) {
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
        if (posix(file).includes("/generated/osnv/targets/")) continue;
        const content = stripComments(readFileSync(file, "utf8"));
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
    for (const file of sourceFiles(OSNV)) {
      const content = stripComments(readFileSync(file, "utf8"));
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

      const content = stripComments(readFileSync(current.file, "utf8"));
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
    const library = path.join(OSNV, "library");
    const core = posix(path.join(OSNV, "core")) + "/";
    const offenders: string[] = [];

    for (const file of sourceFiles(library)) {
      const content = stripComments(readFileSync(file, "utf8"));
      for (const specifier of allImportSpecifiers(content)) {
        if (specifier === "osnv" || specifier.startsWith("osnv/core/") || specifier.startsWith("@/core/")) {
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
    path.join(OSNV, "index.ts"),
    path.join(OSNV, "core/generatedRuntime.ts"),
    path.join(APP_GENERATED, "runtime.ts"),
  ];
  for (const base of [path.join(OSNV, "core"), path.join(OSNV, "library")]) {
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
    normalized.includes("/src/osnv/core/scripts/") ||
    normalized.includes("/src/osnv/cli/") ||
    normalized.includes("/test/") ||
    normalized.endsWith("/src/osnv/library/openapi/codegen.ts")
  );
}

function shouldSkipBareImportCheck(file: string): boolean {
  const normalized = posix(file);
  return normalized.includes("/test/")
    || normalized.endsWith(".test.ts")
    || normalized.includes("/src/osnv/core/scripts/")
    || normalized.includes("/src/osnv/cli/")
    || normalized.endsWith("/src/osnv/library/openapi/codegen.ts");
}

function isAllowedRuntimeSpecifier(specifier: string): boolean {
  return specifier.startsWith(".")
    || specifier.startsWith("@/")
    || specifier === "osnv"
    || specifier.startsWith("osnv/")
    || specifier.startsWith("osnv/")
    || specifier === "bun"
    || specifier.startsWith("bun:")
    || specifier.startsWith("node:");
}

function isStableOsnvBarrel(specifier: string): boolean {
  return STABLE_OSNV_BARRELS.has(specifier);
}

function resolveLocalDependency(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    return resolveFile(path.resolve(path.dirname(fromFile), specifier));
  }
  if (specifier.startsWith("@/")) {
    return resolveFile(path.join(OSNV, specifier.slice(2)));
  }
  if (specifier === "osnv") {
    return path.join(OSNV, "index.ts");
  }
  if (specifier.startsWith("osnv/")) {
    return resolveFile(path.join(OSNV, specifier.slice("osnv/".length)));
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

function valueImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const importRegex = /\bimport\s+(?!type\b)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
  const exportRegex = /\bexport\s+(?!type\b)(?:\*|\*\s+as\s+\w+|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
  const dynamicRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  collectMatches(content, importRegex, specifiers);
  collectMatches(content, exportRegex, specifiers);
  collectMatches(content, dynamicRegex, specifiers);
  return specifiers;
}

function typeOnlyImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const importTypeRegex = /\bimport\s+type\s+[^'"]*?\s+from\s+["']([^"']+)["']/g;
  const exportTypeRegex = /\bexport\s+type\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
  collectMatches(content, importTypeRegex, specifiers);
  collectMatches(content, exportTypeRegex, specifiers);
  return specifiers;
}

function collectMatches(content: string, regex: RegExp, output: string[]): void {
  for (const match of content.matchAll(regex)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      output.push(specifier);
    }
  }
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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
