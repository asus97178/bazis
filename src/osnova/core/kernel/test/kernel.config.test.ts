import { describe, expect, test } from "bun:test";
import { OptionsValidationError, createOptionsToken, type OsnovaModuleRef } from "../../di";
import {
  ConfigKeyMissingError,
  Configuration,
  KernelError,
  Osnova,
  Secret,
  argsSource,
  configOptions,
  envSource,
  jsonFileSource,
  loadConfiguration,
  memorySource,
} from "../index";

describe("Kernel configuration", () => {
  test("sources merge in order, later wins", async () => {
    const config = await loadConfiguration([
      memorySource({ db: { host: "default", port: 5432 }, debug: false }),
      envSource({ prefix: "APP_", variables: { APP_DB__HOST: "from-env", UNRELATED: "x" } }),
      argsSource(["--db.host=from-args", "positional", "--flag"]),
    ]);

    expect(config.get("db.host")).toBe("from-args");
    expect(config.getNumber("db.port")).toBe(5432);
    expect(config.getBoolean("debug")).toBe(false);
    expect(config.has("unrelated")).toBe(false);
  });

  test("typed getters validate values and report missing keys", async () => {
    const config = await loadConfiguration([memorySource({ port: "abc", flag: "yes" })]);
    expect(() => config.getNumber("port")).toThrow(KernelError);
    expect(() => config.getBoolean("flag")).toThrow(KernelError);
    expect(() => config.require("nope")).toThrow(ConfigKeyMissingError);
    expect(config.getOrDefault("nope", "fallback")).toBe("fallback");
    expect(config.get("nope")).toBeUndefined();
  });

  test("json file source flattens nested objects and respects optional", async () => {
    const path = `${import.meta.dir}/.tmp-config-${Date.now()}.json`;
    await Bun.write(path, JSON.stringify({ smtp: { host: "mail.local", tls: { enabled: true } }, tags: ["a", "b"] }));
    try {
      const config = await loadConfiguration([jsonFileSource(path)]);
      expect(config.get("smtp.host")).toBe("mail.local");
      expect(config.getBoolean("smtp.tls.enabled")).toBe(true);
      expect(config.get("tags.1")).toBe("b");
    } finally {
      await Bun.file(path).delete();
    }

    const missing = await loadConfiguration([jsonFileSource("/nonexistent.json", { optional: true })]);
    expect(missing.keys()).toHaveLength(0);
    await expect(loadConfiguration([jsonFileSource("/nonexistent.json")])).rejects.toThrow(KernelError);
  });

  test("Secret never leaks through logs", async () => {
    const config = await loadConfiguration([memorySource({ db: { password: "p@ss" } })]);
    const secret = config.requireSecret("db.password");
    expect(secret.reveal()).toBe("p@ss");
    expect(`${secret}`).toBe("***");
    expect(JSON.stringify({ secret })).toBe('{"secret":"***"}');
    expect(Bun.inspect(secret)).toContain("***");
    expect(Bun.inspect(secret)).not.toContain("p@ss");
    expect(config.getSecret("nope")).toBeUndefined();
    expect(new Secret("x").reveal()).toBe("x");
  });

  test("configOptions bind from kernel Configuration and resolve as Options", async () => {
    interface SmtpOptions {
      host: string;
      port: number;
    }
    const SMTP = createOptionsToken<SmtpOptions>("KernelSmtp");
    const moduleRef: OsnovaModuleRef = {
      providers: [
        ...configOptions(SMTP, {
          bind: (config) => ({ host: config.require("smtp.host"), port: config.requireNumber("smtp.port") }),
          validate: (o) => (o.port > 0 ? [] : ["port must be positive"]),
        }),
      ],
    };

    const kernel = await Osnova.createBuilder(moduleRef)
      .useEnvironment("test")
      .useStartupReport(false)
      .addConfigSource(memorySource({ smtp: { host: "mail.local", port: 25 } }))
      .build();
    await kernel.start();
    expect(kernel.container.resolve(SMTP).value).toEqual({ host: "mail.local", port: 25 });
    await kernel.stop();
  });

  test("kernel start fails fast and aggregates all config problems", async () => {
    const SMTP = createOptionsToken<{ host: string }>("KernelBadSmtp");
    const DB = createOptionsToken<{ url: string }>("KernelBadDb");
    const moduleRef: OsnovaModuleRef = {
      providers: [
        ...configOptions(SMTP, {
          bind: (config) => ({ host: config.require("smtp.host") }),
        }),
        ...configOptions(DB, {
          bind: (config) => ({ url: config.getOrDefault("db.url", "") }),
          validate: (o) => (o.url ? [] : ["db.url is required"]),
        }),
      ],
    };

    const kernel = await Osnova.createBuilder(moduleRef).useEnvironment("test").useStartupReport(false).build();
    try {
      await kernel.start();
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(OptionsValidationError);
      const issues = (error as OptionsValidationError).issues;
      expect(issues).toHaveLength(2);
      expect(issues.join("\n")).toContain("smtp.host");
      expect(issues.join("\n")).toContain("db.url is required");
    }
  });
});
