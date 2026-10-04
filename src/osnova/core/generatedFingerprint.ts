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
export function warnIfGeneratedSourcesChanged(
  generatedDir: string,
  fingerprint: GeneratedSourceFingerprint,
  warn: (message: string) => void = (message) => console.warn(message),
): boolean {
  const root = path.resolve(generatedDir, fingerprint.root);
  if (!existsSync(path.join(root, "osnv.config.json"))) return false;
  const changes: string[] = [];
  if (hashSources(root, fingerprint.files) !== fingerprint.hash) changes.push("application sources changed");
  const version = frameworkVersion();
  if (version !== undefined && version !== fingerprint.framework) changes.push(`osnv ${fingerprint.framework} -> ${version}`);
  if (changes.length === 0) return false;
  warn([
    "",
    `[osnv] WARNING: generated code is out of date (${changes.join("; ")}).`,
    "[osnv] New or changed controllers, routes and constructor dependencies are NOT active.",
    "[osnv] Run: bunx osnv codegen   (osnv dev, osnv build and osnv test run it automatically)",
    "",
  ].join("\n"));
  return true;
}
