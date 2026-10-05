import type { BackgroundServiceOptions, PeriodicBackgroundServiceOptions } from "./BackgroundService";

// Bun runs TC39 decorators natively, but Symbol.metadata may be absent in the
// runtime — the same one-line polyfill used by the http/validation modules.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

const BG_META = Symbol.for("osnv:background:options");

/** Options accepted by {@link Background}; a superset covering periodic tasks. */
export type BackgroundDecoratorOptions = BackgroundServiceOptions &
  Partial<Pick<PeriodicBackgroundServiceOptions, "intervalMs" | "runImmediately">>;

interface BackgroundMetadataCarrier {
  [BG_META]?: BackgroundDecoratorOptions;
}

/**
 * Declares background-service options on the class, so subclasses of
 * `BackgroundService` / `PeriodicBackgroundService` need no `super({...})`:
 *
 * ```ts
 * @Background({ intervalMs: 15_000, restart: { maxRestarts: 3 } })
 * class Heartbeat extends PeriodicBackgroundService {
 *   protected async tick() { await this.api.post("/heartbeat"); }
 * }
 * ```
 *
 * Options passed explicitly to `super(...)` take precedence over the decorator.
 * Registration stays explicit — list the class in `backgroundModule({ services })`.
 */
export function Background(options: BackgroundDecoratorOptions = {}) {
  return (_value: abstract new (...args: never[]) => unknown, context: ClassDecoratorContext): void => {
    (context.metadata as BackgroundMetadataCarrier)[BG_META] = options;
  };
}

/** Reads {@link Background} options off a class (undefined if not decorated). */
export function backgroundOptionsOf(ctor: object): BackgroundDecoratorOptions | undefined {
  const metadata = (ctor as { [key: symbol]: unknown })[Symbol.metadata as unknown as symbol] as
    | BackgroundMetadataCarrier
    | undefined;
  return metadata?.[BG_META];
}
