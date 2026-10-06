import { describe, expect, test } from "bun:test";
import { DI, HOSTED_SERVICE, ServiceCollection, type HostedService, type BazisModuleRef } from "../../di";
import {
  APPLICATION_STARTED,
  APPLICATION_STOPPING,
  EventBus,
  HEALTH_CHECK,
  Bazis,
  SupervisedHostedService,
  addEventHandler,
  createEventToken,
  onEvent,
  supervised,
  type ApplicationStartedEvent,
  type ApplicationStoppingEvent,
  type HealthCheck,
} from "../index";

function testBuilder(moduleRef: BazisModuleRef) {
  return Bazis.createBuilder(moduleRef).useEnvironment("test").useStartupReport(false);
}

describe("Kernel resilience", () => {
  test("health service aggregates checks; a throwing check is unhealthy, not fatal", async () => {
    const moduleRef: BazisModuleRef = {
      providers: [
        DI.singleton(
          DI.valueProvider(HEALTH_CHECK, {
            name: "db",
            check: () => ({ healthy: true, details: "connected" }),
          } satisfies HealthCheck),
        ),
        DI.singleton(
          DI.valueProvider(HEALTH_CHECK, {
            name: "cache",
            check: () => {
              throw new Error("redis down");
            },
          } satisfies HealthCheck),
        ),
      ],
    };

    const kernel = await testBuilder(moduleRef).build();
    const report = await kernel.health();
    expect(report.healthy).toBe(false);
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0]).toMatchObject({ name: "db", healthy: true, details: "connected" });
    expect(report.checks[1]).toMatchObject({ name: "cache", healthy: false, details: "redis down" });
    await kernel.stop();
  });

  test("supervised hosted service retries start with backoff and then succeeds", async () => {
    let attempts = 0;
    const retries: number[] = [];
    const service = new SupervisedHostedService(
      () => ({
        start: () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error(`attempt ${attempts} failed`);
          }
        },
        stop: () => {},
      }),
      { maxAttempts: 5, backoffMs: 1, onRetry: (attempt) => retries.push(attempt) },
    );

    await service.start();
    expect(attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
    await service.stop();
  });

  test("supervised hosted service gives up after maxAttempts", async () => {
    const service = new SupervisedHostedService(
      () => ({
        start: () => {
          throw new Error("always broken");
        },
        stop: () => {},
      }),
      { maxAttempts: 2, backoffMs: 1 },
    );

    await expect(service.start()).rejects.toThrow("always broken");
  });

  test("supervised hosted service stops every partially-started failed attempt", async () => {
    const log: string[] = [];
    let attempts = 0;
    const service = new SupervisedHostedService(
      () => {
        const attempt = ++attempts;
        return {
          start: () => {
            log.push(`start:${attempt}`);
            if (attempt < 3) throw new Error(`failed:${attempt}`);
          },
          stop: () => {
            log.push(`stop:${attempt}`);
          },
        };
      },
      { maxAttempts: 3, backoffMs: 1 },
    );

    await service.start();
    await service.stop();
    expect(log).toEqual(["start:1", "stop:1", "start:2", "stop:2", "start:3", "stop:3"]);
  });

  test("supervised() integrates with hosted services and keeps the phase", async () => {
    const log: string[] = [];
    const factory = supervised(
      () => ({
        start: () => {
          log.push("inner started");
        },
        stop: () => {
          log.push("inner stopped");
        },
      }),
      { phase: 7 },
    );
    const wrapped = factory();
    expect(wrapped.phase).toBe(7);

    const moduleRef: BazisModuleRef = {
      providers: [DI.singleton(DI.valueProvider(HOSTED_SERVICE, wrapped as HostedService))],
    };
    const kernel = await testBuilder(moduleRef).build();
    await kernel.start();
    await kernel.stop();
    expect(log).toEqual(["inner started", "inner stopped"]);
  });
});

describe("Kernel events", () => {
  test("EventBus publishes to typed handlers and aggregates failures", async () => {
    const ORDER_CREATED = createEventToken<{ id: number }>("test.order.created");
    const received: number[] = [];

    const services = new ServiceCollection();
    addEventHandler(services, ORDER_CREATED, (payload) => {
      received.push(payload.id);
    });
    addEventHandler(services, ORDER_CREATED, () => {
      throw new Error("handler one failed");
    });
    addEventHandler(services, ORDER_CREATED, (payload) => {
      received.push(payload.id * 10);
    });
    const provider = services.buildServiceProvider();
    const bus = new EventBus(provider);

    // Every handler runs even when one fails.
    await expect(bus.publish(ORDER_CREATED, { id: 7 })).rejects.toThrow("handler one failed");
    expect(received).toEqual([7, 70]);

    // No handlers: publish is a no-op.
    const EMPTY = createEventToken<void>("test.empty");
    await bus.publish(EMPTY, undefined);
    await provider.dispose();
  });

  test("kernel publishes started/stopping events to module subscribers", async () => {
    const startedEvents: ApplicationStartedEvent[] = [];
    const stoppingEvents: ApplicationStoppingEvent[] = [];

    const moduleRef: BazisModuleRef = {
      providers: [
        onEvent(APPLICATION_STARTED, (event) => {
          startedEvents.push(event);
        }),
        onEvent(APPLICATION_STOPPING, (event) => {
          stoppingEvents.push(event);
        }),
      ],
    };

    const kernel = await testBuilder(moduleRef).build();
    await kernel.start();
    await kernel.stop({ exitCode: 3, signal: "SIGTERM" });

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]?.environment).toBe("test");
    expect(startedEvents[0]?.startupMs).toBeGreaterThanOrEqual(0);
    expect(stoppingEvents).toEqual([{ signal: "SIGTERM", exitCode: 3 }]);
  });
});
