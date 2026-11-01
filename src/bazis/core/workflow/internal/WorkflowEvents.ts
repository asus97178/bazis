import type { ServiceProvider } from "../../di";
import { EventBus, type EventToken, type Logger } from "../../kernel";

/**
 * Publishes the events of the workflow services after their action is saved, in
 * the scope of the action. A failing handler is logged: the action stands.
 */
export class WorkflowEvents {
  constructor(
    private readonly bus: EventBus,
    /** Event handlers run in this scope. */
    private readonly scope: ServiceProvider,
    private readonly logger?: Logger,
  ) {}

  async publish<T>(event: EventToken<T>, payload: T): Promise<void> {
    try {
      await this.bus.publishScoped(this.scope, event, payload);
    } catch (error) {
      this.logger?.error("workflow event handler failed", { event: event.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
