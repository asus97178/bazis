import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CodexError, type CodexChatMessage } from "./contracts";
import { object, text, type CodexAppServer, type RpcObject } from "./CodexAppServer";

export const DISABLED_CODEX_FEATURES = [
  "shell_tool", "unified_exec", "shell_snapshot", "view_image", "image_generation",
  "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external", "computer_use",
  "in_app_browser", "in_app_chat", "in_app_dictation", "in_app_local_automation",
  "code_mode", "code_mode_host", "code_mode_only", "multi_agent", "multi_agent_v2", "goals",
  "hooks", "memories", "skill_search", "skill_mcp_dependency_install", "tool_suggest",
  "sleep_tool", "workspace_dependencies", "unbounded_connection_retries",
] as const;

export const CODEX_OVERRIDES: Readonly<Record<string, string | boolean | number | readonly string[]>> = {
  ...Object.fromEntries(DISABLED_CODEX_FEATURES.map(name => [`features.${name}`, false])),
  "features.skip_host_skill_discovery": true,
  "model_provider": "openai", "forced_login_method": "chatgpt",
  "cli_auth_credentials_store": "file", "approval_policy": "never", "approvals_reviewer": "user",
  "sandbox_mode": "read-only", "web_search": "disabled",
  "agents.enabled": false, "analytics.enabled": false, "check_for_update_on_startup": false,
  "project_doc_max_bytes": 0, "notify": [], "shell_environment_policy.inherit": "none",
};

export async function codexPaths(directory: string) {
  const root = resolve(directory);
  const paths = { root, home: join(root, "home"), workspace: join(root, "workspace"), userHome: join(root, "user") };
  for (const path of Object.values(paths)) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new CodexError("UNAVAILABLE");
    await chmod(path, 0o700);
  }
  return { ...paths, home: await realpath(paths.home), workspace: await realpath(paths.workspace), userHome: await realpath(paths.userHome) };
}

export function codexProcessOptions(paths: Awaited<ReturnType<typeof codexPaths>>) {
  // Deliberate child-process homes, never a mutation of the application's own environment.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: paths.userHome,
    CODEX_HOME: paths.home, XDG_CONFIG_HOME: join(paths.userHome, ".config"),
    TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8",
  };
  const args = ["app-server", "--listen", "stdio://", "--strict-config"];
  for (const [key, value] of Object.entries(CODEX_OVERRIDES)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  return { args, options: { cwd: paths.workspace, env } };
}

/** Admission is fail-closed if system configuration leaves an external server or capability enabled. */
export function checkCodexPolicy(response: RpcObject): void {
  const config = object(response.config), features = object(config.features);
  if (DISABLED_CODEX_FEATURES.some(key => features[key] !== false)
    || features.skip_host_skill_discovery !== true || config.web_search !== "disabled"
    || config.sandbox_mode !== "read-only" || config.approval_policy !== "never"
    || config.model_provider !== "openai" || config.forced_login_method !== "chatgpt"
    || config.cli_auth_credentials_store !== "file") throw new CodexError("PROTOCOL_ERROR");
  if (config.mcp_servers && Object.values(object(config.mcp_servers)).some(server => object(server).enabled !== false)) {
    throw new CodexError("PROTOCOL_ERROR");
  }
}

/** Host discovery flags do not disable bundled system skills. Settings belong to the isolated CODEX_HOME. */
export async function disableCodexSkills(client: CodexAppServer, workspace: string, signal?: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(15_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const skills = await readCodexSkills(client, workspace, bounded);
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const result = await client.request("skills/config/write", { path: skill.path, enabled: false }, 5000, bounded);
    if (result.effectiveEnabled !== false) throw new CodexError("PROTOCOL_ERROR");
  }
  // A successful write response alone does not prove the catalog changed.
  await checkCodexSkills(client, workspace, bounded);
}

/** Check again before each thread: cached startup state is not a capability guarantee. */
export async function checkCodexSkills(client: CodexAppServer, workspace: string, signal?: AbortSignal): Promise<void> {
  if ((await readCodexSkills(client, workspace, signal)).some(skill => skill.enabled)) throw new CodexError("PROTOCOL_ERROR");
}

async function readCodexSkills(client: CodexAppServer, workspace: string, signal?: AbortSignal) {
  const response = await client.request("skills/list", { cwds: [workspace], forceReload: true }, 5000, signal);
  if (!Array.isArray(response.data) || response.data.length !== 1) throw new CodexError("PROTOCOL_ERROR");
  const group = object(response.data[0]);
  if (group.cwd !== workspace || !Array.isArray(group.errors) || group.errors.length
    || !Array.isArray(group.skills) || group.skills.length > 128) throw new CodexError("PROTOCOL_ERROR");
  const paths = new Set<string>();
  return group.skills.map(value => {
    const skill = object(value), path = text(skill.path, 4096);
    if (!isAbsolute(path) || path.includes("\0") || paths.has(path) || typeof skill.enabled !== "boolean") throw new CodexError("PROTOCOL_ERROR");
    paths.add(path);
    return { path, enabled: skill.enabled };
  });
}

/** Keep whole turns from the end; never splice/truncate user instructions or a message. */
export function codexConversation(messages: readonly CodexChatMessage[], instructions: string): string {
  if (typeof instructions !== "string" || instructions.length > 32_000 || !messages.length || messages.length > 41) {
    throw new CodexError("PROTOCOL_ERROR");
  }
  for (const message of messages) {
    if (!["user", "assistant"].includes(message.role) || typeof message.text !== "string" || message.text.length > 32_000) {
      throw new CodexError("PROTOCOL_ERROR");
    }
  }
  const current = messages.at(-1)!;
  if (current.role !== "user" || !current.text.trim() || current.text.length > 8000) throw new CodexError("PROTOCOL_ERROR");
  const history = messages.slice(0, -1);
  let encoded = JSON.stringify({ history, message: current.text });
  while (history.length && instructions.length + encoded.length > 48_000) {
    history.splice(0, 2); encoded = JSON.stringify({ history, message: current.text });
  }
  if (instructions.length + encoded.length > 48_000) throw new CodexError("PROTOCOL_ERROR");
  return encoded;
}
