import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { buildModuleTemplates, type ModuleTemplateFiles, type ModuleTemplateProfile } from "./templates/module";
import { buildPackTemplates } from "./templates/pack";
import { parseModuleName, type ModuleNaming } from "./naming";
import { moduleImportPath, registerModuleInSource } from "./moduleRegistration";

export interface GenerateModuleOptions {
  /** User, users, order-item. */
  readonly name: string;
  /** Default: src/app/modules, relative to cwd. */
  readonly modulesRoot?: string;
  /** Default: {modulesRoot}/App.module.ts, relative to cwd. */
  readonly appModulePath?: string;
  readonly register?: boolean;
  readonly force?: boolean;
  readonly profile?: ModuleTemplateProfile;
  /** Validate and return the plan without writing files. */
  readonly dryRun?: boolean;
}

export interface GenerateModulePackOptions extends Omit<GenerateModuleOptions, "profile"> {
  readonly parts: readonly string[];
}

export interface GenerateModuleResult {
  readonly moduleDir: string;
  readonly files: readonly string[];
  /** In dry-run, whether the resulting plan connects the module. */
  readonly registered: boolean;
  readonly dryRun: boolean;
  readonly changes: readonly { readonly path: string; readonly action: "create" | "update" }[];
  readonly warnings: readonly string[];
}

interface PlannedWrite {
  readonly absolute: string;
  readonly content: string;
  readonly original: string | undefined;
}

export async function generateModule(options: GenerateModuleOptions): Promise<GenerateModuleResult> {
  const naming = parseModuleName(options.name);
  const profile = options.profile ?? "minimal";
  if (!["empty", "minimal", "full"].includes(profile)) throw new Error(`Unknown profile: ${profile}`);
  const modulesRoot = await canonicalDirectory(path.resolve(options.modulesRoot ?? "src/app/modules"));
  let authImportPath: string | undefined;
  if (profile === "full") {
    const authRoot = await canonicalDirectory(path.resolve("src/app/modules/auth"));
    for (const helper of ["tokenKinds.ts", "jwtAuth.ts"]) {
      if (!(await fileInfo(path.join(authRoot, helper)))?.isFile()) {
        throw new Error(`Full profile requires host auth helper: ${path.join(authRoot, helper)}. Use --minimal or --empty for a standalone scaffold.`);
      }
    }
    authImportPath = moduleImportPath(path.join(modulesRoot, naming.folder, "http", `${naming.entity}Controller.ts`), authRoot);
  }
  return generateFiles(options, naming, naming.folder, buildModuleTemplates(naming, profile, authImportPath));
}

export async function generateModulePack(options: GenerateModulePackOptions): Promise<GenerateModuleResult> {
  const naming = parseModuleName(options.name);
  return generateFiles(options, naming, `${naming.folder}_modules`, buildPackTemplates(naming, options.parts));
}

async function generateFiles(options: GenerateModuleOptions, naming: ModuleNaming, folder: string, templates: readonly ModuleTemplateFiles[]): Promise<GenerateModuleResult> {
  const modulesRoot = await canonicalDirectory(path.resolve(options.modulesRoot ?? "src/app/modules"));
  const moduleDir = path.join(modulesRoot, folder);
  const requestedAppPath = path.resolve(options.appModulePath ?? path.join(modulesRoot, "App.module.ts"));
  const appModulePath = path.join(await canonicalDirectory(path.dirname(requestedAppPath)), path.basename(requestedAppPath));
  const moduleInfo = await fileInfo(moduleDir);
  if (moduleInfo && !options.force) throw new Error(`Module folder already exists: ${moduleDir}. Use --force to overwrite.`);
  if (moduleInfo && !moduleInfo.isDirectory()) throw new Error(`Module path is not a directory: ${moduleDir}.`);

  const featureWrites: PlannedWrite[] = [];
  for (const file of templates) {
    const absolute = path.join(moduleDir, file.relativePath);
    const info = await fileInfo(absolute);
    if (info && !options.force) throw new Error(`File already exists: ${absolute}. Use --force to overwrite.`);
    if (info && !info.isFile()) throw new Error(`Refusing to overwrite a non-regular file: ${absolute}`);
    featureWrites.push({ absolute, content: file.content, original: info ? await readFile(absolute, "utf8") : undefined });
  }

  // Complete host preflight before the first write, including on --force.
  const writes = [...featureWrites];
  const warnings: string[] = [];
  let registered = false;
  if (options.register !== false) {
    const appInfo = await fileInfo(appModulePath);
    if (!appInfo) {
      warnings.push(`App module not found, skipped registration: ${appModulePath}`);
    } else {
      if (!appInfo.isFile()) throw new Error(`App module must be a regular file: ${appModulePath}`);
      const original = await readFile(appModulePath, "utf8");
      const content = registerModuleInSource(original, appModulePath, path.join(moduleDir, `${naming.entity}.module.ts`), naming.moduleClass);
      if (content !== original) writes.push({ absolute: appModulePath, content, original });
      registered = true;
    }
  }
  const changed = writes.filter((write) => write.content !== write.original);
  if (!options.dryRun) await commitWrites(changed);
  return {
    moduleDir,
    files: featureWrites.map((write) => path.relative(process.cwd(), write.absolute)),
    registered, dryRun: options.dryRun === true, warnings,
    changes: changed.map((write) => ({ path: path.relative(process.cwd(), write.absolute), action: write.original === undefined ? "create" : "update" })),
  };
}

async function fileInfo(absolute: string) {
  try {
    return await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Relative imports must survive runtime realpath resolution (e.g. /var -> /private/var). */
async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await canonicalDirectory(parent), path.basename(directory));
  }
}

async function commitWrites(writes: readonly PlannedWrite[]): Promise<void> {
  const completed: PlannedWrite[] = [];
  const createdDirectories = new Set<string>();
  try {
    for (const write of writes) {
      const current = await fileInfo(write.absolute);
      if ((current ? await readFile(write.absolute, "utf8") : undefined) !== write.original) {
        throw new Error(`File changed after generation was planned: ${write.absolute}`);
      }
      await writeAtomically(write.absolute, write.content, createdDirectories);
      completed.push(write);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const write of completed.reverse()) {
      try {
        if (write.original === undefined) await rm(write.absolute, { force: true });
        else await writeAtomically(write.absolute, write.original, createdDirectories);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
      try {
        await rmdir(directory);
      } catch (cleanupError) {
        const code = (cleanupError as NodeJS.ErrnoException).code;
        // Preserve files another writer may have added to a new directory.
        if (code !== "ENOTEMPTY" && code !== "ENOENT") rollbackErrors.push(cleanupError);
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Module generation failed and rollback was incomplete.");
    throw error;
  }
}

async function writeAtomically(absolute: string, content: string, createdDirectories: Set<string>): Promise<void> {
  const parent = path.dirname(absolute);
  const firstCreated = await mkdir(parent, { recursive: true });
  if (firstCreated) {
    for (let directory = parent; ; directory = path.dirname(directory)) {
      createdDirectories.add(directory);
      if (directory === firstCreated) break;
    }
  }
  const temporary = path.join(parent, `.${path.basename(absolute)}.osnova-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
}
