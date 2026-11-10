import { readdir } from "node:fs/promises";
import path from "node:path";
import { markColumns } from "./markColumns";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "generated", "dist", "bin", ".git"]);

async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) out.push(...await sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * `bazis upgrade columns`: from 0.137.0 every column says whether it may be
 * empty, `@Required()` or `@Nullable()`. This gives each column the mark of what
 * it was, so the schema of the application stays as it is, and removes the
 * `nullable` option. With `--dry-run` it only tells what it would change.
 */
export async function runUpgradeColumns(cwd: string, directory: string | undefined, dryRun: boolean, log: (text: string) => void): Promise<number> {
  const root = path.resolve(cwd, directory ?? "src");
  let files: string[];
  try {
    files = await sourceFiles(root);
  } catch {
    log(`No directory ${path.relative(cwd, root) || "."}. Pass the sources with --path <directory>.`);
    return 1;
  }
  let nullable = 0;
  let required = 0;
  let changed = 0;
  const skipped: string[] = [];
  for (const file of files) {
    const source = await Bun.file(file).text();
    if (!/@(Column|Index|ForeignKey|HasConversion)\(/.test(source)) continue;
    const name = path.relative(cwd, file);
    const result = markColumns(source, name);
    skipped.push(...result.skipped);
    if (result.text === source) continue;
    changed += 1;
    nullable += result.nullable;
    required += result.required;
    log(`${dryRun ? "would change" : "changed"} ${name}: ${[result.nullable > 0 ? `${result.nullable} @Nullable()` : "", result.required > 0 ? `${result.required} @Required()` : "", result.nullable + result.required === 0 ? "the nullable option removed" : ""].filter(Boolean).join(", ")}`);
    if (!dryRun) await Bun.write(file, result.text);
  }
  for (const line of skipped) log(`look at ${line}`);
  log(changed === 0
    ? "Nothing to change: every column already says whether it may be empty."
    : `${dryRun ? "Would change" : "Changed"} ${changed} ${changed === 1 ? "file" : "files"}: ${nullable} columns marked @Nullable(), ${required} marked @Required(). The schema stays as it was. Review the diff: where a column must not be empty, write @Required() instead and migrate the data.`);
  return 0;
}
