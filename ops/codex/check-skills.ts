import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerClient } from "../../src/osnova/core/infra/connectors/codex/CodexAppServerClient";
import { CodexAppServer, object } from "../../src/osnova/core/infra/connectors/codex/CodexAppServer";
import { checkCodexPolicy, codexPaths, codexProcessOptions } from "../../src/osnova/core/infra/connectors/codex/CodexPolicy";

// Real installed CLI, isolated empty homes, no account or model requests.
const binary = process.argv[2];
if (!binary || !isAbsolute(binary)) throw new Error("Pass the absolute Codex binary path");
const directory = await mkdtemp(join(tmpdir(), "osnova-codex-skills-"));
const paths = await codexPaths(directory);
async function list() {
  const options = codexProcessOptions(paths);
  const server = new CodexAppServer(binary!, options.args, options.options);
  try {
    const initialized = await server.request("initialize", {
      clientInfo: { name: "osnova_skills_check", title: "Osnova Skills Check", version: "0.96.1" }, capabilities: { experimentalApi: true },
    });
    if (initialized.codexHome !== paths.home) throw new Error("Unexpected Codex home");
    server.notify("initialized");
    checkCodexPolicy(await server.request("config/read", { includeLayers: false }));
    const response = await server.request("skills/list", { cwds: [paths.workspace], forceReload: true });
    if (!Array.isArray(response.data) || response.data.length !== 1) throw new Error("Missing skill catalog");
    const group = object(response.data[0]);
    if (group.cwd !== paths.workspace || !Array.isArray(group.errors) || group.errors.length
      || !Array.isArray(group.skills)) throw new Error("Invalid skill catalog");
    return group.skills.map(value => {
      const skill = object(value);
      if (typeof skill.name !== "string" || typeof skill.enabled !== "boolean") throw new Error("Invalid skill metadata");
      return { name: skill.name, enabled: skill.enabled };
    });
  } finally { await server.stop(); }
}
try {
  const before = await list();
  if (!before.some(skill => skill.enabled)) throw new Error("Fixture did not expose bundled skills");
  const client = new CodexAppServerClient({ enabled: true, binary, stateDirectory: directory });
  try { await client.connect(); } finally { await client.dispose(); }
  const after = await list();
  if (after.length !== before.length || after.some(skill => skill.enabled)) throw new Error("Skills remained enabled after reconnect");
  console.log(JSON.stringify({ status: "PASS", scope: "Real Codex: isolated startup, skill disabling and persistence across reconnect; no model generation",
    discovered: before.map(skill => skill.name), enabledBefore: before.filter(skill => skill.enabled).length,
    enabledAfter: after.filter(skill => skill.enabled).length }));
} finally { await rm(directory, { recursive: true, force: true }); }
