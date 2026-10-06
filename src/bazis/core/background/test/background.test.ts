import { describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer, type HostedService } from "@/core/di";
import {
  Background,
  BackgroundService,
  PeriodicBackgroundService,
  backgroundModule,
  delay,
} from "@/core/background";

describe("BackgroundService: lifecycle", () => {
  test("start is non-blocking and the loop runs until stop", async () => {
    class Counter extends BackgroundService {
      public ticks = 0;
      public constructor() {
        super({ stopTimeoutMs: 1000 });
      }
      protected async execute(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
          this.ticks += 1;
          await delay(5, signal);
        }
      }
    }

    const service = new Counter();
    service.start(); // returns immediately
    await Bun.sleep(30);
    const midway = service.ticks;
    await service.stop();
    const afterStop = service.ticks;
    await Bun.sleep(20);

    expect(midway).toBeGreaterThan(0);
    expect(service.ticks).toBe(afterStop); // no ticks after stop
  });

  test("stop aborts a long sleep promptly (cooperative cancellation)", async () => {
    class Sleeper extends BackgroundService {
      public finished = false;
      protected async execute(signal: AbortSignal): Promise<void> {
        await delay(10_000, signal);
        this.finished = true;
      }
    }

    const service = new Sleeper();
    service.start();
    await Bun.sleep(5);
    const startedAt = performance.now();
    await service.stop();
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(service.finished).toBe(true);
  });
});

describe("BackgroundService: restart-on-crash", () => {
  test.each(["throw", "reject", "thenable", "broken-sink"] as const)("a %s diagnostic cannot stop restarts or escape as an unhandled rejection", async failure => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      if (failure === "broken-sink") throw new Error("sink failure");
      logged.push(args);
    };
    const observerFailure = new Error("token=observer-secret");
    class Crasher extends BackgroundService {
      runs = 0;
      constructor() {
        super({ restart: { maxRestarts: 2, backoffMs: 1, onError: () => {
          if (failure === "reject") return Promise.reject(observerFailure);
          if (failure === "thenable") return { then(_resolve: unknown, reject: (error: unknown) => void) { reject(observerFailure); } };
          throw observerFailure;
        } } });
      }
      protected execute(): void { this.runs += 1; throw new Error("work failure"); }
    }
    const service = new Crasher();
    try {
      service.start();
      for (let attempt = 0; attempt < 100 && service.runs < 3; attempt++) await Bun.sleep(1);
      await Bun.sleep(0); // Observe the final asynchronously rejected notification as well.
      expect(service.runs).toBe(3);
      if (failure !== "broken-sink") {
        expect(logged).toHaveLength(3);
        expect(JSON.stringify(logged)).not.toContain("observer-secret");
      }
    } finally { await service.stop(); console.error = original; }
  });

  test("restarts up to maxRestarts then gives up", async () => {
    class Crasher extends BackgroundService {
      public runs = 0;
      public errors = 0;
      public constructor() {
        super({ restart: { maxRestarts: 2, backoffMs: 1, onError: () => (this.errors += 1) } });
      }
      protected async execute(): Promise<void> {
        this.runs += 1;
        throw new Error("crash");
      }
    }

    const service = new Crasher();
    service.start();
    await Bun.sleep(50);
    await service.stop();

    expect(service.runs).toBe(3); // 1 initial + 2 restarts
    expect(service.errors).toBe(3);
  });
});

describe("PeriodicBackgroundService", () => {
  test.each(["throw", "reject"] as const)("a tick error observer that can %s leaves the schedule running", async failure => {
    const original = console.error;
    console.error = () => {};
    class Ticker extends PeriodicBackgroundService {
      ticks = 0;
      constructor() { super({ intervalMs: 1 }); }
      protected tick(): void { this.ticks += 1; throw new Error("tick failure"); }
      protected override onTickError(): void {
        if (failure === "reject") return Promise.reject(new Error("observer failure")) as unknown as void;
        throw new Error("observer failure");
      }
    }
    const service = new Ticker();
    try {
      service.start();
      for (let attempt = 0; attempt < 100 && service.ticks < 3; attempt++) await Bun.sleep(1);
      expect(service.ticks).toBeGreaterThanOrEqual(3);
    } finally { await service.stop(); console.error = original; }
  });

  test("ticks on the interval and stops on abort", async () => {
    class Ticker extends PeriodicBackgroundService {
      public ticks = 0;
      public constructor() {
        super({ intervalMs: 5 });
      }
      protected async tick(): Promise<void> {
        this.ticks += 1;
      }
    }

    const service = new Ticker();
    service.start();
    await Bun.sleep(30);
    await service.stop();

    expect(service.ticks).toBeGreaterThan(1);
  });

  test("a failing tick is reported and the loop continues", async () => {
    class Flaky extends PeriodicBackgroundService {
      public ticks = 0;
      public errors = 0;
      public constructor() {
        super({ intervalMs: 5 });
      }
      protected tick(): void {
        this.ticks += 1;
        throw new Error("boom");
      }
      protected override onTickError(): void {
        this.errors += 1;
      }
    }

    const service = new Flaky();
    service.start();
    await Bun.sleep(30);
    await service.stop();

    expect(service.ticks).toBeGreaterThan(1);
    expect(service.errors).toBe(service.ticks);
  });
});

describe("@Background decorator", () => {
  test("supplies periodic options without super({...})", async () => {
    @Background({ intervalMs: 5 })
    class Ticker extends PeriodicBackgroundService {
      public ticks = 0;
      protected async tick(): Promise<void> {
        this.ticks += 1;
      }
    }

    const service = new Ticker();
    service.start();
    await Bun.sleep(30);
    await service.stop();

    expect(service.ticks).toBeGreaterThan(1);
  });

  test("supplies restart-on-crash options for long-running services", async () => {
    let errors = 0;

    @Background({ restart: { maxRestarts: 2, backoffMs: 1, onError: () => (errors += 1) } })
    class Crasher extends BackgroundService {
      public runs = 0;
      protected async execute(): Promise<void> {
        this.runs += 1;
        throw new Error("crash");
      }
    }

    const service = new Crasher();
    service.start();
    await Bun.sleep(50);
    await service.stop();

    expect(service.runs).toBe(3);
    expect(errors).toBe(3);
  });

  test("explicit super(...) options override decorator metadata", async () => {
    @Background({ intervalMs: 1000 })
    class Override extends PeriodicBackgroundService {
      public ticks = 0;
      public constructor() {
        super({ intervalMs: 5 }); // wins over the decorator's 1000ms
      }
      protected async tick(): Promise<void> {
        this.ticks += 1;
      }
    }

    const service = new Override();
    service.start();
    await Bun.sleep(30);
    await service.stop();

    expect(service.ticks).toBeGreaterThan(1);
  });

  test("periodic service without intervalMs anywhere fails fast", () => {
    class Misconfigured extends PeriodicBackgroundService {
      protected async tick(): Promise<void> {}
    }

    expect(() => new Misconfigured()).toThrow(/intervalMs must be a finite positive number/);
  });

  test("periodic service rejects non-positive and non-finite intervals", () => {
    class Misconfigured extends PeriodicBackgroundService {
      public constructor(intervalMs: number) {
        super({ intervalMs });
      }
      protected async tick(): Promise<void> {}
    }

    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Misconfigured(interval)).toThrow(/finite positive number/);
    }
  });

  test("default background error logging redacts secrets", async () => {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void calls.push(args);
    try {
      class Crasher extends BackgroundService {
        protected execute(): void {
          throw new Error("token=very-secret-token-value");
        }
      }

      const service = new Crasher();
      service.start();
      await Bun.sleep(5);
      await service.stop();
      const output = JSON.stringify(calls);
      expect(output).toContain("***");
      expect(output).not.toContain("very-secret-token-value");
    } finally {
      console.error = original;
    }
  });
});

class Recorder extends BackgroundService {
  public ran = false;
  protected async execute(): Promise<void> {
    this.ran = true;
  }
}

describe("backgroundModule: DI wiring", () => {
  test("registers a service as HOSTED_SERVICE and the kernel can run it", async () => {
    @Module({ imports: [backgroundModule({ services: [Recorder] })] })
    class AppModule {}

    const container = createContainer(AppModule, { validateOnBuild: true });
    const hosted = container.resolveAll(HOSTED_SERVICE) as HostedService[];
    expect(hosted.length).toBe(1);

    for (const service of hosted) {
      service.start();
    }
    await Bun.sleep(10);
    for (const service of hosted) {
      await service.stop();
    }

    // Same singleton instance resolved by the HOSTED_SERVICE factory.
    expect(container.resolve(Recorder).ran).toBe(true);
  });
});
