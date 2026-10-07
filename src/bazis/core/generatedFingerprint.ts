import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** What codegen saw: project sources of the target and the framework version. */
export interface GeneratedSourceFingerprint {
  /** Project root relative to the generated directory. */
  readonly root: string;
  readonly framework: string;
  /** Project-relative source files of the target, sorted. */
  readonly files: readonly string[];
  readonly hash: string;
}

/** sha256 over every path and its bytes; undefined when a listed file is gone. */
export function hashSources(root: string, files: readonly string[]): string | undefined {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) return undefined;
    hasher.update(file).update("\0").update(readFileSync(absolute)).update("\0");
  }
  return hasher.digest("hex");
}

/** Version of the framework package this module belongs to, when on disk. */
export function frameworkVersion(): string | undefined {
  try {
    const version = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../package.json"), "utf8")).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Warns loudly when the app is started from sources that changed after codegen
 * (or with another framework version): new routes and dependencies would be
 * silently missing. A compiled binary carries no sources, so it is skipped.
 */
let staleGeneratedSources = false;

/**
 * True when the loaded generated code was produced from older sources (or
 * another bazis version) than the ones running now.
 */
export function generatedSourcesAreStale(): boolean {
  return staleGeneratedSources;
}

export function warnIfGeneratedSourcesChanged(
  generatedDir: string,
  fingerprint: GeneratedSourceFingerprint,
  warn: (message: string) => void = (message) => console.warn(message),
): boolean {
  const root = path.resolve(generatedDir, fingerprint.root);
  if (!existsSync(path.join(root, "bazis.config.json"))) return false;
  const changes: string[] = [];
  if (hashSources(root, fingerprint.files) !== fingerprint.hash) changes.push("application sources changed");
  const version = frameworkVersion();
  if (version !== undefined && version !== fingerprint.framework) changes.push(`bazis ${fingerprint.framework} -> ${version}`);
  if (changes.length === 0) return false;
  staleGeneratedSources = true;
  warn([
    "",
    `[bazis] WARNING: generated code is out of date (${changes.join("; ")}).`,
    "[bazis] New or changed controllers, routes and constructor dependencies are NOT active.",
    "[bazis] Run: bunx bazis codegen   (bazis dev, bazis build and bazis test run it automatically)",
    "",
  ].join("\n"));
  return true;
}
