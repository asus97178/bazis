import { isIP } from "node:net";
import { HttpSetupError } from "../Errors/HttpError";

/** Addresses and subnets whose `X-Forwarded-For` is believed (`http.trustedProxies`). */
export interface TrustedProxies {
  trusts(address: string): boolean;
}

interface Subnet {
  readonly family: 4 | 6;
  readonly base: bigint;
  readonly mask: bigint;
}

/**
 * Compiles `http.trustedProxies`: IP addresses (`127.0.0.1`, `::1`) and
 * subnets (`10.0.0.0/8`, `fd00::/8`). An invalid entry stops the start.
 */
export function trustedProxies(entries: readonly string[]): TrustedProxies {
  const subnets = entries.map((entry) => {
    const subnet = parseSubnet(entry);
    if (subnet === undefined) {
      throw new HttpSetupError(`http.trustedProxies: ${JSON.stringify(entry)} is not an IP address or a subnet such as "10.0.0.0/8".`);
    }
    return subnet;
  });
  return Object.freeze({
    trusts(address: string): boolean {
      const parsed = parseAddress(address);
      return parsed !== undefined && subnets.some((subnet) => subnet.family === parsed.family && (parsed.value & subnet.mask) === subnet.base);
    },
  });
}

/**
 * The client's address. A connection from a trusted proxy is resolved through
 * `X-Forwarded-For` from the right: trusted hops are skipped and the first
 * untrusted address is the client, so entries a client sent itself in front
 * are never believed. A connection from any other address keeps that address:
 * a client reaching the app directly cannot forge it. A malformed entry stops
 * the walk at the last address known for sure.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | null | undefined, trusted: TrustedProxies | undefined): string | undefined {
  if (peer === undefined) return undefined;
  const direct = normalizeAddress(peer);
  if (trusted === undefined || !trusted.trusts(direct) || !forwardedFor) return direct;
  let current = direct;
  const hops = forwardedFor.split(",").map((hop) => hop.trim());
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index]!;
    if (isIP(hop) === 0) return current;
    current = normalizeAddress(hop);
    if (!trusted.trusts(current)) return current;
  }
  return current;
}

/** `::ffff:127.0.0.1` (IPv4 over a dual-stack socket) is `127.0.0.1`; IPv6 is lower-case. */
function normalizeAddress(address: string): string {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu);
  return mapped ? mapped[1]! : address.toLowerCase();
}

function parseSubnet(entry: string): Subnet | undefined {
  const [address, prefixText, extra] = entry.trim().split("/");
  if (extra !== undefined || address === undefined) return undefined;
  const parsed = parseAddress(address);
  if (parsed === undefined) return undefined;
  const bits = parsed.family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : /^\d+$/u.test(prefixText) ? Number(prefixText) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return undefined;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { family: parsed.family, base: parsed.value & mask, mask };
}

function parseAddress(text: string): { readonly family: 4 | 6; readonly value: bigint } | undefined {
  const address = normalizeAddress(text.trim());
  const family = isIP(address);
  if (family === 4) {
    return { family: 4, value: address.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n) };
  }
  if (family !== 6) return undefined;
  const [head = "", tail] = address.split("::");
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  // An embedded IPv4 tail (::ffff:… already normalized away, but 64:ff9b::1.2.3.4 is valid).
  const expand = (items: string[]) => items.flatMap((item) => (item.includes(".") ? ipv4Groups(item) : [item]));
  const leftGroups = expand(left);
  const rightGroups = expand(right);
  const missing = 8 - leftGroups.length - rightGroups.length;
  const all = tail === undefined ? leftGroups : [...leftGroups, ...Array.from({ length: missing }, () => "0"), ...rightGroups];
  if (all.length !== 8) return undefined;
  return { family: 6, value: all.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n) };
}

function ipv4Groups(address: string): string[] {
  const [a, b, c, d] = address.split(".").map(Number) as [number, number, number, number];
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}
