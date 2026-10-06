import { describe, expect, test } from "bun:test";
import { createToken, DI } from "../../../di";
import { infraModule, reader, type InfraConnector } from "../../../infra";
import { ConfigRegistry, Configuration, Bazis, configEnum, defineConfig, envSource, loadConfiguration, memorySource, secret } from "../../index";

describe("configuration views and validation", () => {
  test("two kernels isolate services and connectors, also with the same environment", async () => {
    const config = defineConfig("isolation", { default: { host: "default", password: secret("default") }, production: { host: "production" } });
    const CLIENT = createToken<{ host: string; password: string }>("isolated client");
    const SERVICE = createToken<() => string>("isolated service");
    const connector: InfraConnector<{ host: string; password: string }> = {
      token: CLIENT, config,
      create(configs) { const c = configs!.get(config); return { host: c.get("host"), password: c.get("password").reveal() }; },
      connect() {}, dispose() {},
    };
    const root = { imports: [infraModule({ isolated: connector })], providers: [DI.singleton(DI.factoryProvider(SERVICE, [config.token], view => () => view.get("host")))] };
    const make = (environment: "production" | "test", host: string) => Bazis.createBuilder(root).useEnvironment(environment).useStartupReport(false)
      .addConfigSource(memorySource({ isolation: { host, password: `${host}-secret` } })).build();
    const kernels = await Promise.all([make("production", "one"), make("test", "two"), make("test", "three")]);
    try {
      const values = await Promise.all(kernels.map(async kernel => {
        await kernel.start();
        return [kernel.container.resolve(SERVICE)(), kernel.container.resolve(CLIENT).host];
      }));
      expect(values).toEqual([["one", "one"], ["two", "two"], ["three", "three"]]);
      await kernels[1]!.stop();
      await expect(Bazis.createBuilder(root).useEnvironment("test").addConfigSource(memorySource({ isolation: { password: "" } })).build()).rejects.toThrow();
      expect(kernels[0]!.container.resolve(config.token).get("host")).toBe("one");
      expect(kernels[2]!.container.resolve(CLIENT).password).toBe("three-secret");
      expect(JSON.stringify(kernels[0]!.container.resolve(ConfigRegistry).inspect())).not.toContain("one-secret");
    } finally { await Promise.all(kernels.map(kernel => kernel.stop())); }
  });

  test("sources reach the connector and later mutation cannot affect an existing view", async () => {
    const config = defineConfig("source", { default: { maxRetries: 1 } });
    const values = { source: { maxRetries: 8 } };
    const source = await loadConfiguration([memorySource(values)]);
    const registry = new ConfigRegistry([config], "test", source);
    values.source.maxRetries = 99;
    expect(reader(config, registry).get("maxRetries")).toBe(8);
    expect(registry.get(config)).toBe(registry.get(config));
  });

  test("explicit aliases support camelCase, conflicts fail, later sources win", async () => {
    const config = defineConfig("llm", { default: { baseUrl: "default", apiKey: secret("hidden") }, env: { baseUrl: "BAZIS_LLM__BASE_URL", apiKey: "BAZIS_LLM__API_KEY" } });
    const aliases = await loadConfiguration([envSource({ variables: { BAZIS_LLM__BASE_URL: "https://example.invalid", BAZIS_LLM__API_KEY: "synthetic-secret" } })]);
    const view = config.resolve("test", aliases);
    expect(view.get("baseUrl")).toBe("https://example.invalid");
    expect(view.get("apiKey").reveal()).toBe("synthetic-secret");
    expect(JSON.stringify(view.inspect())).not.toContain("synthetic-secret");
    const conflicting = await loadConfiguration([envSource({ variables: { BAZIS_LLM__BASEURL: "one", BAZIS_LLM__BASE_URL: "two" } })]);
    expect(() => config.resolve("test", conflicting)).toThrow(/conflicting/);
    const ordered = await loadConfiguration([memorySource({ llm: { baseUrl: "file" } }), envSource({ variables: { BAZIS_LLM__BASE_URL: "env" } })]);
    expect(config.resolve("test", ordered).get("baseUrl")).toBe("env");
  });

  test("blank and non-finite numbers, empty secrets and invalid enums fail", () => {
    const config = defineConfig("rules", { default: { port: 3000, key: secret("synthetic"), mode: configEnum(["primary", "replica"], "primary") }, validate: { port: value => Number.isInteger(value) && value > 0 && value <= 65535 ? undefined : "port range" } });
    for (const raw of ["", " ", "Infinity", "NaN", "-1", "65536", "1.5"]) expect(() => config.resolve("test", new Configuration(new Map([["rules.port", raw]])))).toThrow();
    for (const raw of ["", " \t"]) expect(() => config.resolve("test", new Configuration(new Map([["rules.key", raw]])))).toThrow();
    expect(() => config.resolve("test", new Configuration(new Map([["rules.mode", "other"]])))).toThrow(/enum/);
    expect(config.resolve("test", new Configuration(new Map([["rules.mode", "replica"]]))).get("mode")).toBe("replica");
  });

  test("all module configuration errors are reported before any client is created", async () => {
    let created = false;
    const a = defineConfig("first", { default: { password: secret() } });
    const b = defineConfig("second", { default: { password: secret() } });
    const resource: InfraConnector<object> = { token: createToken("invalid"), config: [a, b], create() { created = true; return {}; }, connect() {}, dispose() {} };
    let error: unknown;
    try { await Bazis.createBuilder(infraModule({ invalid: resource })).useEnvironment("test").build(); } catch (caught) { error = caught; }
    expect(String(error)).toContain("first.password");
    expect(String(error)).toContain("second.password");
    expect(created).toBe(false);
  });

  test("declaration copies schema cells and resolved source values", () => {
    const schema = { default: { host: "before", mode: configEnum(["a", "b"], "a") } };
    const config = defineConfig(schema);
    schema.default.host = "after";
    const values = new Map([["host", "snapshot"]]);
    const view = config.resolve("test", new Configuration(values));
    values.set("host", "later");
    expect(view.get("host")).toBe("snapshot");
    expect(config.resolve("test", Configuration.empty()).get("host")).toBe("before");
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("inspection and validation messages mask secrets and URL credentials", () => {
    const config = defineConfig({ default: { url: "redis://user:synthetic-password@example.invalid", apiKey: "synthetic-api-key", secret: secret("synthetic-secret") } });
    const output = JSON.stringify(config.resolve("test", Configuration.empty()).inspect());
    for (const sensitive of ["synthetic-password", "synthetic-api-key", "synthetic-secret"]) expect(output).not.toContain(sensitive);
    const invalid = defineConfig({ default: { key: secret("private-test-value") }, validate: { key: value => `invalid: ${value.reveal()}` } });
    expect(() => invalid.resolve("test", Configuration.empty())).toThrow(/invalid/);
    try { invalid.resolve("test", Configuration.empty()); throw new Error("Expected rejection"); }
    catch (error) { expect(String(error)).not.toContain("private-test-value"); }
  });
});
