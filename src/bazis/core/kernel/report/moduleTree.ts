import { isBazisModuleClass } from "../../di/module/Module";
import { ProviderDefinition, type BazisModuleMetadata, type BazisModuleRef, type Token } from "../../di";
import { tokenToDebugName } from "../../di/token";

/** One line under a module of the startup screen's module tree. */
export interface ModuleItem {
  readonly kind: "controller" | "service" | "table" | "background" | "tool" | "gateway" | "exports";
  readonly text: string;
  /** Controller class name, to match its routes. */
  readonly controller?: string;
}

export interface ModuleNode {
  readonly name: string;
  /** A composite module: only imports of other modules. */
  readonly pack: boolean;
  readonly items: readonly ModuleItem[];
  readonly children: readonly ModuleNode[];
}

/**
 * Describes extra `@Module` keys of a higher layer (`ormBazis`, `tools`) for
 * the module tree, the same way metadata expanders turn them into imports.
 */
export type ModuleDescriber = (metadata: BazisModuleMetadata) => readonly ModuleItem[];

const describers: ModuleDescriber[] = [];

export function registerModuleDescriber(describer: ModuleDescriber): void {
  if (!describers.includes(describer)) describers.push(describer);
}

/**
 * The application's own modules as a tree: classes with `@Module`, without
 * global infrastructure and framework modules. Factory results without a
 * class (`httpModule`, `memory()`) are passed through to the modules they import.
 */
export function describeModules(root: BazisModuleRef): readonly ModuleNode[] {
  const seen = new Set<BazisModuleRef>();
  const visit = (module: BazisModuleRef): ModuleNode[] => {
    if (seen.has(module)) return [];
    seen.add(module);
    const children = (module.imports ?? []).flatMap(visit);
    if (!isApplicationModule(module)) return children;
    return [Object.freeze({
      name: (module as { name: string }).name,
      pack: module !== root && isPack(module, children),
      items: Object.freeze(itemsOf(module)),
      children: Object.freeze(children),
    })];
  };
  return Object.freeze(visit(root));
}

function isApplicationModule(module: BazisModuleRef): boolean {
  if (!isBazisModuleClass(module) || module.global === true) return false;
  const name = (module as { name?: string }).name ?? "";
  return name.length > 0 && !name.startsWith("Bazis");
}

function isPack(module: BazisModuleMetadata, children: readonly ModuleNode[]): boolean {
  return children.length >= 2 && itemsOf(module).length === 0 && (module.imports ?? []).every(isBazisModuleClass);
}

function itemsOf(module: BazisModuleMetadata): ModuleItem[] {
  const items: ModuleItem[] = [];
  for (const controller of module.controllers ?? []) items.push({ kind: "controller", text: controller.name, controller: controller.name });
  for (const gateway of module.gateways ?? []) items.push({ kind: "gateway", text: gateway.name });
  for (const provider of module.providers ?? []) {
    const text = describeProvider(provider);
    if (text !== undefined) items.push({ kind: "service", text });
  }
  for (const describer of describers) items.push(...describer(module));
  for (const background of module.background ?? []) items.push({ kind: "background", text: background.name });
  if (module.exports !== undefined && module.exports.length > 0) {
    items.push({ kind: "exports", text: module.exports.map((token) => tokenName(token as Token<unknown>)).join(", ") });
  }
  return items;
}

/** `ITaskService → TaskService · scoped`. */
function describeProvider(definition: ProviderDefinition): string | undefined {
  if (!(definition instanceof ProviderDefinition)) return undefined;
  const provider = definition.provider as { provide: Token<unknown>; useClass?: { name: string } };
  const token = tokenName(provider.provide);
  const implementation = provider.useClass?.name;
  const target = implementation !== undefined && implementation !== token ? `${token} → ${implementation}` : token;
  return `${target} · ${definition.lifetime}`;
}

function tokenName(token: Token<unknown>): string {
  try {
    return tokenToDebugName(token);
  } catch {
    return "token";
  }
}
