import { HttpSetupError } from "../Errors/HttpError";
import { INVALID, tryConvert } from "../Binding/convert";

/** Route constraint: validates and converts a path segment. */
export interface SegmentConstraint {
  readonly name: string;
  convert(segment: string): string | number | boolean | typeof INVALID;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONSTRAINTS: Record<string, SegmentConstraint> = {
  int: { name: "int", convert: (s) => tryConvert(s, "int") },
  number: { name: "number", convert: (s) => tryConvert(s, "number") },
  bool: { name: "bool", convert: (s) => tryConvert(s, "bool") },
  uuid: { name: "uuid", convert: (s) => (UUID_SEGMENT.test(s) ? s : INVALID) },
  alpha: { name: "alpha", convert: (s) => (/^[a-z]+$/i.test(s) ? s : INVALID) },
};

export type TemplateSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly name: string; readonly constraint?: SegmentConstraint }
  | { readonly kind: "wildcard"; readonly name: string };

const PARAM_PATTERN = /^:([A-Za-z_][A-Za-z0-9_]*)(?:\(([a-z]+)\))?$/;
const FORBIDDEN_PARAM_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** Joins path fragments into one normalized template ("a", "/b/" -> "a/b"). */
export function joinPaths(...fragments: (string | undefined)[]): string {
  const parts: string[] = [];
  for (const fragment of fragments) {
    if (!fragment) {
      continue;
    }
    for (const piece of fragment.split("/")) {
      if (piece !== "") {
        parts.push(piece);
      }
    }
  }
  return parts.join("/");
}

/**
 * Parses a route template into segments. Fails fast (at startup) on bad
 * templates: unknown constraints, wildcard not in last position, parameter
 * names that could pollute prototypes.
 */
export function parseTemplate(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  const rawSegments = template.split("/").filter((segment) => segment !== "");
  for (let index = 0; index < rawSegments.length; index += 1) {
    const raw = rawSegments[index]!;
    if (raw.startsWith(":")) {
      const match = PARAM_PATTERN.exec(raw);
      if (!match) {
        throw new HttpSetupError(`Invalid route parameter "${raw}" in template "${template}".`);
      }
      const name = match[1]!;
      if (FORBIDDEN_PARAM_NAMES.has(name)) {
        throw new HttpSetupError(`Forbidden route parameter name "${name}" in template "${template}".`);
      }
      let constraint: SegmentConstraint | undefined;
      if (match[2] !== undefined) {
        constraint = CONSTRAINTS[match[2]];
        if (!constraint) {
          throw new HttpSetupError(
            `Unknown route constraint "(${match[2]})" in template "${template}". Known: ${Object.keys(CONSTRAINTS).join(", ")}.`,
          );
        }
      }
      segments.push({ kind: "param", name, constraint });
    } else if (raw.startsWith("*")) {
      if (index !== rawSegments.length - 1) {
        throw new HttpSetupError(`Wildcard "*" must be the last segment in template "${template}".`);
      }
      const name = raw.length > 1 ? raw.slice(1) : "rest";
      if (FORBIDDEN_PARAM_NAMES.has(name)) {
        throw new HttpSetupError(`Forbidden wildcard name "${name}" in template "${template}".`);
      }
      segments.push({ kind: "wildcard", name });
    } else {
      segments.push({ kind: "static", value: raw });
    }
  }
  return segments;
}

/**
 * Splits and decodes a request path into segments.
 * Returns `undefined` for malformed/unsafe paths (bad percent-encoding,
 * `..` traversal attempts) — the server answers 400.
 */
export function parseRequestPath(pathname: string): string[] | undefined {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw === "") {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (decoded === ".." || decoded === "." || decoded.includes("\0")) {
      return undefined;
    }
    segments.push(decoded);
  }
  return segments;
}
