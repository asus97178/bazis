/** Parsed module name for scaffold file/class naming. */
export interface ModuleNaming {
  /** CLI input as given (trimmed). */
  readonly input: string;
  /** Folder under `modules/` — lowercase (`user`, `order-item`). */
  readonly folder: string;
  /** PascalCase singular entity (`User`, `OrderItem`). */
  readonly entity: string;
  /** HTTP route segment, usually plural (`users`, `order-items`). */
  readonly route: string;
  /** DbContext collection property (`users`, `orderItems`). */
  readonly collection: string;
  /** `{Entity}Module` class name. */
  readonly moduleClass: string;
  /** API list base path segment (`/api/users`). */
  readonly apiBasePath: string;
  /** PostgreSQL schema (имя папки модуля, `-` → `_`). */
  readonly dbSchema: string;
}

const SINGULAR_TO_PLURAL: Readonly<Record<string, string>> = {
  person: "people",
  child: "children",
  man: "men",
  woman: "women",
  status: "statuses",
  bus: "buses",
  analysis: "analyses",
};

const PLURAL_TO_SINGULAR: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(SINGULAR_TO_PLURAL).map(([singular, plural]) => [plural, singular])),
);

/** Converts `user`, `User`, `users` → consistent naming for scaffold. */
export function parseModuleName(raw: string): ModuleNaming {
  const input = raw.trim();
  if (input.length === 0) {
    throw new Error("Module name is required.");
  }
  if (!/^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*$/.test(input)) {
    throw new Error(`Invalid module name "${input}". Use letters, digits, and hyphens only.`);
  }

  const parts = input
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split("-")
    .filter((part) => part.length > 0);

  const folder = parts.join("-");
  const singular = toSingular(parts);
  const entity = singular.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  const route = toRoute(singular);
  const collection = toCamelPlural(singular);

  return {
    input,
    folder,
    entity,
    route,
    collection,
    moduleClass: `${entity}Module`,
    apiBasePath: `/api/${route}`,
    dbSchema: folder.replace(/-/g, "_"),
  };
}

function toSingular(parts: readonly string[]): readonly string[] {
  if (parts.length === 0) {
    return parts;
  }
  const last = parts[parts.length - 1] as string;
  const lower = last.toLowerCase();

  if (Object.hasOwn(PLURAL_TO_SINGULAR, lower)) {
    return [...parts.slice(0, -1), PLURAL_TO_SINGULAR[lower] as string];
  }
  if (lower.endsWith("ies") && lower.length > 3) {
    return [...parts.slice(0, -1), `${lower.slice(0, -3)}y`];
  }
  if (/(?:ches|shes|xes|zes|sses)$/.test(lower)) {
    return [...parts.slice(0, -1), lower.slice(0, -2)];
  }
  if (lower.endsWith("s") && lower.length > 1 && !/(?:ss|us|is)$/.test(lower)) {
    return [...parts.slice(0, -1), lower.slice(0, -1)];
  }
  return parts;
}

function toRoute(parts: readonly string[]): string {
  const last = parts[parts.length - 1] as string;
  const lower = last.toLowerCase();

  if (Object.hasOwn(SINGULAR_TO_PLURAL, lower)) {
    return [...parts.slice(0, -1), SINGULAR_TO_PLURAL[lower] as string].join("-");
  }
  if (/[^aeiou]y$/.test(lower)) {
    return [...parts.slice(0, -1), `${lower.slice(0, -1)}ies`].join("-");
  }
  if (/(?:s|x|z|ch|sh)$/.test(lower)) {
    return [...parts.slice(0, -1), `${lower}es`].join("-");
  }
  return [...parts.slice(0, -1), `${lower}s`].join("-");
}

function toCamelPlural(parts: readonly string[]): string {
  const routeParts = toRoute(parts).split("-");
  return routeParts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}
