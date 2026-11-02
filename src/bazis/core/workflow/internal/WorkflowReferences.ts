import { IAccessCatalog } from "../../access";
import type { ServiceProvider } from "../../di";
import { documentReferences, schemaReferenceKinds, type DocumentReference, type InputReference, type ProcessDocument } from "../../../library/workflow";
import type { WorkflowTools } from "./WorkflowTools";

/** Whose references: the partition of the instance, when there is one. */
export interface ReferenceCheckContext {
  readonly scope: string | null;
  readonly language: string;
}

/**
 * Asks the owners of reference kinds (ACCESS-001 §6) about the references of
 * processes (WORKFLOW-002 §6.3). The owners are resolved in the scope of the call.
 */
export class WorkflowReferences {
  constructor(
    private readonly catalog: IAccessCatalog,
    private readonly tools: WorkflowTools,
    private readonly services: ServiceProvider,
  ) {}

  /** The input schema of a Tool, in JSON Schema, if the Tool has one. */
  inputSchemaOf(tool: string): unknown {
    const input = this.tools.bound?.describe(tool)?.input;
    return input?.kind === "json-schema" ? input.schema : undefined;
  }

  /** The literal references of a document. */
  of(document: ProcessDocument): DocumentReference[] {
    return documentReferences(document, (tool) => this.inputSchemaOf(tool));
  }

  /** Reference kinds the Tools name and no module owns: the application is built wrong. */
  unownedToolKinds(): readonly { readonly tool: string; readonly kind: string }[] {
    const found: { tool: string; kind: string }[] = [];
    for (const contract of this.tools.list()) {
      const schema = contract.input?.kind === "json-schema" ? contract.input.schema : undefined;
      for (const kind of schemaReferenceKinds(schema)) if (!this.owned(kind)) found.push({ tool: contract.name, kind });
    }
    return found;
  }

  owned(kind: string): boolean {
    return this.catalog.referenceKind(kind) !== undefined;
  }

  /** Those of `references` their owners do not know. A kind nobody owns is reported as not found. */
  async missing<T extends InputReference>(references: readonly T[], context: ReferenceCheckContext): Promise<readonly T[]> {
    const groups = new Map<string, T[]>();
    for (const reference of references) {
      const key = JSON.stringify([reference.kind, reference.within ?? null]);
      groups.set(key, [...groups.get(key) ?? [], reference]);
    }
    const out: T[] = [];
    for (const group of groups.values()) {
      const { kind, within } = group[0]!;
      const owner = this.catalog.referenceKind(kind);
      if (owner === undefined) {
        out.push(...group);
        continue;
      }
      const ids = [...new Set(group.map((reference) => reference.id))];
      const known = await this.services.resolve(owner.type).exists(ids, { scope: context.scope, language: context.language, ...(within === undefined ? {} : { within }) });
      out.push(...group.filter((reference) => !known.has(reference.id)));
    }
    return out;
  }
}
