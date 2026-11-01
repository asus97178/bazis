import { isExpressionNode } from "./expressions";
import { isPath } from "./paths";
import type { ProcessDocument } from "./ProcessDocument";

/** What a personal value shows as in the history. */
export const PERSONAL_MASK = "***";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether personal data is masked in the history of this version: yes unless `log.maskPersonal` is `false`. */
export function masksPersonal(document: Pick<ProcessDocument, "settings">): boolean {
  return document.settings?.log?.maskPersonal !== false;
}

/**
 * The paths of the personal variables: `$input.email`, `$vars.email`. A loop over
 * personal data adds its element: `$item` and the name the loop gives it.
 */
export function personalPaths(document: Pick<ProcessDocument, "variables"> & Partial<Pick<ProcessDocument, "nodes">>): ReadonlySet<string> {
  const paths = new Set((document.variables ?? []).filter((variable) => variable.personal === true).map((variable) => `${variable.direction === "in" ? "$input" : "$vars"}.${variable.name}`));
  const loops = Object.values(document.nodes ?? {}).filter((node) => node.kind === "loop" && node.config?.over !== undefined);
  // A loop over the element of another loop: as many passes as it takes.
  for (let size = -1; size !== paths.size;) {
    size = paths.size;
    for (const { config } of loops) {
      if (!readsPersonal(config!.over, paths)) continue;
      paths.add("$item");
      if (typeof config!.item === "string") paths.add(`$vars.${config!.item}`);
    }
  }
  return paths;
}

/** The names of the personal `local` and `out` variables. */
export function personalVariables(document: Pick<ProcessDocument, "variables">): ReadonlySet<string> {
  return new Set((document.variables ?? []).filter((variable) => variable.personal === true && variable.direction !== "in").map((variable) => variable.name));
}

function touches(path: string, personal: ReadonlySet<string>): boolean {
  for (const root of personal) if (path === root || path.startsWith(`${root}.`)) return true;
  return false;
}

/** Whether an expression or a path string reads a personal variable. */
export function readsPersonal(value: unknown, personal: ReadonlySet<string>): boolean {
  if (isPath(value)) return touches(value, personal);
  if (!isExpressionNode(value)) return false;
  if ("path" in value) return typeof value.path === "string" && touches(value.path, personal);
  return Array.isArray(value.args) && value.args.some((arg) => readsPersonal(arg, personal));
}

/** A resolved step input with what its mapping took from personal variables masked. */
export function maskByMapping(mapping: unknown, value: unknown, personal: ReadonlySet<string>): unknown {
  if (personal.size === 0) return value;
  if (readsPersonal(mapping, personal)) return PERSONAL_MASK;
  if (isExpressionNode(mapping)) return value;
  if (Array.isArray(mapping) && Array.isArray(value)) return value.map((item, index) => maskByMapping(mapping[index], item, personal));
  if (isObject(mapping) && isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskByMapping(mapping[key], item, personal)]));
  return value;
}

/** A value with the fields its JSON Schema marks `x-personal` masked. */
export function maskBySchema(value: unknown, schema: unknown): unknown {
  if (!isObject(schema) || value === null || value === undefined) return value;
  if (schema["x-personal"] === true) return PERSONAL_MASK;
  if (Array.isArray(value)) return value.map((item) => maskBySchema(item, schema.items));
  if (!isObject(value) || !isObject(schema.properties)) return value;
  const properties = schema.properties;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Object.hasOwn(properties, key) ? maskBySchema(item, properties[key]) : item]));
}
