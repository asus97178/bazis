import path from "node:path";

const FRAME = /\(?((?:file:\/\/)?(?:\/|[A-Za-z]:\\)[^():]+):(\d+):\d+\)?\s*$/;

/** Frames of the configuration code itself are skipped: the caller is what matters. */
const OWN_DIRECTORY = import.meta.dir;

/**
 * `src/app/config/db.config.ts:3` of the first stack frame outside the
 * configuration code, relative to the working directory; undefined when the
 * stack has no such frame (a compiled executable keeps only virtual paths).
 */
export function callerFile(stack: string | undefined, cwd = process.cwd()): string | undefined {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = FRAME.exec(line.trim());
    if (!match) continue;
    const file = match[1]!.replace(/^file:\/\//, "");
    if (file.startsWith(OWN_DIRECTORY) || file.includes("$bunfs")) continue;
    const relative = path.relative(cwd, file);
    return `${relative.startsWith("..") ? file : relative}:${match[2]}`;
  }
  return undefined;
}
