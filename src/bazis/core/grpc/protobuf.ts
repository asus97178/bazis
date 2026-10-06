import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ServiceDefinition, PackageDefinition } from "./serviceDefinition";
import { ProtoParser } from "./ProtoParser";
import { ProtoCodec } from "./ProtoCodec";
import { resolveProtoType, type ProtoSchema, type ProtoLoaderOptions } from "./ProtoSchema";

/** Select a service by its fully qualified protobuf name. */
export function grpcService(definition: PackageDefinition, serviceName: string): ServiceDefinition {
  const service = definition[serviceName];
  if (!service || "format" in service || Object.keys(service).length === 0) {
    throw new TypeError(`Protobuf service not found: ${serviceName}.`);
  }
  return service as ServiceDefinition;
}

/** Load proto3 contracts without a package dependency or external compiler. */
export function loadGrpcPackage(filename: string | readonly string[], options: ProtoLoaderOptions = {}): PackageDefinition {
  validateOptions(options);
  options = Object.freeze({ ...options, includeDirs: options.includeDirs && Object.freeze([...options.includeDirs]) });
  const roots = typeof filename === "string" ? [filename] : filename;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((file) => typeof file !== "string" || !file)) throw new TypeError("Expected protobuf filename(s).");
  const schema: ProtoSchema = { messages: new Map(), enums: new Map(), services: new Map() };
  const loaded = new Set<string>();
  let schemaBytes = 0;
  const load = (file: string, depth: number): void => {
    file = path.resolve(file);
    if (loaded.has(file)) return;
    if (depth > 64 || loaded.size >= 256) throw new TypeError("Protobuf import graph exceeds limit.");
    loaded.add(file);
    const source = readFileSync(file, "utf8");
    if ((schemaBytes += Buffer.byteLength(source)) > 16 * 1024 * 1024) throw new TypeError("Protobuf schema graph exceeds 16 MiB.");
    const parser = new ProtoParser(source, schema, file);
    parser.parse();
    for (const imported of parser.imports) {
      const candidates = [path.resolve(path.dirname(file), imported), ...(options.includeDirs ?? []).map((dir) => path.resolve(dir, imported))];
      const resolved = candidates.find((candidate) => existsSync(candidate));
      if (!resolved) throw new TypeError("Protobuf import not found: " + imported);
      load(resolved, depth + 1);
    }
  };
  for (const root of roots) load(root, 0);
  const codec = new ProtoCodec(schema, options);
  const definition: PackageDefinition = Object.create(null);
  for (const name of schema.messages.keys()) definition[name] = { format: "Bazis proto3 message" };
  for (const name of schema.enums.keys()) definition[name] = { format: "Bazis proto3 enum" };
  for (const [name, methods] of schema.services) {
    const service: ServiceDefinition = Object.create(null);
    for (const method of methods) {
      const input = resolveProtoType(schema, method.input, name);
      const output = resolveProtoType(schema, method.output, name);
      if (!schema.messages.has(input) || !schema.messages.has(output)) throw new TypeError("RPC input/output must be protobuf messages.");
      service[method.name] = {
        path: "/" + name + "/" + method.name,
        originalName: method.name[0]!.toLowerCase() + method.name.slice(1),
        requestStream: method.requestStream, responseStream: method.responseStream,
        requestSerialize: (value) => codec.encode(input, value),
        requestDeserialize: (buffer) => codec.decode(input, buffer),
        responseSerialize: (value) => codec.encode(output, value),
        responseDeserialize: (buffer) => codec.decode(output, buffer),
      };
    }
    definition[name] = service;
  }
  return definition;
}

function validateOptions(options: ProtoLoaderOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Invalid protobuf options.");
  const booleans = new Set(["keepCase", "defaults", "arrays", "objects", "oneofs"]);
  const known = new Set([...booleans, "longs", "enums", "bytes", "includeDirs"]);
  for (const [key, value] of Object.entries(options)) {
    if (!known.has(key)) throw new TypeError("Unsupported protobuf option: " + key);
    if (booleans.has(key) && typeof value !== "boolean") throw new TypeError("Invalid protobuf option: " + key);
  }
  if (options.longs !== undefined && ![String, Number, BigInt].includes(options.longs)) throw new TypeError("Invalid protobuf longs option.");
  if (options.enums !== undefined && ![String, Number].includes(options.enums)) throw new TypeError("Invalid protobuf enums option.");
  if (options.bytes !== undefined && ![String, Array, Buffer].includes(options.bytes)) throw new TypeError("Invalid protobuf bytes option.");
  if (options.includeDirs !== undefined && (!Array.isArray(options.includeDirs) || options.includeDirs.some((dir) => typeof dir !== "string" || !dir))) throw new TypeError("Invalid protobuf includeDirs.");
}
