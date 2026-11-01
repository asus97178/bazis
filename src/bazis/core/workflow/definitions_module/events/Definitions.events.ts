import { createEventToken } from "../../../kernel";
import type { WorkflowActor, WorkflowRequest } from "../../contracts/types";

export type ProcessChange = "created" | "updated" | "draftSaved" | "published" | "archived" | "restored";

/** A process of the catalog changed, for the application's audit. Published after the commit. */
export interface WorkflowProcessChanged {
  readonly change: ProcessChange;
  readonly key: string;
  /** The version a `published` change made; otherwise `null`. */
  readonly version: number | null;
  readonly actor: WorkflowActor;
  readonly request: WorkflowRequest | null;
}

export const WORKFLOW_PROCESS_CHANGED = createEventToken<WorkflowProcessChanged>("workflow.process-changed");
