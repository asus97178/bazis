import { DI, type ProviderDefinition, type ServiceCollection } from "../../di";
import { EVENT_HANDLER, type EventSubscription } from "./EventBus";
import type { EventHandler, EventToken } from "./EventToken";

/** Subscription tuning shared by {@link onEvent} / {@link addEventHandler}. */
export interface SubscribeOptions {
  /** Lower runs first; ties keep registration order. Default: 0. */
  readonly order?: number;
}

function subscription<T>(handler: EventHandler<T>, options?: SubscribeOptions): EventSubscription<never> {
  return { handle: handler as EventHandler<never>, order: options?.order ?? 0 };
}

/** Module-style subscription: drop the definition into `providers`. */
export function onEvent<T>(
  event: EventToken<T>,
  handler: EventHandler<T>,
  options?: SubscribeOptions,
): ProviderDefinition {
  return DI.keyedSingleton(event.id, DI.valueProvider(EVENT_HANDLER, subscription(handler, options)));
}

/** Collection-style subscription. */
export function addEventHandler<T>(
  services: ServiceCollection,
  event: EventToken<T>,
  handler: EventHandler<T>,
  options?: SubscribeOptions,
): void {
  services.addKeyedSingleton(event.id, DI.valueProvider(EVENT_HANDLER, subscription(handler, options)));
}
