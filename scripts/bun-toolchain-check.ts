import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// macOS hosts pin the exact OS version and build. Linux hosts pin the libc
// family as osVersion ("glibc") and use osBuild "any": the image, not the
// machine, decides the distribution there; the executable hash stays exact.
type Host = Readonly<{ platform: string; arch: string; osName: "macOS" | "Linux"; osVersion: string; osBuild: string; executableSha256: string }>;
export type Authority = Readonly<{ schemaVersion: "osnova.bun-toolchain/v1"; runtime: Readonly<{ version: "1.4.0"; revision: string }>; qualifiedHosts: readonly Host[] }>;
export type ToolchainFacts = Readonly<{ version: string; revision: string; executableSha256: string; platform: string; arch: string; osName: string; osVersion: string; osBuild: string }>;
export type ToolchainReceipt = Readonly<{ schemaVersion: "osnova.bun-toolchain/v1"; authoritySha256: string; runtime: Readonly<{ version: "1.4.0"; revision: string }>; host: Readonly<Omit<Host, "executableSha256">>; executableSha256: string }>;
const DIAGNOSTICS = new Set(["OSNV_BUN_AUTHORITY_INVALID", "OSNV_BUN_SHA256_MISMATCH", "OSNV_BUN_VERSION_MISMATCH", "OSNV_BUN_REVISION_MISMATCH", "OSNV_BUN_PLATFORM_NOT_QUALIFIED", "OSNV_BUN_OS_FINGERPRINT_MISMATCH"]);
const authorityPath = resolve(import.meta.dir, "../toolchain/bun.json");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => { if (!DIAGNOSTICS.has(code)) throw new Error("OSNV_BUN_AUTHORITY_INVALID"); throw new Error(code); };

export function loadAuthority(path = authorityPath): Readonly<{ authority: Authority; sha256: string }> {
  let raw: string; try { raw = readFileSync(path, "utf8"); } catch { return fail("OSNV_BUN_AUTHORITY_INVALID"); }
  if (raw.charCodeAt(0) === 0xfeff) return fail("OSNV_BUN_AUTHORITY_INVALID");
  assertNoDuplicateJsonKeys(raw);
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return fail("OSNV_BUN_AUTHORITY_INVALID"); }
  if (!isRecord(parsed) || !exactKeys(parsed, ["schemaVersion", "runtime", "qualifiedHosts"]) || parsed.schemaVersion !== "osnova.bun-toolchain/v1" || !isRecord(parsed.runtime) || !exactKeys(parsed.runtime, ["version", "revision"]) || parsed.runtime.version !== "1.4.0" || !isShaRevision(parsed.runtime.revision) || !Array.isArray(parsed.qualifiedHosts) || parsed.qualifiedHosts.length === 0) return fail("OSNV_BUN_AUTHORITY_INVALID");
  const hosts: Host[] = parsed.qualifiedHosts.map((value) => {
    if (!isRecord(value) || !exactKeys(value, ["platform", "arch", "osName", "osVersion", "osBuild", "executableSha256"]) || typeof value.platform !== "string" || typeof value.arch !== "string" || !isOsName(value.osName) || (value.osName === "Linux" && (value.platform !== "linux" || value.osBuild !== "any")) || !isOsValue(value.osVersion) || !isOsValue(value.osBuild) || !isSha(value.executableSha256)) return fail("OSNV_BUN_AUTHORITY_INVALID");
    return Object.freeze({ platform: value.platform, arch: value.arch, osName: value.osName, osVersion: value.osVersion, osBuild: value.osBuild, executableSha256: value.executableSha256 });
  });
  const identities = new Set(hosts.map(hostKey)); if (identities.size !== hosts.length) return fail("OSNV_BUN_AUTHORITY_INVALID");
  return Object.freeze({ authority: Object.freeze({ schemaVersion: parsed.schemaVersion, runtime: Object.freeze({ version: parsed.runtime.version, revision: parsed.runtime.revision }), qualifiedHosts: Object.freeze(hosts) }), sha256: sha256(raw) });
}

export function validateToolchainFacts(authority: Authority, authoritySha256: string, facts: ToolchainFacts): ToolchainReceipt {
  if (!isSha(authoritySha256) || !isSha(facts.executableSha256) || !isShaRevision(facts.revision) || !isOsValue(facts.osVersion) || !isOsValue(facts.osBuild) || !isOsName(facts.osName)) return fail("OSNV_BUN_AUTHORITY_INVALID");
  if (facts.version !== authority.runtime.version) return fail("OSNV_BUN_VERSION_MISMATCH");
  if (facts.revision !== authority.runtime.revision) return fail("OSNV_BUN_REVISION_MISMATCH");
  const matches = authority.qualifiedHosts.filter((host) => host.platform === facts.platform && host.arch === facts.arch && host.osName === facts.osName && host.osVersion === facts.osVersion && (host.osBuild === facts.osBuild || (host.osName === "Linux" && host.osBuild === "any")));
  if (matches.length === 0) return fail(facts.platform === "darwin" && facts.arch === "arm64" ? "OSNV_BUN_OS_FINGERPRINT_MISMATCH" : "OSNV_BUN_PLATFORM_NOT_QUALIFIED");
  if (matches.length !== 1) return fail("OSNV_BUN_AUTHORITY_INVALID");
  if (matches[0]!.executableSha256 !== facts.executableSha256) return fail("OSNV_BUN_SHA256_MISMATCH");
  return Object.freeze({ schemaVersion: authority.schemaVersion, authoritySha256, runtime: authority.runtime, host: Object.freeze({ platform: facts.platform, arch: facts.arch, osName: facts.osName as Host["osName"], osVersion: facts.osVersion, osBuild: facts.osBuild }), executableSha256: facts.executableSha256 });
}

export function verifyCurrentToolchain(): ToolchainReceipt {
  const loaded = loadAuthority();
  const executableSha256 = sha256(readFileSync(process.execPath));
  if (process.platform === "linux") {
    return validateToolchainFacts(loaded.authority, loaded.sha256, Object.freeze({ version: Bun.version, revision: Bun.revision, executableSha256, platform: process.platform, arch: process.arch, osName: "Linux", osVersion: linuxLibc(), osBuild: "any" }));
  }
  const product = Bun.spawnSync(["/usr/bin/sw_vers", "-productVersion"]); const build = Bun.spawnSync(["/usr/bin/sw_vers", "-buildVersion"]);
  const osVersion = new TextDecoder().decode(product.stdout).trim(); const osBuild = new TextDecoder().decode(build.stdout).trim();
  if (product.exitCode !== 0 || build.exitCode !== 0) return fail("OSNV_BUN_OS_FINGERPRINT_MISMATCH");
  return validateToolchainFacts(loaded.authority, loaded.sha256, Object.freeze({ version: Bun.version, revision: Bun.revision, executableSha256, platform: process.platform, arch: process.arch, osName: "macOS", osVersion, osBuild }));
}

export function canonicalToolchainIdentity(receipt: ToolchainReceipt): string { return JSON.stringify(receipt); }
function hostKey(host: Host): string { return `${host.platform}\0${host.arch}\0${host.osName}\0${host.osVersion}\0${host.osBuild}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function isSha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isShaRevision(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40}$/.test(value); }
function isOsName(value: unknown): value is Host["osName"] { return value === "macOS" || value === "Linux"; }
/** glibc ships its dynamic loader as ld-linux-*; musl as ld-musl-*. */
function linuxLibc(): string {
  for (const directory of ["/lib", "/lib64", "/usr/lib"]) {
    let entries: string[] = [];
    try { entries = readdirSync(directory); } catch { continue; }
    if (entries.some((entry) => entry.startsWith("ld-linux"))) return "glibc";
    if (entries.some((entry) => entry.startsWith("ld-musl"))) return "musl";
  }
  return "unknown";
}
function isOsValue(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9.]{1,64}$/.test(value); }
function assertNoDuplicateJsonKeys(source: string): void {
  let offset = 0; const whitespace = () => { while (/\s/.test(source[offset] ?? "")) offset++; };
  const string = (): string => { if (source[offset++] !== '"') return fail("OSNV_BUN_AUTHORITY_INVALID"); let escaped = false; let token = '"'; while (offset < source.length) { const char = source[offset++]!; token += char; if (escaped) { escaped = false; continue; } if (char === "\\") { escaped = true; continue; } if (char === '"') { try { return JSON.parse(token); } catch { return fail("OSNV_BUN_AUTHORITY_INVALID"); } } } return fail("OSNV_BUN_AUTHORITY_INVALID"); };
  const value = (): void => { whitespace(); const char = source[offset]; if (char === "{") { offset++; whitespace(); const keys = new Set<string>(); if (source[offset] === "}") { offset++; return; } while (true) { whitespace(); const key = string(); if (keys.has(key)) fail("OSNV_BUN_AUTHORITY_INVALID"); keys.add(key); whitespace(); if (source[offset++] !== ":") fail("OSNV_BUN_AUTHORITY_INVALID"); value(); whitespace(); if (source[offset] === "}") { offset++; return; } if (source[offset++] !== ",") fail("OSNV_BUN_AUTHORITY_INVALID"); } } if (char === "[") { offset++; whitespace(); if (source[offset] === "]") { offset++; return; } while (true) { value(); whitespace(); if (source[offset] === "]") { offset++; return; } if (source[offset++] !== ",") fail("OSNV_BUN_AUTHORITY_INVALID"); } } if (char === '"') { string(); return; } const primitive = /^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset)); if (!primitive) fail("OSNV_BUN_AUTHORITY_INVALID"); offset += primitive[0].length; };
  value(); whitespace(); if (offset !== source.length) fail("OSNV_BUN_AUTHORITY_INVALID");
}
if (import.meta.main) { try { console.log(canonicalToolchainIdentity(verifyCurrentToolchain())); } catch (error) { console.error(error instanceof Error && DIAGNOSTICS.has(error.message) ? error.message : "OSNV_BUN_AUTHORITY_INVALID"); process.exitCode = 1; } }
