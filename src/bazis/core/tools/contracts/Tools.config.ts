import { configList, defineConfig } from "../../kernel";

/**
 * Settings of the standard Tools. `http.allow` is the list of hosts `http.request`
 * may reach, comma-separated in the environment: `api.example.com`, `*.example.com`,
 * `localhost:8080`.
 * Empty by default: requests go nowhere. `http.allowPrivateNetworks` lets it reach
 * private and loopback addresses of a listed host: intranet services, tests.
 * `http.callers` says who may call it: `workflow`, `agent`.
 */
export interface ToolsSettings {
  readonly "http.allow": readonly string[];
  readonly "http.callers": readonly string[];
  readonly "http.allowPrivateNetworks": boolean;
  readonly "http.maxResponseBytes": number;
  readonly "http.timeoutMs": number;
}

/** A host, a subdomain pattern or an IPv6 address in brackets, with an optional port. */
const HOST = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

export const toolsConfig = defineConfig<ToolsSettings>("tools", {
  default: {
    "http.allow": configList(),
    "http.callers": configList(["workflow"]),
    "http.allowPrivateNetworks": false,
    "http.maxResponseBytes": 1_048_576,
    "http.timeoutMs": 30_000,
  },
  validate: {
    "http.allow": (value) => value.find((item) => !HOST.test(item)) === undefined ? undefined : `must list hosts like api.example.com, *.example.com or localhost:8080; ${JSON.stringify(value.find((item) => !HOST.test(item)))} is not one`,
    "http.callers": (value) => (value.every((item) => /^[a-z][a-z0-9_.-]{0,63}$/.test(item)) ? undefined : "must list caller ids like workflow, agent"),
    "http.maxResponseBytes": (value) => (Number.isSafeInteger(value) && value >= 1 && value <= 104_857_600 ? undefined : "must be an integer 1–104857600"),
    "http.timeoutMs": (value) => (Number.isSafeInteger(value) && value >= 1 && value <= 600_000 ? undefined : "must be an integer 1–600000"),
  },
});
