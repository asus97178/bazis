import { describe, expect, test } from "bun:test";
import {
  addReloadableOptions,
  createReloadableOptionsTokens,
  OptionsValidationError,
  ServiceCollection,
  validateOptionsOnStart,
} from "../index";

interface FeatureFlags {
  maxItems: number;
}

describe("reloadable options (IOptionsMonitor / IOptionsSnapshot)", () => {
  test("monitor exposes current value and reload updates it with notification", () => {
    let source: FeatureFlags = { maxItems: 10 };
    const tokens = createReloadableOptionsTokens<FeatureFlags>("Flags");

    const services = new ServiceCollection();
    addReloadableOptions(services, tokens, { load: () => source });
    const provider = services.buildServiceProvider();

    const monitor = provider.resolve(tokens.monitor);
    expect(monitor.current.maxItems).toBe(10);

    const seen: number[] = [];
    monitor.onChange((value) => seen.push(value.maxItems));

    source = { maxItems: 25 };
    monitor.reload();

    expect(monitor.current.maxItems).toBe(25);
    expect(seen).toEqual([25]);
  });

  test("snapshot is stable within a scope but fresh per new scope", () => {
    let source: FeatureFlags = { maxItems: 1 };
    const tokens = createReloadableOptionsTokens<FeatureFlags>("Flags");

    const services = new ServiceCollection();
    addReloadableOptions(services, tokens, { load: () => source });
    const provider = services.buildServiceProvider();
    const monitor = provider.resolve(tokens.monitor);

    const scopeA = provider.createScope();
    expect(scopeA.resolve(tokens.snapshot).value.maxItems).toBe(1);

    // Reload mid-scope: the existing scope keeps its captured value.
    source = { maxItems: 2 };
    monitor.reload();
    expect(scopeA.resolve(tokens.snapshot).value.maxItems).toBe(1);

    // A new scope sees the reloaded value.
    const scopeB = provider.createScope();
    expect(scopeB.resolve(tokens.snapshot).value.maxItems).toBe(2);
  });

  test("onChange subscription stops firing after dispose", () => {
    const tokens = createReloadableOptionsTokens<FeatureFlags>("Flags");
    const services = new ServiceCollection();
    addReloadableOptions(services, tokens, { load: () => ({ maxItems: 0 }) });
    const monitor = services.buildServiceProvider().resolve(tokens.monitor);

    let calls = 0;
    const subscription = monitor.onChange(() => {
      calls += 1;
    });
    monitor.reload();
    subscription.dispose();
    monitor.reload();

    expect(calls).toBe(1);
  });

  test("invalid config fails fast via validateOptionsOnStart", () => {
    const tokens = createReloadableOptionsTokens<FeatureFlags>("Flags");
    const services = new ServiceCollection();
    addReloadableOptions(services, tokens, {
      load: () => ({ maxItems: -1 }),
      validate: (value) => (value.maxItems > 0 ? [] : ["maxItems must be positive"]),
    });
    const provider = services.buildServiceProvider();

    expect(() => validateOptionsOnStart(provider)).toThrow(OptionsValidationError);
  });

  test("failed reload keeps the last good value and does not notify", () => {
    let source: FeatureFlags = { maxItems: 5 };
    const tokens = createReloadableOptionsTokens<FeatureFlags>("Flags");
    const services = new ServiceCollection();
    addReloadableOptions(services, tokens, {
      load: () => source,
      validate: (value) => (value.maxItems > 0 ? [] : ["maxItems must be positive"]),
    });
    const monitor = services.buildServiceProvider().resolve(tokens.monitor);

    let notifications = 0;
    monitor.onChange(() => {
      notifications += 1;
    });

    source = { maxItems: -3 };
    expect(() => monitor.reload()).toThrow(OptionsValidationError);
    expect(monitor.current.maxItems).toBe(5);
    expect(notifications).toBe(0);
  });
});
