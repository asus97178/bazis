import { createToken, type InjectionToken } from "../../di";
import type { AppConfig } from "../../kernel";
import type { InfraConnector } from "../InfraConnector";
import { reader, requireValue } from "../connectorConfig";
import { CodexAppServerClient } from "./codex/CodexAppServerClient";
import type { CodexClient, CodexConfigShape } from "./codex/contracts";

/**
 * Codex App Server client of the `codexAppServerConnect()` connector,
 * injected by type like the other infra clients:
 * `constructor(private readonly codex: ICodex)`.
 */
export interface ICodex extends CodexClient {}
export const ICodex = createToken<ICodex>("ICodex") as InjectionToken<CodexClient>;

/** App Server is a full executor; it does not implement the raw AgentModelProvider port. */
export function codexAppServerConnect(config: AppConfig<CodexConfigShape>): InfraConnector<CodexClient> {
  return {
    token: ICodex, config, phase: 0,
    create(configs) {
      const view = reader(config, configs);
      return new CodexAppServerClient({
        enabled: view.get("enabled") as boolean,
        binary: requireValue(view.get("binary"), "binary", "codex-app-server"),
        stateDirectory: requireValue(view.get("stateDirectory"), "stateDirectory", "codex-app-server"),
      });
    },
    connect(client, signal) { return (client as CodexAppServerClient).connect(signal); },
    dispose(client) { return (client as CodexAppServerClient).dispose(); },
    healthCheck(client, signal) { return (client as CodexAppServerClient).healthy(signal); },
  };
}
