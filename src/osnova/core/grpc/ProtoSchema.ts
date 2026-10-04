export interface ProtoField {
  readonly name: string;
  readonly number: number;
  readonly type: string;
  readonly repeated: boolean;
  readonly optional: boolean;
  readonly oneof?: string;
  readonly mapKey?: string;
  readonly packed: boolean;
}
export interface ProtoMessage { readonly name: string; readonly fields: ProtoField[] }
export interface ProtoEnum { readonly name: string; readonly values: Record<string, number> }
export interface ProtoRpc { readonly name: string; readonly input: string; readonly output: string; readonly requestStream: boolean; readonly responseStream: boolean }
export interface ProtoSchema {
  readonly messages: Map<string, ProtoMessage>;
  readonly enums: Map<string, ProtoEnum>;
  readonly services: Map<string, ProtoRpc[]>;
}
export interface ProtoLoaderOptions {
  readonly keepCase?: boolean;
  readonly defaults?: boolean;
  readonly arrays?: boolean;
  readonly objects?: boolean;
  readonly oneofs?: boolean;
  /** Exact 64-bit values are bigint by default; String and Number are opt-in. */
  readonly longs?: typeof String | typeof Number | typeof BigInt;
  readonly enums?: typeof String | typeof Number;
  readonly bytes?: typeof String | typeof Array | typeof Buffer;
  readonly includeDirs?: readonly string[];
}

export const SCALAR_TYPES = new Set([
  "double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64",
  "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes",
]);

export function resolveProtoType(schema: ProtoSchema, type: string, owner: string): string {
  if (SCALAR_TYPES.has(type)) return type;
  const has = (name: string): boolean => schema.messages.has(name) || schema.enums.has(name);
  if (type.startsWith(".")) {
    if (has(type.slice(1))) return type.slice(1);
  } else {
    const parts = owner.split(".");
    while (parts.length > 0) {
      const name = [...parts, type].join(".");
      if (has(name)) return name;
      parts.pop();
    }
    if (has(type)) return type;
  }
  throw new TypeError("Unknown protobuf type " + type + " in " + owner + ".");
}
