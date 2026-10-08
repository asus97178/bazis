import type { HttpMiddleware } from "../Middleware/types";
import { HttpSetupError } from "../Errors/HttpError";
import { INVALID } from "../Binding/convert";
import type { SegmentConstraint, TemplateSegment } from "./template";

/** A fully compiled route endpoint: its middleware chain runs the action. */
export interface RouteAction {
  /** Precompiled pipeline: [server-level, global, controller, route, terminal]. */
  readonly chain: readonly HttpMiddleware[];
  /** Declared API version (diagnostics). */
  readonly version?: string;
  /** Debug name: Controller.method. */
  readonly name: string;
  /** Action-specific body cap in bytes; undefined inherits the server cap. */
  readonly maxBodyBytes?: number;
}

interface RouteEntry {
  readonly action: RouteAction;
  /** The registered path, for diagnostics: `/tasks/:id`. */
  readonly template: string;
  /** Names belong to the selected declaration, never to shared tree edges. */
  readonly bindings: readonly { readonly name: string; readonly index: number }[];
}

/** method -> (versionKey -> entry); "" is unversioned, "*" matches any method. */
type RouteLeaf = Map<string, Map<string, RouteEntry>>;

interface ParamEdge {
  readonly constraint?: SegmentConstraint;
  readonly node: RouteNode;
}

class RouteNode {
  statics?: Map<string, RouteNode>;
  params?: ParamEdge[];
  wildcard?: { leaf: RouteLeaf };
  leaf?: RouteLeaf;
}

export type RouteParamsBag = Record<string, string | number | boolean>;

export type MatchResult =
  | { kind: "matched"; action: RouteAction; params: RouteParamsBag }
  | { kind: "method-not-allowed"; allow: readonly string[] }
  | { kind: "unsupported-version"; supported: readonly string[] }
  | { kind: "not-found" };

/**
 * Radix-style route tree. Segments are matched with priority
 * static > constrained param > param > wildcard, with backtracking, so the
 * most specific route always wins regardless of registration order.
 * Captures are indexed by path position and named only after method/version
 * selection, so overlapping declarations cannot change each other's params.
 */
export class Router {
  private readonly root = new RouteNode();

  /** Registers a parsed template. Duplicate (path, method, version) -> startup error. */
  register(segments: readonly TemplateSegment[], httpMethod: string, versionKey: string, action: RouteAction): void {
    const entry: RouteEntry = {
      action,
      template: renderTemplate(segments),
      bindings: segments.flatMap((segment, index) => segment.kind === "static" ? [] : [{ name: segment.name, index }]),
    };
    let node = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (segment.kind === "static") {
        node.statics ??= new Map();
        let child = node.statics.get(segment.value);
        if (!child) {
          child = new RouteNode();
          node.statics.set(segment.value, child);
        }
        node = child;
      } else if (segment.kind === "param") {
        node.params ??= [];
        let edge = node.params.find(
          (candidate) => candidate.constraint?.name === segment.constraint?.name,
        );
        if (!edge) {
          edge = { constraint: segment.constraint, node: new RouteNode() };
          node.params.push(edge);
          // Keep overlap resolution deterministic: constrained before plain,
          // and integer before the broader number constraint.
          node.params.sort((left, right) => constraintPriority(right.constraint) - constraintPriority(left.constraint));
        }
        node = edge.node;
      } else {
        node.wildcard ??= { leaf: new Map() };
        this.addToLeaf(node.wildcard.leaf, httpMethod, versionKey, entry);
        return;
      }
    }
    node.leaf ??= new Map();
    this.addToLeaf(node.leaf, httpMethod, versionKey, entry);
  }

  private addToLeaf(leaf: RouteLeaf, httpMethod: string, versionKey: string, entry: RouteEntry): void {
    let versions = leaf.get(httpMethod);
    if (!versions) {
      versions = new Map();
      leaf.set(httpMethod, versions);
    }
    if (versions.has(versionKey)) {
      const existing = versions.get(versionKey)!;
      const version = versionKey ? ` (version ${versionKey})` : "";
      throw new HttpSetupError(
        `Duplicate route: ${httpMethod} ${entry.template}${version} is mapped to both ${existing.action.name} (${existing.template}) and ${entry.action.name}. `
          + "Routes that differ only in parameter names are the same route; change one of the paths.",
      );
    }
    versions.set(versionKey, entry);
  }

  /**
   * @param requestedVersion Version resolved from the request (query/header
   *   sources) or `undefined`. URL-source versions are part of the path.
   */
  match(httpMethod: string, segments: readonly string[], requestedVersion?: string): MatchResult {
    const captures: (string | number | boolean)[] = [];
    const leaf = this.descend(this.root, segments, 0, captures);
    if (!leaf) {
      return { kind: "not-found" };
    }
    // HEAD falls back to a GET handler (the server strips the body); explicit
    // HEAD routes still win. "*" (@All) matches any method last.
    const versions =
      leaf.get(httpMethod) ?? (httpMethod === "HEAD" ? leaf.get("GET") : undefined) ?? leaf.get("*");
    if (!versions) {
      const allow = [...leaf.keys()].filter((method) => method !== "*");
      if (allow.includes("GET") && !allow.includes("HEAD")) {
        allow.push("HEAD");
      }
      return { kind: "method-not-allowed", allow };
    }
    const entry =
      requestedVersion !== undefined ? (versions.get(requestedVersion) ?? versions.get("")) : versions.get("");
    if (!entry) {
      return { kind: "unsupported-version", supported: [...versions.keys()].filter((key) => key !== "") };
    }
    const params: RouteParamsBag = Object.create(null) as RouteParamsBag;
    for (const { name, index } of entry.bindings) {
      params[name] = captures[index]!;
    }
    return { kind: "matched", action: entry.action, params };
  }

  private descend(node: RouteNode, segments: readonly string[], index: number, captures: (string | number | boolean)[]): RouteLeaf | undefined {
    if (index === segments.length) {
      if (node.leaf) {
        return node.leaf;
      }
      // A trailing wildcard also matches the empty rest ("files" -> "files/*path").
      if (node.wildcard) {
        captures[index] = "";
        return node.wildcard.leaf;
      }
      return undefined;
    }
    const segment = segments[index]!;

    const staticChild = node.statics?.get(segment);
    if (staticChild) {
      const leaf = this.descend(staticChild, segments, index + 1, captures);
      if (leaf) {
        return leaf;
      }
    }

    if (node.params) {
      for (const edge of node.params) {
        const value = edge.constraint ? edge.constraint.convert(segment) : segment;
        if (value === INVALID) {
          continue;
        }
        captures[index] = value;
        const leaf = this.descend(edge.node, segments, index + 1, captures);
        if (leaf) {
          return leaf;
        }
      }
    }

    if (node.wildcard) {
      captures[index] = segments.slice(index).join("/");
      return node.wildcard.leaf;
    }
    return undefined;
  }
}

function constraintPriority(constraint: SegmentConstraint | undefined): number {
  switch (constraint?.name) {
    case "int":
      return 30;
    case "uuid":
    case "bool":
    case "alpha":
      return 20;
    case "number":
      return 10;
    default:
      return 0;
  }
}

/** `/tasks/:id(int)/files/*path` from parsed segments. */
function renderTemplate(segments: readonly TemplateSegment[]): string {
  return `/${segments.map((segment) => segment.kind === "static" ? segment.value
    : segment.kind === "param" ? `:${segment.name}${segment.constraint ? `(${segment.constraint.name})` : ""}`
    : `*${segment.name}`).join("/")}`;
}
