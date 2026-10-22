import { afterEach, expect, test } from "bun:test";
import { defineConfig, secret } from "../defineConfig";

// 0.112.0: secret("") looked like an empty default but meant "required": the
// development start failed with "required non-empty secret is not set". It is
// now refused as a declaration, with the fix.
afterEach(() => {
  delete process.env.BAZIS_ENV;
  delete process.env.BAZIS_AUTH__KEYPEM;
});

function errorText(build: () => void): string {
  try { build(); } catch (error) { return (error as Error).message; }
  throw new Error("expected a configuration error");
}

const message = 'Invalid configuration (environment "development"): auth.keyPem — secret("") is not a value: a secret cannot be empty. Write secret() for a required secret, or give a non-empty development value.';

test('secret("") is refused with the fix, also when the variable is set', () => {
  process.env.BAZIS_ENV = "development";
  const config = defineConfig("auth", { default: { keyPem: secret("") } });
  expect(errorText(() => config.ensureValid())).toBe(message);
  process.env.BAZIS_AUTH__KEYPEM = "-----BEGIN PRIVATE KEY-----";
  expect(errorText(() => config.ensureValid())).toBe(message);
});

test('secret("") in an environment section is refused too; secret() stays a required secret', () => {
  process.env.BAZIS_ENV = "development";
  expect(errorText(() => defineConfig("auth", { default: { keyPem: secret("dev") }, development: { keyPem: secret("") } }).ensureValid())).toBe(message);
  process.env.BAZIS_ENV = "production";
  expect(errorText(() => defineConfig("auth", { default: { keyPem: secret() } }).ensureValid())).toBe(
    'Invalid configuration (environment "production"): auth.keyPem — required non-empty secret is not set (BAZIS_AUTH__KEYPEM).',
  );
});
