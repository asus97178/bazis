import type { AgentToolContract } from "../../agent";

export interface ToolNameMapping {
  readonly providerToBazis: ReadonlyMap<string, string>;
  readonly bazisToProvider: ReadonlyMap<string, string>;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** A Tool name as providers accept it: Latin letters, digits, `_` and `-`, at most 64 characters, unique in a request. */
export function providerToolName(name: string, used: Set<string>): string {
  const replaced = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const prefixed = /^[a-zA-Z_]/.test(replaced) ? replaced : `tool_${replaced}`;
  const trimmed = prefixed.length <= 64 ? prefixed : `${prefixed.slice(0, 55)}_${shortHash(name)}`;
  if (!used.has(trimmed)) {
    used.add(trimmed);
    return trimmed;
  }

  const suffix = shortHash(name);
  const base = trimmed.slice(0, Math.max(1, 63 - suffix.length));
  const unique = `${base}_${suffix}`;
  if (used.has(unique)) {
    throw new Error(`Tool name "${name}" collides with another Tool after its name is made acceptable to the model provider.`);
  }
  used.add(unique);
  return unique;
}

/** Names of a request's Tools as the provider sees them, and the way back. */
export function toolNameMapping(tools: readonly AgentToolContract[]): ToolNameMapping {
  const providerToBazis = new Map<string, string>();
  const bazisToProvider = new Map<string, string>();
  const used = new Set<string>();
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index] as AgentToolContract;
    const providerName = providerToolName(tool.name, used);
    providerToBazis.set(providerName, tool.name);
    bazisToProvider.set(tool.name, providerName);
  }
  return Object.freeze({ providerToBazis, bazisToProvider });
}
