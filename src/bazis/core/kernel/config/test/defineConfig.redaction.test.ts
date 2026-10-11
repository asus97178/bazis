import { afterEach, expect, test } from "bun:test";
import { redactSensitiveText } from "../../../../library/redaction";
import { defineConfig, secret } from "../defineConfig";

// The console redacts configuration errors. With "key: text" a sensitive key
// name made the redaction hide the first word: "db.password: *** non-empty
// secret is not set". The "key — text" format keeps the message intact.
afterEach(() => {
  delete process.env.BAZIS_ENV;
  delete process.env.BAZIS_DB__PASSWORD;
});

function errorText(build: () => void): string {
  try {
    build();
  } catch (error) {
    return redactSensitiveText((error as Error).message);
  }
  throw new Error("expected a configuration error");
}

test("a missing secret with a sensitive key name keeps its message after redaction", () => {
  process.env.BAZIS_ENV = "production";
  const config = defineConfig("db", { default: { password: secret("dev"), port: 5432 }, production: { password: secret() } });
  expect(errorText(() => config.ensureValid())).toBe(
    'Invalid configuration (environment "production"): db.password — required non-empty secret is not set (BAZIS_DB__PASSWORD).',
  );
});

test("a secret value in a validator message is still hidden", () => {
  process.env.BAZIS_DB__PASSWORD = "hunter2";
  const config = defineConfig("db", {
    default: { password: secret("dev") },
    validate: { password: (value) => (value.reveal().length < 8 ? `too short: ${value.reveal()}` : undefined) },
  });
  const text = errorText(() => config.ensureValid());
  expect(text).toContain("db.password — too short: ***");
  expect(text).not.toContain("hunter2");
});

test("the production default-secret hint survives the console redaction (0.98.29)", () => {
  const config = defineConfig("db", { default: { password: secret("dev") } });
  expect(errorText(() => config.resolve("production"))).toBe(
    'Invalid configuration (environment "production"): db.password — production would use the development default secret from the code; set BAZIS_DB__PASSWORD, or declare password in the production section.',
  );
});

test("a short secret does not mask the letters of the rest of the message (0.98.29)", () => {
  process.env.BAZIS_DB__PASSWORD = "a";
  const config = defineConfig("db", { default: { password: secret("dev"), apiKey: secret("dev-key") } });
  expect(() => config.resolve("production")).toThrow(
    'Invalid configuration (environment "production"): db.apiKey — production would use the development default secret from the code; set BAZIS_DB__APIKEY, or declare apiKey in the production section.',
  );
});

test("a wrong value of a sensitive key is not quoted (0.98.29)", () => {
  process.env.BAZIS_DB__PASSWORD = "not-a-number";
  const config = defineConfig("db", { default: { password: 0 } });
  const text = errorText(() => config.resolve("development"));
  expect(text).toBe('Invalid configuration (environment "development"): db.password — expected a finite number (BAZIS_DB__PASSWORD).');
});
