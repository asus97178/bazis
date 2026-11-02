import { defineConfig } from "../../kernel";

/**
 * Settings of the standard Tools. `http.allow` is the comma-separated list of hosts
 * `http.request` may reach: `api.example.com`, `*.example.com`, `localhost:8080`.
 * Empty by default: requests go nowhere. `http.allowPrivateNetworks` lets it reach
 * private and loopback addresses of a listed host: intranet services, tests.
 * `http.callers` says who may call it: `workflow`, `agent`.
 */
export interface ToolsSettings {
  readonly "http.allow": string;
  readonly "http.callers": string;
  readonly "http.allowPrivateNetworks": boolean;
  readonly "http.maxResponseBytes": number;
  readonly "http.timeoutMs": number;
}

export const toolsConfig = defineConfig<ToolsSettings>("tools", {
  default: {
    "http.allow": "",
    "http.callers": "workflow",
    "http.allowPrivateNetworks": false,
    "http.maxResponseBytes": 1_048_576,
    "http.timeoutMs": 30_000,
  },
  validate: {
    "http.maxResponseBytes": (value) => (Number.isSafeInteger(value) && value >= 1 && value <= 104_857_600 ? undefined : "must be an integer 1–104857600"),
    "http.timeoutMs": (value) => (Number.isSafeInteger(value) && value >= 1 && value <= 600_000 ? undefined : "must be an integer 1–600000"),
  },
});
