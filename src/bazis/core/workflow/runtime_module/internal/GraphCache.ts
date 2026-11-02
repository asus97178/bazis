import type { ProcessDocument, ProcessFlow, ProcessNode } from "../../../../library/workflow";

/** A version's graph with flows indexed by node. Built once per version. */
export interface ProcessGraph {
  readonly versionId: string;
  readonly processKey: string;
  readonly version: number;
  readonly document: ProcessDocument;
  readonly outgoing: ReadonlyMap<string, readonly (readonly [string, ProcessFlow])[]>;
  readonly incoming: ReadonlyMap<string, readonly (readonly [string, ProcessFlow])[]>;
  /** Boundary nodes by the step they are attached to. */
  readonly boundaries: ReadonlyMap<string, readonly (readonly [string, ProcessNode])[]>;
  /** The node an iteration begins with, by loop. */
  readonly entries: ReadonlyMap<string, string>;
}

export function buildGraph(versionId: string, processKey: string, version: number, document: ProcessDocument): ProcessGraph {
  const outgoing = new Map<string, (readonly [string, ProcessFlow])[]>();
  const incoming = new Map<string, (readonly [string, ProcessFlow])[]>();
  for (const [id, flow] of Object.entries(document.flows)) {
    outgoing.set(flow.source, [...outgoing.get(flow.source) ?? [], [id, flow]]);
    incoming.set(flow.target, [...incoming.get(flow.target) ?? [], [id, flow]]);
  }
  const boundaries = new Map<string, (readonly [string, ProcessNode])[]>();
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.attachedTo !== undefined) boundaries.set(node.attachedTo, [...boundaries.get(node.attachedTo) ?? [], [id, node]]);
  }
  const entries = new Map<string, string>();
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.parent !== undefined && node.attachedTo === undefined && !incoming.has(id)) entries.set(node.parent, id);
  }
  return { versionId, processKey, version, document, outgoing, incoming, boundaries, entries };
}

/** Graphs of versions in memory. Versions are immutable, so entries never go stale; the oldest go first past the limit. */
export class GraphCache {
  private readonly graphs = new Map<string, ProcessGraph>();

  constructor(private readonly limit = 500) {}

  get(versionId: string): ProcessGraph | undefined {
    return this.graphs.get(versionId);
  }

  set(graph: ProcessGraph): void {
    this.graphs.set(graph.versionId, graph);
    if (this.graphs.size > this.limit) this.graphs.delete(this.graphs.keys().next().value!);
  }
}
