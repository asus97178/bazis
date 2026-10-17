import { expect, test } from "bun:test";
import { defineConfig, envSource, loadConfiguration, secret } from "../../index";

// 0.100.8: a conflict names both variables, never their values. On 0.100.7 the
// text was only "conflicting environment aliases".

test("conflicting aliases name the variables and hide the values", async () => {
  const config = defineConfig("mail", { default: { host: "localhost", apiKey: secret("dev") }, env: { host: "BAZIS_SMTP_HOST", apiKey: "BAZIS_MAIL_KEY" } });
  const conflicting = await loadConfiguration([envSource({ variables: { BAZIS_MAIL__HOST: "a.example", BAZIS_SMTP_HOST: "b.example", BAZIS_MAIL__APIKEY: "secret-one", BAZIS_MAIL_KEY: "secret-two" } })]);
  let message = "";
  try { config.resolve("test", conflicting); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("mail.host — conflicting environment aliases: BAZIS_MAIL__HOST and BAZIS_SMTP_HOST are set to different values; set only one");
  expect(message).toContain("mail.apiKey — conflicting environment aliases: BAZIS_MAIL__APIKEY and BAZIS_MAIL_KEY are set to different values; set only one");
  expect(message).not.toContain("secret-one");
  expect(message).not.toContain("a.example");
});
