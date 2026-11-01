import type { ConfigView } from "../../kernel";
import type { WorkflowSettings } from "../contracts/Workflow.config";

/**
 * The language of a call (WORKFLOW-002 §6): over HTTP from `Accept-Language`
 * among `workflow.languages`, otherwise `workflow.language`; in events, schedules
 * and the background always `workflow.language`.
 */
export class WorkflowLanguages {
  constructor(private readonly config: ConfigView<WorkflowSettings>) {}

  get default(): string {
    return this.config.get("language");
  }

  /** The best language of an `Accept-Language` header: by weight, then by order; `ru-RU` also finds `ru`. */
  of(header: string | undefined): string {
    if (header === undefined) return this.default;
    const known = new Set([this.default, ...this.config.get("languages").split(",").map((item) => item.trim())]);
    const wanted = header.split(",")
      .map((part, index) => {
        const [tag = "", ...parameters] = part.trim().split(";");
        const weight = parameters.map((item) => /^\s*q=([\d.]+)\s*$/.exec(item)?.[1]).find((item) => item !== undefined);
        return { tag: tag.trim(), weight: weight === undefined ? 1 : Number(weight), index };
      })
      .filter(({ tag, weight }) => tag !== "" && weight > 0)
      .sort((a, b) => b.weight - a.weight || a.index - b.index);
    for (const { tag } of wanted) {
      if (known.has(tag)) return tag;
      const base = tag.split("-")[0]!;
      if (known.has(base)) return base;
    }
    return this.default;
  }
}
