import {
  DI,
  Module,
  singleton,
  type Class,
  type OsnvModule,
  type ProviderDefinition,
  type ServiceResolver,
} from "../../di";
import { EVENT_HANDLER, type EventSubscription } from "./EventBus";
import type { EventHandler, EventToken } from "./EventToken";

// Bun runs TC39 decorators natively, but Symbol.metadata may be absent.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const SUBS_META = Symbol.for("osnv:events:subscriptions");

interface SubscriptionDecl {
  readonly eventId: symbol;
  readonly eventName: string;
  readonly methodName: string | symbol;
  readonly order: number;
}

interface SubscriptionsCarrier {
  [SUBS_META]?: SubscriptionDecl[];
}

export interface OnEventOptions {
  /** Lower runs first; ties keep registration order. Default: 0. */
  readonly order?: number;
}

/** Own (copy-on-write) subscription list — clones inherited declarations once. */
function ownSubscriptions(carrier: SubscriptionsCarrier): SubscriptionDecl[] {
  if (!Object.prototype.hasOwnProperty.call(carrier, SUBS_META)) {
    carrier[SUBS_META] = carrier[SUBS_META] ? [...carrier[SUBS_META]] : [];
  }
  return carrier[SUBS_META]!;
}

/**
 * Subscribes a method to a typed event:
 *
 * ```ts
 * class OrderProjections {
 *   @OnEvent(ORDER_CREATED)
 *   onCreated(order: OrderCreated) { ... }
 * }
 * // register the host + its subscriptions:
 * @Module({ imports: [eventsModule({ subscribers: [OrderProjections] })] })
 * class AppModule {}
 * ```
 *
 * The host is resolved through the publishing resolver, so a scoped subscriber
 * published via `EventBus.publishScoped(scope, ...)` sees that scope's services.
 */
export function OnEvent<T>(event: EventToken<T>, options?: OnEventOptions) {
  return (_value: (this: never, payload: T) => unknown, context: ClassMethodDecoratorContext): void => {
    if (context.static) {
      throw new Error("@OnEvent cannot be applied to static methods.");
    }
    ownSubscriptions(context.metadata as SubscriptionsCarrier).push({
      eventId: event.id,
      eventName: event.name,
      methodName: context.name,
      order: options?.order ?? 0,
    });
  };
}

/** Reads `@OnEvent` subscriptions declared on a class (own + inherited). */
export function eventSubscriptionsOf(ctor: object): readonly SubscriptionDecl[] {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | SubscriptionsCarrier
    | undefined;
  return metadata?.[SUBS_META] ?? [];
}

/**
 * `EVENT_HANDLER` registrations for every `@OnEvent` method of `HostClass`.
 * Does not register the host itself — register it with the lifetime you need
 * (`singleton`/`scoped`). Handlers resolve the host lazily through the
 * publishing scope, so scope-bound dependencies work with `publishScoped`.
 */
export function withEventSubscribers(HostClass: Class<unknown>): ProviderDefinition[] {
  return eventSubscriptionsOf(HostClass).map((sub) =>
    DI.keyedTransient(
      sub.eventId,
      DI.factoryProviderWithResolver(
        EVENT_HANDLER,
        [],
        (resolver: ServiceResolver): EventSubscription<never> => ({
          order: sub.order,
          handle: ((payload: never) => {
            const host = resolver.resolve(HostClass) as Record<string | symbol, (value: unknown) => unknown>;
            return host[sub.methodName]!.call(host, payload);
          }) as EventHandler<never>,
        }),
      ),
    ),
  );
}

export interface EventsModuleConfig {
  /**
   * Event subscriber classes (with `@OnEvent` methods). Each is registered as a
   * singleton with auto-resolved dependencies and wired to its events. For
   * scoped subscribers, register the class yourself and use
   * {@link withEventSubscribers} in `providers`.
   */
  readonly subscribers?: readonly Class<unknown>[];
}

/** Registers event subscribers and wires their `@OnEvent` methods to the bus. */
export function eventsModule(config: EventsModuleConfig = {}): OsnvModule {
  const providers: ProviderDefinition[] = [];
  for (const Subscriber of config.subscribers ?? []) {
    providers.push(singleton(Subscriber), ...withEventSubscribers(Subscriber));
  }

  @Module({ providers })
  class EventsModule {}

  return EventsModule;
}
