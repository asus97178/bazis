import type { OutgoingHttpHeaders } from "node:http2";

export type MetadataValue = string | Buffer;

/** gRPC metadata. Binary values use -bin keys and base64 only on the wire. */
export class Metadata {
  private readonly values = new Map<string, MetadataValue[]>();

  set(key: string, value: MetadataValue): void {
    key = this.validate(key, value);
    this.values.set(key, [Buffer.isBuffer(value) ? Buffer.from(value) : value]);
  }
  add(key: string, value: MetadataValue): void {
    key = this.validate(key, value);
    const values = this.values.get(key) ?? [];
    values.push(Buffer.isBuffer(value) ? Buffer.from(value) : value);
    this.values.set(key, values);
  }
  get(key: string): MetadataValue[] { return [...(this.values.get(key.toLowerCase()) ?? [])]; }
  remove(key: string): void { this.values.delete(key.toLowerCase()); }
  getMap(): Record<string, MetadataValue> {
    return Object.fromEntries([...this.values].map(([key, values]) => [key, values[0]!]));
  }
  clone(): Metadata {
    const result = new Metadata();
    for (const [key, values] of this.values) for (const value of values) result.add(key, value);
    return result;
  }
  merge(other: Metadata): void {
    for (const [key, values] of other.values) for (const value of values) this.add(key, value);
  }
  toHttp2Headers(): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = Object.create(null);
    for (const [key, values] of this.values) {
      // Application metadata cannot override transport control headers.
      if (reserved(key)) continue;
      headers[key] = values.map((value) => Buffer.isBuffer(value) ? value.toString("base64") : value);
    }
    return headers;
  }
  static fromHttp2Headers(headers: Readonly<Record<string, string | string[] | number | undefined>>): Metadata {
    const result = new Metadata();
    for (const [key, raw] of Object.entries(headers)) {
      if (raw === undefined || reserved(key)) continue;
      for (const value of Array.isArray(raw) ? raw : [String(raw)]) {
        if (key.endsWith("-bin")) {
          for (const part of value.split(",")) {
            const encoded = part.trim();
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.replace(/=+$/, "").length % 4 === 1) {
              throw new TypeError("Invalid binary gRPC metadata.");
            }
            result.add(key, Buffer.from(encoded, "base64"));
          }
        } else if (/^[\x20-\x7e]*$/.test(value)) result.add(key, value);
      }
    }
    return result;
  }
  private validate(key: string, value: MetadataValue): string {
    if (typeof key !== "string" || !/^[0-9a-z_.-]+$/i.test(key)) throw new TypeError("Invalid gRPC metadata key.");
    key = key.toLowerCase();
    if (key.endsWith("-bin") ? !Buffer.isBuffer(value) : typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value)) {
      throw new TypeError("gRPC metadata requires printable text, or Buffer for a -bin key.");
    }
    return key;
  }
}

function reserved(key: string): boolean {
  return key.startsWith(":") || key.startsWith("grpc-")
    && key !== "grpc-status-details-bin"
    || ["content-type", "te", "user-agent"].includes(key);
}
