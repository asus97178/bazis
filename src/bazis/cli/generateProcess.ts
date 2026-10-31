import path from "node:path";
import { readFile } from "node:fs/promises";
import { canonicalDirectory, commitWrites, fileInfo, findPack, type GenerateModuleResult, type PlannedWrite } from "./generateModule";
import { registerInModuleField } from "./moduleRegistration";
import { parseModuleName } from "./naming";
import { packPartFolder } from "./templates/pack";
import { buildProcessTemplate } from "./templates/process";

export interface GenerateProcessOptions {
  /** OrderApproval, order-approval. */
  readonly name: string;
  /** The module that owns the process: `Orders` → `{modulesRoot}/orders/Orders.module.ts`. */
  readonly module: string;
  /** The composite module the owner is a part of. */
  readonly pack?: string;
  /** Default: src/app/modules, relative to cwd. */
  readonly modulesRoot?: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

/**
 * Creates `processes/<Name>.process.ts` in a module and lists the process in
 * the module's `@Module({ processes })` (WORKFLOW-001 §14).
 */
export async function generateProcess(options: GenerateProcessOptions): Promise<GenerateModuleResult> {
  const naming = parseModuleName(options.name);
  const owner = parseModuleName(options.module);
  const modulesRoot = await canonicalDirectory(path.resolve(options.modulesRoot ?? "src/app/modules"));
  const pack = options.pack === undefined ? undefined : await findPack(modulesRoot, options.pack);
  const moduleDir = pack ? path.join(pack.dir, packPartFolder(owner)) : path.join(modulesRoot, owner.folder);
  const moduleFile = path.join(moduleDir, `${owner.module}.module.ts`);
  const moduleInfo = await fileInfo(moduleFile);
  if (moduleInfo?.isFile() !== true) {
    throw new Error(`Module ${owner.moduleClass} not found: ${path.relative(process.cwd(), moduleFile)}.${pack ? "" : " For a part of a composite module add --pack <Name>."}`);
  }
  const processFile = path.join(moduleDir, "processes", `${naming.module}.process.ts`);
  const existing = await fileInfo(processFile);
  if (existing && !options.force) throw new Error(`File already exists: ${processFile}. Use --force to overwrite.`);
  if (existing && !existing.isFile()) throw new Error(`Refusing to overwrite a non-regular file: ${processFile}`);
  const moduleSource = await readFile(moduleFile, "utf8");
  const writes: PlannedWrite[] = [
    { absolute: processFile, content: buildProcessTemplate(naming, owner.moduleClass), original: existing ? await readFile(processFile, "utf8") : undefined },
    { absolute: moduleFile, content: registerInModuleField(moduleSource, moduleFile, processFile, `${naming.module}Process`, { field: "processes", hostClass: owner.moduleClass }), original: moduleSource },
  ];
  const changed = writes.filter((write) => write.content !== write.original);
  if (!options.dryRun) await commitWrites(changed);
  return {
    moduleDir,
    files: [path.relative(process.cwd(), processFile)],
    registered: true,
    dryRun: options.dryRun === true,
    warnings: [],
    changes: changed.map((write) => ({ path: path.relative(process.cwd(), write.absolute), action: write.original === undefined ? "create" : "update" })),
  };
}
