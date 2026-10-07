import { expect, test } from "bun:test";
import { redactSensitiveText } from "../../../../library/redaction";
import { defineConfig, secret } from "../defineConfig";

// One message used to cover four causes: "Invalid or duplicate configuration
// environment name: SMTP_HOST." Now it names the key and the actual problem.
function messageOf(define: () => unknown): string {
  try {
    define();
  } catch (error) {
    return redactSensitiveText((error as Error).message);
  }
  throw new Error("expected a configuration error");
}

test("an alias without the BAZIS_ prefix explains the prefix rule", () => {
  expect(messageOf(() => defineConfig("mail", { default: { host: "localhost" }, env: { host: "SMTP_HOST" } }))).toBe(
    'Configuration key "mail.host": environment variable "SMTP_HOST" must start with BAZIS_: configuration reads only BAZIS_* variables (for example BAZIS_SMTP_HOST).',
  );
});

test("an empty name, bad characters and a duplicate each get their own reason", () => {
  expect(messageOf(() => defineConfig("mail", { default: { host: "x" }, env: { host: "BAZIS_" } })))
    .toBe('Configuration key "mail.host": environment variable "BAZIS_" needs a name after BAZIS_.');
  expect(messageOf(() => defineConfig("mail", { default: { host: "x" }, env: { host: "BAZIS_smtp.host" } })))
    .toBe('Configuration key "mail.host": environment variable "BAZIS_smtp.host" may contain only A-Z, 0-9, _ and -.');
  expect(messageOf(() => defineConfig("mail", { default: { host: "x", relay: "y" }, env: { relay: "BAZIS_MAIL__HOST" } })))
    .toBe('Configuration key "mail.relay": environment variable "BAZIS_MAIL__HOST" is already used by another key of this configuration.');
});

test("the message survives the console redaction for a sensitive key", () => {
  expect(messageOf(() => defineConfig("mail", { default: { apiKey: secret("x") }, env: { apiKey: "MAIL_API_KEY" } })))
    .toContain('Configuration key "mail.apiKey": environment variable "MAIL_API_KEY" must start with BAZIS_');
});
