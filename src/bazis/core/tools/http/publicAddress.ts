/** A dotted IPv4 address as a number, or `undefined`. */
function ipv4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}

/** An IPv6 address as eight 16-bit groups, or `undefined`. */
function ipv6(text: string): number[] | undefined {
  let source = text.split("%")[0]!;
  // A dotted tail: ::ffff:127.0.0.1.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(source);
  if (tail) {
    const value = ipv4(tail[2]!);
    if (value === undefined) return undefined;
    source = `${tail[1]}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const [head, rest, ...more] = source.split("::");
  if (more.length > 0) return undefined;
  const groups = (part: string | undefined) => (part === undefined || part === "" ? [] : part.split(":"));
  const left = groups(head);
  const right = groups(rest);
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return undefined;
  const all = [...left, ...new Array<string>(rest === undefined ? 0 : missing).fill("0"), ...right];
  return all.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) ? all.map((group) => Number.parseInt(group, 16)) : undefined;
}

function inRange(value: number, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(ipv4(base)! / size);
}

const NOT_PUBLIC_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPublicV4(value: number): boolean {
  return !NOT_PUBLIC_V4.some(([base, bits]) => inRange(value, base, bits));
}

/**
 * Whether an address can be reached from the outside: not loopback, private,
 * link-local, multicast or reserved. An IPv6 address that carries an IPv4 one is
 * judged by it. What cannot be read is not public.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4 !== undefined) return isPublicV4(v4);
  const v6 = ipv6(address);
  if (v6 === undefined) return false;
  const carried = (high: number, low: number) => isPublicV4(high * 65536 + low);
  // ::, ::1 and the old form ::a.b.c.d.
  if (v6.slice(0, 6).every((group) => group === 0)) return v6[6] !== 0 && carried(v6[6]!, v6[7]!);
  // ::ffff:a.b.c.d.
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) return carried(v6[6]!, v6[7]!);
  // 64:ff9b::a.b.c.d.
  if (v6[0] === 0x64 && v6[1] === 0xff9b) return carried(v6[6]!, v6[7]!);
  // 2002:a.b.c.d::.
  if (v6[0] === 0x2002) return carried(v6[1]!, v6[2]!);
  // fc00::/7, fe80::/10, fec0::/10, ff00::/8, 2001:db8::/32.
  if ((v6[0]! & 0xfe00) === 0xfc00 || (v6[0]! & 0xffc0) === 0xfe80 || (v6[0]! & 0xffc0) === 0xfec0 || (v6[0]! & 0xff00) === 0xff00) return false;
  return !(v6[0] === 0x2001 && v6[1] === 0xdb8);
}

/** Whether `tools.http.allow` lets this host and port through: `api.example.com`, `*.example.com`, `localhost:8080`. */
export function hostAllowed(allow: readonly string[], hostname: string, port: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allow.map((item) => item.toLowerCase()).some((item) => {
    // An IPv6 address goes in brackets, as in a URL: [::1]:8080.
    const match = /^\[(.+)\](?::(\d+))?$/.exec(item) ?? /^(.*?)(?::(\d+))?$/.exec(item)!;
    const [name, wanted] = [match[1]!, match[2]];
    if (wanted !== undefined && wanted !== port) return false;
    return name.startsWith("*.") ? host.endsWith(name.slice(1)) && host.length > name.length - 1 : host === name;
  });
}
