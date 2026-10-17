import { expect, test } from "bun:test";
import * as infra from "../index";
import { defineConfig } from "../../kernel";

// 0.103.0: the Codex client is injected by type, like IPostgres and IRedis.
// Before, it took the const token CODEX_APP_SERVER and an explicit deps list.

test("codexAppServerConnect registers the client under ICodex", () => {
  const config = defineConfig("codex-type", { default: { enabled: false, binary: "/does/not/exist", stateDirectory: "/does/not/exist" } });
  expect(infra.codexAppServerConnect(config).token).toBe(infra.ICodex);
});

test("the CODEX_APP_SERVER token is removed", () => {
  expect("CODEX_APP_SERVER" in infra).toBe(false);
});
