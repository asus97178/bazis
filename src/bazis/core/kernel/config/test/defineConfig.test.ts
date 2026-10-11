import { afterEach, describe, expect, test } from "bun:test";
import { Secret } from "../Secret";
import { configEnum, defineConfig, secret } from "../defineConfig";

const TOUCHED_ENV_KEYS = [
  "BAZIS_ENV",
  "BAZIS_HTTP__PORT",
  "BAZIS_FEATURE__X",
  "BAZIS_JWT__ADMIN__SECRET",
  "BAZIS_DB__HOST",
  "BAZIS_WORKER__MAXRETRIES",
  "BAZIS_WORKER__MAX_RETRIES",
  "BAZIS_DB__TLS",
  "BAZIS_FEATURE__ON",
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
    process.env.BAZIS_HTTP__PORT = "8080";
    process.env.BAZIS_FEATURE__X = "true";
    const config = defineConfig({
      default: { "http.port": 3000, "feature.x": false },
    });
    expect(config.get("http.port")).toBe(8080);
    expect(config.get("feature.x")).toBe(true);
  });

  test("the environment section overrides the default (BAZIS_ENV)", () => {
    process.env.BAZIS_ENV = "production";
    const config = defineConfig({
      default: { "log.level": "debug" },
      production: { "log.level": "info" },
    });
    expect(config.get("log.level")).toBe("info");
  });

  test("explicit view has its environment without changing the shared definition", () => {
    process.env.BAZIS_ENV = "development";
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
    process.env.BAZIS_JWT__ADMIN__SECRET = "real-secret-from-env-0123456789-abcdef";
    const config = defineConfig({
      default: { "jwt.admin.secret": secret("dev-fallback-key-padding-0123456789xxx") },
    });
    expect(config.get("jwt.admin.secret").reveal()).toBe("real-secret-from-env-0123456789-abcdef");
  });

  test("a required secret without a value fails fast", () => {
    process.env.BAZIS_ENV = "production";
    const config = defineConfig({
      default: { "jwt.admin.secret": secret("dev-only") },
      production: { "jwt.admin.secret": secret() },
    });
    expect(() => config.ensureValid()).toThrow(/jwt.admin.secret/);
  });

  test("production does not start on a secret default from the code (0.98.29)", () => {
    const config = defineConfig("mail", { default: { host: "localhost", apiKey: secret("dev-key") } });
    expect(() => config.resolve("production")).toThrow(
      'Invalid configuration (environment "production"): mail.apiKey — production would use the development default secret from the code; set BAZIS_MAIL__APIKEY, or declare apiKey in the production section.',
    );
    // Development and test keep the default.
    expect(config.resolve("development").get("apiKey").reveal()).toBe("dev-key");
    expect(config.resolve("test").get("apiKey").reveal()).toBe("dev-key");
  });

  test("production accepts a secret from a source or its own declared value (0.98.29)", () => {
    const config = defineConfig("mail", { default: { apiKey: secret("dev-key") } });
    process.env.BAZIS_MAIL__APIKEY = "live-key";
    try {
      expect(config.resolve("production").get("apiKey").reveal()).toBe("live-key");
    } finally {
      delete process.env.BAZIS_MAIL__APIKEY;
    }
    const explicit = defineConfig("mail", { default: { apiKey: secret("dev-key") }, production: { apiKey: secret("shared-key") } });
    expect(explicit.resolve("production").get("apiKey").reveal()).toBe("shared-key");
  });

  test("a non-numeric env value fails fast", () => {
    process.env.BAZIS_HTTP__PORT = "abc";
    const config = defineConfig({ default: { "http.port": 3000 } });
    expect(() => config.ensureValid()).toThrow(/expected a finite number/);
  });

  test("a wrong value names what came, what is allowed and the variable (0.98.12)", () => {
    process.env.BAZIS_HTTP__PORT = "abc";
    process.env.BAZIS_DB__TLS = "strict";
    process.env.BAZIS_FEATURE__ON = "yes";
    const config = defineConfig({
      default: { "http.port": 3000, "db.tls": configEnum(["disable", "require"], "disable"), "feature.on": false },
    });
    const message = (() => { try { config.ensureValid(); return ""; } catch (error) { return (error as Error).message; } })();
    expect(message).toContain('http.port — expected a finite number, got "abc" (BAZIS_HTTP__PORT)');
    expect(message).toContain('db.tls — "strict" is not allowed, use one of: disable, require (BAZIS_DB__TLS)');
    expect(message).toContain('feature.on — expected a boolean (true, false, 1, 0), got "yes" (BAZIS_FEATURE__ON)');
  });

  test("camelCase numeric schema key reads the conventional lowercased environment key", () => {
    process.env.BAZIS_WORKER__MAXRETRIES = "7";
    const config = defineConfig("worker", { default: { maxRetries: 3 } });
    expect(config.get("maxRetries")).toBe(7);
  });

  test("non-canonical separator spelling does not become an environment-key alias", () => {
    process.env.BAZIS_WORKER__MAX_RETRIES = "7";
    const config = defineConfig("worker", { default: { maxRetries: 3 } });
    expect(config.get("maxRetries")).toBe(3);
  });

  describe("namespace (domain prefix)", () => {
    test("keys are read without the prefix, env with the domain prefix", () => {
      process.env.BAZIS_DB__HOST = "db.internal";
      const config = defineConfig("db", {
        default: { host: "localhost", port: 5432 },
      });
      expect(config.get("host")).toBe("db.internal");
      expect(config.get("port")).toBe(5432);
    });

    test("env without the domain prefix does not override a namespaced key", () => {
      process.env.BAZIS_HOST = "wrong";
      const config = defineConfig("db", { default: { host: "localhost" } });
      expect(config.get("host")).toBe("localhost");
      delete process.env.BAZIS_HOST;
    });

    test("a required domain secret reports the full env key in the error", () => {
      process.env.BAZIS_ENV = "production";
      const config = defineConfig("db", {
        default: { password: secret("dev-only") },
        production: { password: secret() },
      });
      expect(() => config.ensureValid()).toThrow(/db\.password/);
    });
  });
});
