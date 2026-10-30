import type { HttpContext } from "../../http";
import type { WorkflowActor } from "../contracts/types";

export type WorkflowAction =
  | "processes.read"
  | "processes.manage"
  | "processes.publish"
  | "instances.start"
  | "instances.read"
  | "instances.manage"
  | "events.emit"
  | "tasks.work";

/** What an action is about; the fields known for the route. */
export interface WorkflowAccessTarget {
  readonly processKey?: string;
  readonly partition?: string | null;
  readonly instanceId?: string;
  readonly taskId?: string;
}

/**
 * Rights and identity of the workflow HTTP (WORKFLOW-001 §6). The framework's
 * controllers do not know how the application signs people in, so they ask this
 * port. It is the DI token too: register the application's implementation in any
 * module, `DI.singleton(DI.classProvider(WorkflowAccess, AppWorkflowAccess))`.
 * Without one every workflow route answers 403. The services never ask it: the
 * application's code that calls them decides itself.
 */
export abstract class WorkflowAccess {
  /** Who makes the request; `undefined` answers 401. */
  abstract actor(ctx: HttpContext): WorkflowActor | undefined | Promise<WorkflowActor | undefined>;

  /** Whether the actor may do `action` on `target`; `false` answers 403. */
  abstract can(ctx: HttpContext, action: WorkflowAction, target: WorkflowAccessTarget): boolean | Promise<boolean>;

  /** Whom the user's tasks are addressed to: `user:<id>`, `role:<code>`. */
  assignees(_ctx: HttpContext, actor: WorkflowActor): readonly string[] | Promise<readonly string[]> {
    return [`user:${actor.id}`];
  }
}

/** The default: nothing is allowed until the application says otherwise. */
export class DenyWorkflowAccess extends WorkflowAccess {
  actor(): undefined {
    return undefined;
  }

  can(): boolean {
    return false;
  }
}
