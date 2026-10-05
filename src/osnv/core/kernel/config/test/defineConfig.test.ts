import { afterEach, describe, expect, test } from "bun:test";
import { Secret } from "../Secret";
import { defineConfig, secret } from "../defineConfig";

const TOUCHED_ENV_KEYS = [
  "OSNV_ENV",
  "OSNV_HTTP__PORT",
  "OSNV_FEATURE__X",
  "OSNV_JWT__ADMIN__SECRET",
  "OSNV_DB__HOST",
  "OSNV_WORKER__MAXRETRIES",
  "OSNV_WORKER__MAX_RETRIES",
];

afterEach(() => {
  for (const key of TOUCHED_ENV_KEYS) delete process.env[key];
});

describe("defineConfig", () => {
  test("typed defaults; get returns primitives of the right type", () => {
    const config = defineConfig({
      default: { "http.port": 3000, "log.level": "debug", "feature.x": false },
    });
    expect(config.get("http.port")).toBe(3000);
    expect(config.get("log.level")).toBe("debug");
    expect(config.get("feature.x")).toBe(false);
  });

  test("env overrides and is converted to the default's type", () => {
    process.env.OSNV_HTTP__PORT = "8080";
    process.env.OSNV_FEATURE__X = "true";
    const config = defineConfig({
      default: { "http.port": 3000, "feature.x": false },
    });
    expect(config.get("http.port")).toBe(8080);
    expect(config.get("feature.x")).toBe(true);
  });

  test("the environment section overrides the default (OSNV_ENV)", () => {
    process.env.OSNV_ENV = "production";
    const config = defineConfig({
      default: { "log.level": "debug" },
      production: { "log.level": "info" },
    });
    expect(config.get("log.level")).toBe("info");
  });

  test("explicit view has its environment without changing the shared definition", () => {
    process.env.OSNV_ENV = "development";
    const config = defineConfig({
      default: { "log.level": "default" },
      development: { "log.level": "debug" },
      production: { "log.level": "info" },
    });
    expect(config.get("log.level")).toBe("debug");

    const production = config.resolve("production");
    expect(production.get("log.level")).toBe("info");
    expect(config.get("log.level")).toBe("debug");
  });

  test("a secret with a dev default is a Secret and is redacted in logs", () => {
    const config = defineConfig({
      default: { "jwt.admin.secret": secret("admin-dev-secret-key-padding-0123456789") },
    });
    const value = config.get("jwt.admin.secret");
    expect(value).toBeInstanceOf(Secret);
    expect(value.reveal()).toBe("admin-dev-secret-key-padding-0123456789");
    expect(`${value}`).toBe("***");
  });

  test("a secret from env overrides the dev default", () => {
    process.env.OSNV_JWT__ADMIN__SECRET = "real-secret-from-env-0123456789-abcdef";
    const config = defineConfig({
      default: { "jwt.admin.secret": secret("dev-fallback-key-padding-0123456789xxx") },
    });
    expect(config.get("jwt.admin.secret").reveal()).toBe("real-secret-from-env-0123456789-abcdef");
  });

  test("a required secret without a value fails fast", () => {
    process.env.OSNV_ENV = "production";
    const config = defineConfig({
      default: { "jwt.admin.secret": secret("dev-only") },
      production: { "jwt.admin.secret": secret() },
    });
    expect(() => config.ensureValid()).toThrow(/jwt.admin.secret/);
  });

  test("a non-numeric env value fails fast", () => {
    process.env.OSNV_HTTP__PORT = "abc";
    const config = defineConfig({ default: { "http.port": 3000 } });
    expect(() => config.ensureValid()).toThrow(/expected a finite number/);
  });

  test("camelCase numeric schema key reads the conventional lowercased environment key", () => {
    process.env.OSNV_WORKER__MAXRETRIES = "7";
    const config = defineConfig("worker", { default: { maxRetries: 3 } });
    expect(config.get("maxRetries")).toBe(7);
  });

  test("non-canonical separator spelling does not become an environment-key alias", () => {
    process.env.OSNV_WORKER__MAX_RETRIES = "7";
    const config = defineConfig("worker", { default: { maxRetries: 3 } });
    expect(config.get("maxRetries")).toBe(3);
  });

  describe("namespace (domain prefix)", () => {
    test("keys are read without the prefix, env with the domain prefix", () => {
      process.env.OSNV_DB__HOST = "db.internal";
      const config = defineConfig("db", {
        default: { host: "localhost", port: 5432 },
      });
      expect(config.get("host")).toBe("db.internal");
      expect(config.get("port")).toBe(5432);
    });

    test("env without the domain prefix does not override a namespaced key", () => {
      process.env.OSNV_HOST = "wrong";
      const config = defineConfig("db", { default: { host: "localhost" } });
      expect(config.get("host")).toBe("localhost");
      delete process.env.OSNV_HOST;
    });

    test("a required domain secret reports the full env key in the error", () => {
      process.env.OSNV_ENV = "production";
      const config = defineConfig("db", {
        default: { password: secret("dev-only") },
        production: { password: secret() },
      });
      expect(() => config.ensureValid()).toThrow(/db\.password/);
    });
  });
});
