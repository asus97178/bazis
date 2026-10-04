import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { HttpClient, HttpClientError } from "../library/http-client";

export interface AgentRunArgs {
  agent: string;
  server: string;
  authFile: string;
  message: string;
  model?: string;
  reasoningEffort?: string;
}

/** A client of the application API: authentication, ownership and execution remain on the server. */
export class AgentClientService {
  async run(args: AgentRunArgs, signal?: AbortSignal): Promise<string> {
    const origin = agentServerOrigin(args.server);
    const file = await open(args.authFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let credentials: { email: string; password: string };
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error("Auth file must be private (chmod 600) and at most 4096 bytes.");
      let value: Record<string, unknown>;
      try { value = JSON.parse(await file.readFile("utf8")); } catch { throw new Error("Invalid auth file JSON."); }
      if (!value || typeof value !== "object") throw new Error("Invalid auth file.");
      // The file binds credentials to one origin, so --server cannot redirect an existing identity.
      if (value.server !== origin || typeof value.email !== "string" || value.email.length > 320
        || typeof value.password !== "string" || value.password.length > 128) throw new Error("Invalid auth file or server mismatch.");
      credentials = { email: value.email, password: value.password };
    } finally { await file.close(); }
    const http = new HttpClient({ baseUrl: origin + "/api/client", timeoutMs: 15000,
      maxResponseBytes: 256000, redirect: "error", retry: { maxRetries: 0 } });
    let cookie: string | undefined;
    try {
      const login = await http.post("/auth/login", credentials, { signal });
      cookie = login.headers.get("set-cookie")?.match(/(?:^|,\s*)osnova_client_session=([A-Za-z0-9_-]{32,256})(?:;|$)/)?.[1];
      if (!cookie) throw new Error("The server did not issue a client session.");
      const headers = { cookie: "osnova_client_session=" + cookie, origin };
      const created = await http.post<{ id: string }>("/chat/conversations", { agentId: args.agent }, { headers, signal });
      const id = created.data.id;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid conversation response.");
      const requestId = crypto.randomUUID();
      let cancellation: Promise<unknown> | undefined;
      const cancel = () => { cancellation ??= http.post("/chat/conversations/" + id + "/messages/" + requestId + "/cancel", {}, { headers }).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const response = await http.post<{ status: string; assistantText: string }>("/chat/conversations/" + id + "/messages",
          { requestId, text: args.message, model: args.model, reasoningEffort: args.reasoningEffort }, { headers, signal, timeoutMs: 160000 });
        if (response.data.status !== "completed" || typeof response.data.assistantText !== "string") throw new Error("Agent run did not complete. Inspect its conversation in the application.");
        return response.data.assistantText;
      } finally {
        signal?.removeEventListener("abort", cancel);
        // Keep the temporary session valid until the cancellation request settles.
        await cancellation;
      }
    } catch (error) {
      if (error instanceof HttpClientError) throw new Error("Agent request failed" + (error.status ? " (HTTP " + error.status + ")" : "") + ". No automatic retry was made.");
      throw error;
    } finally {
      if (cookie) await http.post("/auth/logout", {}, { headers: { cookie: "osnova_client_session=" + cookie, origin } }).catch(() => {});
    }
  }
}

export function agentServerOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid application server URL."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an HTTPS origin or loopback HTTP address.");
  }
  return url.origin;
}

export function parseAgentRun(argv: readonly string[]): AgentRunArgs {
  if (argv[0] !== "run" || !/^[a-z][a-z0-9._-]{0,63}$/.test(argv[1] ?? "")) throw new Error("Use: osnova agent run <agent-id> --server <origin> --auth-file <path> --message <text>");
  const options = new Map<string, string>();
  const names = ["--server", "--auth-file", "--message", "--model", "--reasoning"];
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]!, value = argv[index + 1];
    if (!names.includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("Invalid or duplicate agent option.");
    options.set(key, value);
  }
  const server = agentServerOrigin(options.get("--server") ?? "");
  const authFile = options.get("--auth-file"), message = options.get("--message");
  const model = options.get("--model"), reasoningEffort = options.get("--reasoning");
  if (!authFile || authFile.length > 4096 || !message?.trim() || message.length > 8000
    || (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(model))
    || (reasoningEffort !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(reasoningEffort))) throw new Error("Invalid agent arguments.");
  return { agent: argv[1]!, server, authFile, message, model, reasoningEffort };
}
