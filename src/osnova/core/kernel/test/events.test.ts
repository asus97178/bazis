import { describe, expect, test } from "bun:test";
import { DI, Module, ServiceCollection, createContainer } from "../../di";
import {
  EventBus,
  EventHandlerTimeoutError,
  OnEvent,
  addEventHandler,
  createEventToken,
  eventsModule,
  withEventSubscribers,
} from "../index";

describe("EventBus: ordering", () => {
  test("handlers run low-to-high order; ties keep registration order", async () => {
    const EVT = createEventToken<void>("test.order");
    const log: string[] = [];
    const services = new ServiceCollection();
    addEventHandler(services, EVT, () => void log.push("late"), { order: 10 });
    addEventHandler(services, EVT, () => void log.push("early"), { order: -5 });
    addEventHandler(services, EVT, () => void log.push("mid-1")); // order 0
    addEventHandler(services, EVT, () => void log.push("mid-2")); // order 0, after mid-1
    const provider = services.buildServiceProvider();

    await new EventBus(provider).publish(EVT, undefined);

    expect(log).toEqual(["early", "mid-1", "mid-2", "late"]);
    await provider.dispose();
  });
});

describe("EventBus: error policy", () => {
  test("isolate=true never throws and reports failures via onError", async () => {
    const EVT = createEventToken<void>("test.isolate");
    const errors: unknown[] = [];
    let ran = 0;
    const services = new ServiceCollection();
    addEventHandler(services, EVT, () => {
      throw new Error("boom");
    });
    addEventHandler(services, EVT, () => void (ran += 1));
    const provider = services.buildServiceProvider();

    await new EventBus(provider).publish(EVT, undefined, { isolate: true, onError: (e) => errors.push(e) });

    expect(ran).toBe(1); // later handler still ran
    expect(errors).toHaveLength(1);
    await provider.dispose();
  });

  test("default mode calls onError and still rejects", async () => {
    const EVT = createEventToken<void>("test.throwing");
    let observed = 0;
    const services = new ServiceCollection();
    addEventHandler(services, EVT, () => {
      throw new Error("kaboom");
    });
    const provider = services.buildServiceProvider();

    await expect(
      new EventBus(provider).publish(EVT, undefined, { onError: () => (observed += 1) }),
    ).rejects.toThrow("kaboom");
    expect(observed).toBe(1);
    await provider.dispose();
  });

  test("a throwing onError observer does not stop later event handlers", async () => {
    const EVT = createEventToken<void>("test.throwing-observer");
    let laterRan = false;
    const services = new ServiceCollection();
    addEventHandler(services, EVT, () => {
      throw new Error("handler failed");
    });
    addEventHandler(services, EVT, () => {
      laterRan = true;
    });
    const provider = services.buildServiceProvider();

    await expect(
      new EventBus(provider).publish(EVT, undefined, {
        onError: () => {
          throw new Error("observer failed");
        },
      }),
    ).rejects.toThrow("handlers failed");
    expect(laterRan).toBe(true);
    await provider.dispose();
  });

  test("handlerTimeoutMs fails a slow handler", async () => {
    const EVT = createEventToken<void>("test.timeout");
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    const services = new ServiceCollection();
    addEventHandler(
      services,
      EVT,
      () => new Promise<void>((resolve) => (slowTimer = setTimeout(resolve, 500))),
    );
    const provider = services.buildServiceProvider();

    await expect(new EventBus(provider).publish(EVT, undefined, { handlerTimeoutMs: 20 })).rejects.toThrow(
      EventHandlerTimeoutError,
    );

    if (slowTimer !== undefined) {
      clearTimeout(slowTimer);
    }
    await provider.dispose();
  });
});

const SCOPED_EVENT = createEventToken<{ tag: string }>("test.scoped");

class RequestState {
  public tag = "unset";
}

class Projector {
  public constructor(private readonly state: RequestState) {}

  @OnEvent(SCOPED_EVENT)
  public onCreated(payload: { tag: string }): void {
    this.state.tag = payload.tag;
  }
}

describe("EventBus: scope-aware publish", () => {
  test("publishScoped resolves subscribers within the given scope", async () => {
    @Module({
      providers: [
        DI.scoped(DI.classProvider(RequestState, RequestState, [])),
        DI.scoped(DI.classProvider(Projector, Projector, [RequestState])),
        ...withEventSubscribers(Projector),
        DI.singleton(DI.factoryProviderWithResolver(EventBus, [], (resolver) => new EventBus(resolver))),
      ],
    })
    class AppModule {}

    const container = createContainer(AppModule, { validateOnBuild: true });
    const bus = container.resolve(EventBus);

    const scopeA = container.createScope();
    const scopeB = container.createScope();

    await bus.publishScoped(scopeA, SCOPED_EVENT, { tag: "A" });
    expect(scopeA.resolve(RequestState).tag).toBe("A");
    expect(scopeB.resolve(RequestState).tag).toBe("unset"); // isolated per scope

    await bus.publishScoped(scopeB, SCOPED_EVENT, { tag: "B" });
    expect(scopeB.resolve(RequestState).tag).toBe("B");
    expect(scopeA.resolve(RequestState).tag).toBe("A"); // unchanged

    await scopeA.dispose();
    await scopeB.dispose();
  });
});

const MODULE_EVT = createEventToken<{ n: number }>("test.module");

class Listener {
  public static seen: number[] = [];

  @OnEvent(MODULE_EVT, { order: 1 })
  public second(payload: { n: number }): void {
    Listener.seen.push(payload.n + 1);
  }

  @OnEvent(MODULE_EVT, { order: 0 })
  public first(payload: { n: number }): void {
    Listener.seen.push(payload.n);
  }
}

describe("@OnEvent + eventsModule", () => {
  test("registers a subscriber and dispatches in order", async () => {
    Listener.seen = [];

    @Module({
      imports: [eventsModule({ subscribers: [Listener] })],
      providers: [DI.singleton(DI.factoryProviderWithResolver(EventBus, [], (resolver) => new EventBus(resolver)))],
    })
    class AppModule {}

    const container = createContainer(AppModule, { validateOnBuild: true });
    await container.resolve(EventBus).publish(MODULE_EVT, { n: 10 });

    expect(Listener.seen).toEqual([10, 11]); // order 0 before order 1
  });
});
