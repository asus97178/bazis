import { ProtoReader } from "./ProtoReader";
import { resolveProtoType, type ProtoSchema, type ProtoField, type ProtoLoaderOptions } from "./ProtoSchema";

type Field = ProtoField & { readonly resolved: string; readonly jsName: string };
const MAX_BYTES = 64 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Local proto3 codec: scalar/nested/repeated/packed/map/oneof fields. */
export class ProtoCodec {
  private readonly plans = new Map<string, { fields: Field[]; byNumber: Map<number, Field> }>();
  constructor(private readonly schema: ProtoSchema, private readonly options: ProtoLoaderOptions) {
    for (const message of schema.messages.values()) {
      const fields = message.fields.map((field) => ({
        ...field, resolved: resolveProtoType(schema, field.type, message.name),
        jsName: options.keepCase ? field.name : camel(field.name),
      }));
      if (new Set(fields.map((field) => field.jsName)).size !== fields.length) throw new TypeError("Protobuf field names collide after case conversion.");
      this.plans.set(message.name, { fields, byNumber: new Map(fields.map((field) => [field.number, field])) });
    }
  }

  encode(name: string, value: unknown, depth = 0): Buffer {
    this.depth(depth);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected protobuf message object.");
    const input = value as Record<string, unknown>;
    const fields = this.plans.get(name)?.fields;
    if (!fields) throw new TypeError("Unknown protobuf message " + name);
    const parts: Buffer[] = [];
    let size = 0;
    const push = (part: Buffer): void => {
      if ((size += part.length) > MAX_BYTES) throw new TypeError("Protobuf message exceeds 64 MiB.");
      parts.push(part);
    };
    const oneofs = new Set<string>();
    for (const field of fields) {
      if (!Object.hasOwn(input, field.jsName) || input[field.jsName] === undefined || input[field.jsName] === null) continue;
      const item = input[field.jsName];
      if (field.oneof) {
        if (oneofs.has(field.oneof)) throw new TypeError("Multiple protobuf oneof values.");
        oneofs.add(field.oneof);
      }
      if (field.mapKey) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Expected protobuf map.");
        for (const [key, value] of Object.entries(item)) {
          const keyValue = field.mapKey === "bool" ? key === "true" ? true : key === "false" ? false : invalid("Invalid boolean map key.") : key;
          const keyBytes = this.scalar(field.mapKey, keyValue, depth + 1);
          const valueBytes = this.scalar(field.resolved, value, depth + 1);
          const entry = Buffer.concat([tag(1, this.wire(field.mapKey)), keyBytes, tag(2, this.wire(field.resolved)), valueBytes]);
          push(tag(field.number, 2)); push(lengthPrefix(entry));
        }
      } else if (field.repeated) {
        if (!Array.isArray(item)) throw new TypeError("Expected repeated protobuf field.");
        if (field.packed && this.wire(field.resolved) !== 2) {
          const values: Buffer[] = []; let packedSize = 0;
          for (const element of item) {
            const bytes = this.scalar(field.resolved, element, depth + 1);
            if ((packedSize += bytes.length) > MAX_BYTES) throw new TypeError("Packed protobuf field exceeds limit.");
            values.push(bytes);
          }
          if (item.length) { push(tag(field.number, 2)); push(lengthPrefix(Buffer.concat(values))); }
        } else for (const element of item) { push(tag(field.number, this.wire(field.resolved))); push(this.scalar(field.resolved, element, depth + 1)); }
      } else {
        push(tag(field.number, this.wire(field.resolved)));
        push(this.scalar(field.resolved, item, depth + 1));
      }
    }
    return Buffer.concat(parts, size);
  }

  decode(name: string, buffer: Buffer, depth = 0, target?: Record<string, unknown>): Record<string, unknown> {
    this.depth(depth);
    if (buffer.length > MAX_BYTES) throw new TypeError("Protobuf message exceeds 64 MiB.");
    const plan = this.plans.get(name);
    if (!plan) throw new TypeError("Unknown protobuf message " + name);
    const result = target ?? {};
    if (!target) for (const field of plan.fields) {
      if (field.mapKey && (this.options.defaults || this.options.objects)) set(result, field.jsName, {});
      else if (field.repeated && (this.options.defaults || this.options.arrays)) set(result, field.jsName, []);
      else if (this.options.defaults && !field.repeated && !field.mapKey && !field.oneof && !field.optional) set(result, field.jsName, this.default(field.resolved));
    }
    const reader = new ProtoReader(buffer);
    while (!reader.done) {
      const raw = reader.varint();
      const number = Number(raw >> 3n), wire = Number(raw & 7n);
      if (number < 1 || number > 536870911) throw new TypeError("Invalid protobuf field tag.");
      const field = plan.byNumber.get(number);
      if (!field) { reader.skip(wire); continue; }
      if (field.mapKey) {
        if (wire !== 2) throw new TypeError("Invalid protobuf map wire type.");
        const entry = new ProtoReader(reader.delimited());
        let key = this.default(field.mapKey), value = this.default(field.resolved);
        while (!entry.done) {
          const entryTag = entry.varint(), number = Number(entryTag >> 3n), wire = Number(entryTag & 7n);
          if (number === 1) key = this.readScalar(field.mapKey, wire, entry, depth + 1);
          else if (number === 2) value = this.readScalar(field.resolved, wire, entry, depth + 1);
          else { if (number < 1) throw new TypeError("Invalid map entry."); entry.skip(wire); }
        }
        const map = Object.hasOwn(result, field.jsName) ? result[field.jsName] as Record<string, unknown> : {};
        set(map, String(key), value); set(result, field.jsName, map);
      } else if (field.repeated) {
        const values = Object.hasOwn(result, field.jsName) ? result[field.jsName] as unknown[] : [];
        if (wire === 2 && this.wire(field.resolved) !== 2) {
          const packed = new ProtoReader(reader.delimited());
          while (!packed.done) values.push(this.readScalar(field.resolved, this.wire(field.resolved), packed, depth + 1));
        } else values.push(this.readScalar(field.resolved, wire, reader, depth + 1));
        set(result, field.jsName, values);
      } else {
        if (field.oneof) {
          for (const sibling of plan.fields) if (sibling.oneof === field.oneof && sibling !== field) delete result[sibling.jsName];
          if (this.options.oneofs) set(result, this.options.keepCase ? field.oneof : camel(field.oneof), field.jsName);
        }
        const previous = this.schema.messages.has(field.resolved) && Object.hasOwn(result, field.jsName) ? result[field.jsName] as Record<string, unknown> | null : undefined;
        set(result, field.jsName, this.readScalar(field.resolved, wire, reader, depth + 1, previous ?? undefined));
      }
    }
    return result;
  }

  private scalar(type: string, value: unknown, depth: number): Buffer {
    if (this.schema.messages.has(type)) return lengthPrefix(this.encode(type, value, depth));
    if (this.schema.enums.has(type)) {
      if (typeof value === "string") {
        const values = this.schema.enums.get(type)!.values;
        if (!Object.hasOwn(values, value)) throw new TypeError("Unknown protobuf enum value.");
        value = values[value];
      }
      return varint(BigInt.asUintN(64, integer(value, 32, true)));
    }
    if (type === "string") {
      if (typeof value !== "string") throw new TypeError("Expected protobuf string.");
      return lengthPrefix(Buffer.from(value, "utf8"));
    }
    if (type === "bytes") {
      if (typeof value === "string") return lengthPrefix(Buffer.from(value, "base64"));
      if (!(value instanceof Uint8Array) && !Array.isArray(value)) throw new TypeError("Expected protobuf bytes.");
      return lengthPrefix(Buffer.from(value));
    }
    if (type === "bool") {
      if (typeof value !== "boolean") throw new TypeError("Expected protobuf boolean.");
      return Buffer.from([value ? 1 : 0]);
    }
    if (type === "float" || type === "double") {
      if (typeof value !== "number") throw new TypeError("Expected protobuf number.");
      const bytes = Buffer.alloc(type === "float" ? 4 : 8);
      if (type === "float") bytes.writeFloatLE(value); else bytes.writeDoubleLE(value);
      return bytes;
    }
    const bits = type.endsWith("64") ? 64 : 32;
    const signed = !type.startsWith("uint") && !type.startsWith("fixed");
    const number = integer(value, bits, signed);
    if (type.includes("fixed")) {
      const bytes = Buffer.alloc(bits / 8);
      if (bits === 64) bytes.writeBigUInt64LE(BigInt.asUintN(64, number));
      else bytes.writeUInt32LE(Number(BigInt.asUintN(32, number)));
      return bytes;
    }
    return varint(type.startsWith("sint") ? (number << 1n) ^ (number >> BigInt(bits - 1)) : BigInt.asUintN(64, number));
  }
  private readScalar(type: string, wire: number, reader: ProtoReader, depth: number, target?: Record<string, unknown>): unknown {
    if (wire !== this.wire(type)) throw new TypeError("Incorrect protobuf wire type.");
    if (this.schema.messages.has(type)) return this.decode(type, reader.delimited(), depth, target);
    if (type === "string") return utf8.decode(reader.delimited());
    if (type === "bytes") {
      const value = reader.delimited();
      return this.options.bytes === String ? value.toString("base64") : this.options.bytes === Array ? [...value] : Buffer.from(value);
    }
    if (type === "double") return reader.bytes(8).readDoubleLE();
    if (type === "float") return reader.bytes(4).readFloatLE();
    if (type === "bool") return reader.varint() !== 0n;
    let value = wire === 1 ? reader.bytes(8).readBigUInt64LE() : wire === 5 ? BigInt(reader.bytes(4).readUInt32LE()) : reader.varint();
    if (this.schema.enums.has(type)) {
      const number = Number(BigInt.asIntN(32, value));
      return this.options.enums === String ? Object.entries(this.schema.enums.get(type)!.values).find(([, n]) => n === number)?.[0] ?? number : number;
    }
    const bits = type.endsWith("64") ? 64 : 32;
    if (type.startsWith("sint")) value = (value >> 1n) ^ -(value & 1n);
    value = type.startsWith("uint") || type.startsWith("fixed") ? BigInt.asUintN(bits, value) : BigInt.asIntN(bits, value);
    if (bits === 32 || this.options.longs === Number) return Number(value);
    return this.options.longs === String ? value.toString() : value;
  }
  private wire(type: string): number {
    if (type === "double" || type.endsWith("fixed64")) return 1;
    if (type === "float" || type.endsWith("fixed32")) return 5;
    if (type === "string" || type === "bytes" || this.schema.messages.has(type)) return 2;
    return 0;
  }
  private default(type: string): unknown {
    if (this.schema.messages.has(type)) return null;
    if (this.schema.enums.has(type)) return this.options.enums === String ? Object.keys(this.schema.enums.get(type)!.values)[0] : 0;
    if (type === "string") return "";
    if (type === "bool") return false;
    if (type === "bytes") return this.options.bytes === String ? "" : this.options.bytes === Array ? [] : Buffer.alloc(0);
    if (type.endsWith("64")) return this.options.longs === String ? "0" : this.options.longs === Number ? 0 : 0n;
    return 0;
  }
  private depth(depth: number): void { if (depth > 64) throw new TypeError("Protobuf message nesting exceeds 64."); }
}

function integer(value: unknown, bits: number, signed: boolean): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new TypeError("Use bigint or string for exact protobuf 64-bit integers.");
  if (typeof value !== "number" && typeof value !== "bigint" && (typeof value !== "string" || !/^-?\d+$/.test(value))) throw new TypeError("Expected protobuf integer.");
  const number = BigInt(value);
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = (1n << BigInt(signed ? bits - 1 : bits)) - 1n;
  if (number < min || number > max) throw new TypeError("Protobuf integer out of range.");
  return number;
}
function varint(value: bigint): Buffer {
  const bytes: number[] = [];
  do {
    const byte = Number(value & 127n); value >>= 7n;
    bytes.push(value ? byte | 128 : byte);
  } while (value !== 0n);
  return Buffer.from(bytes);
}
function tag(number: number, wire: number): Buffer { return varint(BigInt(number) * 8n + BigInt(wire)); }
function lengthPrefix(bytes: Buffer): Buffer {
  if (bytes.length > MAX_BYTES) throw new TypeError("Protobuf field exceeds 64 MiB.");
  return Buffer.concat([varint(BigInt(bytes.length)), bytes]);
}
function camel(name: string): string { return name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()); }
function set(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
function invalid(message: string): never { throw new TypeError(message); }
