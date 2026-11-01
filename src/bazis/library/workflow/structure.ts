import type { ProcessDiagram, ProcessDocument, ProcessFlow, ProcessNode, ProcessSettings } from "./ProcessDocument";
import type { Expr } from "./expressions";
import type { VariableSpec } from "./formFields";
import type { LocalizedText } from "./localized";
import { nodeKindOf } from "./nodeKinds";

/** One branch of a fork: the flow it leaves by and its steps. */
export interface StructureBranch {
  readonly flow: string;
  readonly title?: LocalizedText;
  readonly condition?: Expr;
  readonly isDefault?: boolean;
  /** The flow from its last step into the merge or the end; `flow` itself for an empty branch. */
  readonly exit: string;
  readonly exitTitle?: LocalizedText;
  readonly steps: readonly StructureStep[];
}

/** A boundary event of a step and what it leads to. */
export interface StructureBoundary {
  readonly id: string;
  readonly node: ProcessNode;
  readonly flow: string;
  readonly title?: LocalizedText;
  readonly steps: readonly StructureStep[];
  /** The end its branch leads to; without it the branch comes back to the step after the host. */
  readonly end?: { readonly id: string; readonly node: ProcessNode; readonly flow: string; readonly title?: LocalizedText };
  /** The flow that comes back when the branch has steps and no end of its own. */
  readonly exit?: string;
  readonly exitTitle?: LocalizedText;
}

/** A step of the list: a single node, a loop around a list, an exclusive fork or a parallel block. */
export type StructureStep =
  | {
    readonly type: "loop";
    readonly id: string;
    readonly node: ProcessNode;
    /** The steps of an iteration. */
    readonly body: readonly StructureStep[];
    /** The end of the body. */
    readonly bodyEnd: { readonly id: string; readonly node: ProcessNode };
    readonly boundaries?: readonly StructureBoundary[];
    readonly next: string;
    readonly nextTitle?: LocalizedText;
  }
  | {
    readonly type: "step";
    readonly id: string;
    readonly node: ProcessNode;
    readonly boundaries?: readonly StructureBoundary[];
    /** The flow to the next step. */
    readonly next: string;
    readonly nextTitle?: LocalizedText;
  }
  | {
    readonly type: "choice" | "parallel";
    readonly id: string;
    readonly node: ProcessNode;
    readonly branches: readonly StructureBranch[];
    /** Where the branches meet; without it they all lead to the end, and the fork is the last step of its list. */
    readonly merge?: { readonly id: string; readonly node: ProcessNode; readonly next: string; readonly nextTitle?: LocalizedText };
  };

/** A start of the list and the flow from it to the first step. */
export interface StructureStart {
  readonly id: string;
  readonly node: ProcessNode;
  readonly flow: string;
  readonly title?: LocalizedText;
}

/** A process as a designer draws it: starts, a list of steps, an end. */
export interface ProcessStructure {
  readonly variables?: readonly VariableSpec[];
  readonly settings?: ProcessSettings;
  readonly diagram?: ProcessDiagram;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly schemaVersion: ProcessDocument["schemaVersion"];
  readonly starts: readonly StructureStart[];
  readonly steps: readonly StructureStep[];
  readonly end: { readonly id: string; readonly node: ProcessNode };
}

class NotStructured extends Error {}

const titleOf = (flow: ProcessFlow) => (flow.title === undefined ? {} : { title: flow.title });

/** Reads a graph as a tree; a shape outside the subset throws {@link NotStructured}. */
class Reader {
  private readonly outgoing = new Map<string, (readonly [string, ProcessFlow])[]>();
  private readonly incoming = new Map<string, (readonly [string, ProcessFlow])[]>();
  private readonly boundaries = new Map<string, (readonly [string, ProcessNode])[]>();
  private readonly visited = new Set<string>();

  constructor(private readonly document: ProcessDocument) {
    for (const [id, flow] of Object.entries(document.flows)) {
      this.outgoing.set(flow.source, [...this.outgoing.get(flow.source) ?? [], [id, flow]]);
      this.incoming.set(flow.target, [...this.incoming.get(flow.target) ?? [], [id, flow]]);
    }
    for (const [id, node] of Object.entries(document.nodes)) {
      if (node.attachedTo !== undefined) this.boundaries.set(node.attachedTo, [...this.boundaries.get(node.attachedTo) ?? [], [id, node]]);
    }
  }

  private node(id: string): ProcessNode {
    const node = this.document.nodes[id];
    if (!node) throw new NotStructured();
    return node;
  }

  private single(id: string): readonly [string, ProcessFlow] {
    const flows = this.outgoing.get(id) ?? [];
    if (flows.length !== 1) throw new NotStructured();
    return flows[0]!;
  }

  private visit(id: string): void {
    if (this.visited.has(id)) throw new NotStructured();
    this.visited.add(id);
  }

  read(): ProcessStructure {
    const { nodes: _nodes, flows: _flows, ...rest } = this.document;
    const entries = Object.entries(this.document.nodes);
    const starts = entries.filter(([, node]) => nodeKindOf(node.kind)?.role === "start");
    if (starts.length === 0) throw new NotStructured();
    const shaped = starts.map(([id, node]) => {
      const [flow, { target, ...data }] = this.single(id);
      return { start: { id, node, flow, ...titleOf({ ...data, target }) }, target };
    });
    const first = shaped[0]!.target;
    if (shaped.some(({ target }) => target !== first)) throw new NotStructured();
    for (const { start } of shaped) this.visit(start.id);
    const { steps, stop } = this.sequence(first);
    const end = this.node(stop);
    if (nodeKindOf(end.kind)?.role !== "end") throw new NotStructured();
    this.visited.add(stop);
    if (this.visited.size !== entries.length) throw new NotStructured();
    return { ...rest, starts: shaped.map(({ start }) => start), steps, end: { id: stop, node: end } };
  }

  /** Steps from `from` up to a merge or an end, which is not taken. */
  private sequence(from: string): { readonly steps: StructureStep[]; readonly stop: string; readonly exit?: { readonly flow: string; readonly title?: LocalizedText } } {
    const steps: StructureStep[] = [];
    let current = from;
    let exit: { flow: string; title?: LocalizedText } | undefined;
    for (;;) {
      const node = this.node(current);
      const role = nodeKindOf(node.kind)?.role;
      if (role === "end") return { steps, stop: current, ...(exit === undefined ? {} : { exit }) };
      if (role === "activity") {
        this.visit(current);
        const [flowId, flow] = this.single(current);
        const boundaries = (this.boundaries.get(current) ?? []).map(([id, boundary]) => this.boundary(id, boundary, flow.target));
        const common = { id: current, node, ...(boundaries.length === 0 ? {} : { boundaries }), next: flowId, ...(flow.title === undefined ? {} : { nextTitle: flow.title }) };
        steps.push(node.kind === "loop" ? { type: "loop", ...common, ...this.body(current) } : { type: "step", ...common });
        exit = { flow: flowId, ...(flow.title === undefined ? {} : { title: flow.title }) };
        current = flow.target;
        continue;
      }
      if (role !== "gateway") throw new NotStructured();
      const outs = this.outgoing.get(current) ?? [];
      // A join: whoever walks here stops; the fork that owns it goes on from it.
      if (outs.length === 1) return { steps, stop: current, ...(exit === undefined ? {} : { exit }) };
      const { step, stop } = this.fork(current, node, outs);
      steps.push(step);
      if (step.merge === undefined) return { steps, stop };
      exit = { flow: step.merge.next, ...(step.merge.nextTitle === undefined ? {} : { title: step.merge.nextTitle }) };
      current = this.document.flows[step.merge.next]!.target;
    }
  }

  /** The body of a loop: a list from its one entry to its one end. */
  private body(loop: string): { readonly body: StructureStep[]; readonly bodyEnd: { readonly id: string; readonly node: ProcessNode } } {
    const members = Object.entries(this.document.nodes).filter(([, node]) => node.parent === loop && node.attachedTo === undefined);
    const entries = members.filter(([id]) => (this.incoming.get(id)?.length ?? 0) === 0);
    if (entries.length !== 1) throw new NotStructured();
    const { steps, stop } = this.sequence(entries[0]![0]);
    const end = this.node(stop);
    if (nodeKindOf(end.kind)?.role !== "end" || end.parent !== loop || steps.length === 0) throw new NotStructured();
    this.visited.add(stop);
    return { body: steps, bodyEnd: { id: stop, node: end } };
  }

  private fork(id: string, node: ProcessNode, outs: readonly (readonly [string, ProcessFlow])[]): { readonly step: Extract<StructureStep, { type: "choice" | "parallel" }>; readonly stop: string } {
    if ((this.incoming.get(id)?.length ?? 0) !== 1) throw new NotStructured();
    this.visit(id);
    let merge: string | undefined;
    const branches = outs.map(([flowId, flow]): StructureBranch => {
      const { steps, stop, exit } = this.sequence(flow.target);
      if (merge !== undefined && merge !== stop) throw new NotStructured();
      merge = stop;
      return {
        flow: flowId,
        ...titleOf(flow),
        ...(flow.condition === undefined ? {} : { condition: flow.condition }),
        ...(flow.isDefault === undefined ? {} : { isDefault: flow.isDefault }),
        exit: exit?.flow ?? flowId,
        ...(exit?.title === undefined ? {} : { exitTitle: exit.title }),
        steps,
      };
    });
    const type = node.kind === "parallelGateway" ? "parallel" : "choice";
    const mergeNode = this.node(merge!);
    if (nodeKindOf(mergeNode.kind)?.role === "end") return { step: { type, id, node, branches }, stop: merge! };
    if (mergeNode.kind !== node.kind) throw new NotStructured();
    this.visit(merge!);
    const [next, nextFlow] = this.single(merge!);
    return { step: { type, id, node, branches, merge: { id: merge!, node: mergeNode, next, ...(nextFlow.title === undefined ? {} : { nextTitle: nextFlow.title }) } }, stop: merge! };
  }

  private boundary(id: string, node: ProcessNode, after: string): StructureBoundary {
    this.visit(id);
    const [flow, data] = this.single(id);
    const base = { id, node, flow, ...titleOf(data) };
    if (data.target === after) return { ...base, steps: [] };
    const { steps, stop, exit } = this.sequence(data.target);
    const stopNode = this.node(stop);
    if (stop === after) {
      if (exit === undefined) throw new NotStructured();
      return { ...base, steps, exit: exit.flow, ...(exit.title === undefined ? {} : { exitTitle: exit.title }) };
    }
    // An end: its own, or the end of the process. A list without steps leads to it by the boundary's own flow.
    if (nodeKindOf(stopNode.kind)?.role !== "end") throw new NotStructured();
    this.visited.add(stop);
    const last = exit ?? { flow, ...titleOf(data) };
    return { ...base, steps, end: { id: stop, node: stopNode, flow: last.flow, ...(last.title === undefined ? {} : { title: last.title }) } };
  }
}

/**
 * A graph as a tree of steps, or `undefined` when it is outside the subset a
 * list can draw (WORKFLOW-002 §3.6): sequences, an exclusive gateway with one
 * merge, a parallel gateway with a join, a loop, boundary events on steps.
 */
export function toStructure(document: ProcessDocument): ProcessStructure | undefined {
  try {
    return new Reader(document).read();
  } catch (error) {
    if (error instanceof NotStructured) return undefined;
    throw error;
  }
}

/** Whether a designer can edit the process as a list. Otherwise it shows the graph read only. */
export function isStructured(document: ProcessDocument): boolean {
  return toStructure(document) !== undefined;
}

/** A tree of steps as a graph: `fromStructure(toStructure(d))` has the nodes and flows of `d`. */
export function fromStructure(structure: ProcessStructure): ProcessDocument {
  const { starts, steps, end, ...rest } = structure;
  const nodes: Record<string, ProcessNode> = {};
  const flows: Record<string, ProcessFlow> = {};
  const flow = (id: string, source: string, target: string, data: Partial<ProcessFlow> = {}) => {
    flows[id] = { source, target, ...data };
  };
  const titled = (title: LocalizedText | undefined) => (title === undefined ? {} : { title });

  /** The first node of a list, or where it goes when it is empty. */
  const entry = (list: readonly StructureStep[], after: string) => list[0]?.id ?? after;

  /** Writes a list that leads to `after`; `leave` writes the flow out of its last step. */
  const write = (list: readonly StructureStep[], after: string, leave?: { readonly flow: string; readonly title?: LocalizedText }) => {
    list.forEach((step, index) => {
      const target = index + 1 < list.length ? list[index + 1]!.id : after;
      const last = index + 1 === list.length && leave !== undefined;
      nodes[step.id] = step.node;
      if (step.type === "step" || step.type === "loop") {
        flow(last ? leave.flow : step.next, step.id, target, titled(last ? leave.title : step.nextTitle));
        for (const boundary of step.boundaries ?? []) writeBoundary(boundary, step, target);
        if (step.type === "loop") {
          write(step.body, step.bodyEnd.id);
          nodes[step.bodyEnd.id] = step.bodyEnd.node;
        }
        return;
      }
      const meet = step.merge?.id ?? target;
      for (const branch of step.branches) {
        const { flow: id, title, condition, isDefault, steps: inner, exit, exitTitle } = branch;
        flow(id, step.id, entry(inner, meet), { ...titled(title), ...(condition === undefined ? {} : { condition }), ...(isDefault === undefined ? {} : { isDefault }) });
        write(inner, meet, inner.length === 0 ? undefined : { flow: exit, ...(exitTitle === undefined ? {} : { title: exitTitle }) });
      }
      if (step.merge === undefined) return;
      nodes[step.merge.id] = step.merge.node;
      flow(last ? leave.flow : step.merge.next, step.merge.id, target, titled(last ? leave.title : step.merge.nextTitle));
    });
  };

  const writeBoundary = (boundary: StructureBoundary, _host: StructureStep, after: string) => {
    nodes[boundary.id] = boundary.node;
    const target = boundary.end?.id ?? after;
    flow(boundary.flow, boundary.id, entry(boundary.steps, target), titled(boundary.title));
    if (boundary.end !== undefined) nodes[boundary.end.id] = boundary.end.node;
    const leave = boundary.end !== undefined
      ? { flow: boundary.end.flow, ...(boundary.end.title === undefined ? {} : { title: boundary.end.title }) }
      : boundary.exit === undefined ? undefined : { flow: boundary.exit, ...(boundary.exitTitle === undefined ? {} : { title: boundary.exitTitle }) };
    write(boundary.steps, target, boundary.steps.length === 0 ? undefined : leave);
  };

  const first = entry(steps, end.id);
  for (const start of starts) {
    nodes[start.id] = start.node;
    flow(start.flow, start.id, first, titled(start.title));
  }
  write(steps, end.id);
  nodes[end.id] = end.node;
  return { ...rest, nodes, flows };
}

