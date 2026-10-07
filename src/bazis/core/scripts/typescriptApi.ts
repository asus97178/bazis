import { readFileSync } from "node:fs";
import path from "node:path";
import { plugin } from "bun";

/**
 * bazis codegen uses the TypeScript compiler API (`createProgram`, the type
 * checker). TypeScript 7 no longer ships it: `import ts from "typescript"`
 * gives only the version. Microsoft publishes the TypeScript 6 API as
 * `@typescript/typescript6`. When the `typescript` package seen from `fromDir`
 * is 7 or newer, this makes `import ts from "typescript"` in the current
 * process load that package instead. The project keeps TypeScript 7 as its
 * compiler (`tsc`).
 *
 * Must run before anything imports "typescript": as a `--preload` of the
 * codegen process, or in the CLI before its first dynamic import that needs it.
 * Does nothing when `typescript` cannot be resolved (for example inside the
 * compiled CLI binary, which bundles its own compiler API).
 */
export function useTypeScriptCompilerApi(fromDir: string): void {
  let entry: string;
  try {
    entry = Bun.resolveSync("typescript", fromDir);
  } catch {
    return;
  }
  const major = Number.parseInt(packageVersion(entry, "typescript")?.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 7) return;

  let api: string;
  try {
    api = Bun.resolveSync("@typescript/typescript6", fromDir);
  } catch {
    throw new Error(
      `BAZIS_TYPESCRIPT_API_MISSING: TypeScript ${major} has no compiler API, and bazis codegen needs one. ` +
        "Install the TypeScript 6 API next to it: bun add -d @typescript/typescript6",
    );
  }
  const exact = new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  plugin({
    name: "bazis-typescript6-api",
    setup(build) {
      build.onLoad({ filter: exact }, () => ({
        contents: `import ts from ${JSON.stringify(api)};\nexport default ts;\n`,
        loader: "js",
      }));
    },
  });
}

/** Version from the package.json of the package that contains `file`. */
function packageVersion(file: string, name: string): string | undefined {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name === name) return manifest.version;
    } catch {
      // No package.json at this level: keep walking up.
    }
  }
  return undefined;
}
