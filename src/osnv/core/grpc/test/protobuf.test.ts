import { expect, test } from "bun:test";
import { loadGrpcPackage, grpcService, Metadata, ServerCredentials, type ProtoLoaderOptions } from "../index";
import { ProtoParser } from "../ProtoParser";
import type { ProtoSchema } from "../ProtoSchema";
import { encodeEcho } from "./fixtures/nativeClient";
import { echoService } from "./fixtures/contract";
import filename from "./fixtures/types.proto" with { type: "file" };

const types = (options: ProtoLoaderOptions = {}) => grpcService(loadGrpcPackage(filename, options), "fixtures.Types").RoundTrip!;

test("protobuf bytes agree with independent Echo codec and fixed protocol vectors", () => {
  const codec = echoService.Echo!;
  expect(codec.requestSerialize({text: "A", count: 150}).toString("hex")).toBe("0a0141109601");
  expect(codec.requestDeserialize(Buffer.from("0a0141109601", "hex"))).toEqual({text: "A", count: 150});
  for (const count of [0, 1, 127, 128, 2147483647, -1, -2147483648]) {
    const message = {text: "Привет \u{1f30e}", count};
    expect(codec.requestSerialize(message)).toEqual(encodeEcho(message));
    expect(codec.requestDeserialize(encodeEcho(message))).toEqual(message);
  }
});

test("all scalar families, nested types, enums, repeated, maps and oneof round-trip", () => {
  const codec = types({oneofs: true});
  const source = {
    d: 1.25, f: 2.5, i32: -2147483648, i64: -9223372036854775808n,
    u32: 4294967295, u64: 18446744073709551615n, s32: -123, s64: -123456789n,
    fx32: 4000000000, fx64: 18446744073709551615n, sfx32: -44, sfx64: -555n,
    enabled: true, displayName: "Unicode \u{1f30e}", payload: Buffer.from([0, 255]), state: 1,
    numbers: [-1, 0, 150], unpacked: [1, 300], byKey: {a: {text: "A", count: 2}},
    label: "chosen", explicitZero: 0, inner: {text: "inner"},
  };
  expect(codec.requestDeserialize(codec.requestSerialize(source))).toEqual({...source, selection: "label"});
});

test("wire vectors cover zigzag, packed values, little-endian fixed values and exact 64-bit", () => {
  const codec = types();
  expect(codec.requestSerialize({s32:-1,s64:-2}).toString("hex")).toBe("38014003");
  expect(codec.requestSerialize({fx32:0x12345678}).toString("hex")).toBe("4d78563412");
  expect(codec.requestSerialize({u64:18446744073709551615n}).toString("hex")).toBe("30ffffffffffffffffff01");
  expect(codec.requestSerialize({numbers:[-1,0,150]}).toString("hex")).toBe("8a01040100ac02");
  expect(codec.requestDeserialize(Buffer.from("8801018801008801ac02", "hex")).numbers).toEqual([-1,0,150]);
  expect(codec.requestDeserialize(Buffer.from("92010301ac02", "hex")).unpacked).toEqual([1,300]);
});

test("loader options control names, defaults and representations without library types", () => {
  const codec = types({keepCase:true, defaults:true, oneofs:true, longs:String, enums:String, bytes:String});
  const decoded = codec.requestDeserialize(codec.requestSerialize({display_name:"x", i64:"-7", payload:"AP8=", state:"ACTIVE"}));
  expect(decoded).toMatchObject({display_name:"x", i64:"-7", u64:"0", state:"ACTIVE", payload:"AP8=", numbers:[], by_key:{}});
  expect(decoded).not.toHaveProperty("explicit_zero");
  expect(decoded).not.toHaveProperty("label");
  expect(types({longs:Number}).requestDeserialize(types().requestSerialize({i64:42n})).i64).toBe(42);
  expect(types({bytes:Array}).requestDeserialize(types().requestSerialize({payload:Buffer.from([1,2])})).payload).toEqual([1,2]);
});

test("unknown fields skip, duplicate messages merge, oneof keeps last, maps resist prototype pollution", () => {
  const codec = echoService.Echo!;
  expect(codec.requestDeserialize(Buffer.from("0a0141109601980601a1060000000000000000aa060100b50601000000", "hex"))).toEqual({text:"A",count:150});
  const complex = types({oneofs:true});
  const first = complex.requestSerialize({nested:{text:"first"}, inner:{text:"retained"}});
  const second = complex.requestSerialize({nested:{count:2}});
  expect(complex.requestDeserialize(Buffer.concat([first, second]))).toMatchObject({nested:{text:"first",count:2}, selection:"nested"});
  expect(complex.requestDeserialize(Buffer.concat([first, complex.requestSerialize({label:"last"})]))).not.toHaveProperty("nested");
  const byKey = JSON.parse('{"__proto__":{"text":"safe"}}');
  const result = complex.requestDeserialize(complex.requestSerialize({byKey}));
  expect(Object.hasOwn(result.byKey as object, "__proto__")).toBe(true);
  expect(({} as Record<string,unknown>).text).toBeUndefined();
});

test("rejects malformed wire, ranges, cycles, unknown loader options and unsupported schemas", () => {
  const codec = echoService.Echo!;
  for (const hex of ["00","0a05ff","1080","10ffffffffffffffffffff02","0d00000000","0a01ff"]) {
    expect(() => codec.requestDeserialize(Buffer.from(hex,"hex"))).toThrow();
  }
  const complex = types();
  for (const input of [{i32:2147483648},{u32:-1},{i64:Number.MAX_SAFE_INTEGER+1},{state:"MISSING"},{label:"a",nested:{}}]) {
    expect(() => complex.requestSerialize(input)).toThrow();
  }
  const cyclic: Record<string, unknown> = {}; cyclic.child = cyclic;
  expect(() => complex.requestSerialize(cyclic)).toThrow("nesting");
  expect(() => loadGrpcPackage(filename, {json:true} as ProtoLoaderOptions)).toThrow("Unsupported");
  for (const source of [
    'syntax="proto2"; message A {}',
    'syntax="proto3"; message A {string a=1; int32 b=1;}',
    'syntax="proto3"; message A {string a=0;}',
    'syntax="proto3"; message A {map<float,string> a=1;}',
    'syntax="proto3"; message A { string broken',
  ]) {
    const schema: ProtoSchema = {messages:new Map(),enums:new Map(),services:new Map()};
    expect(() => new ProtoParser(source,schema,"inline.proto").parse()).toThrow();
  }
  expect(() => grpcService(loadGrpcPackage(filename), "fixtures.Scalars")).toThrow("service not found");
});

test("metadata validates, clones and decodes repeated padded/unpadded binary headers", () => {
  const metadata = new Metadata();
  metadata.set("X-Test","one"); metadata.add("x-test","two"); metadata.set("data-bin",Buffer.from([0,255]));
  expect(metadata.get("X-TEST")).toEqual(["one","two"]);
  expect(Metadata.fromHttp2Headers(metadata.toHttp2Headers()).get("data-bin")).toEqual([Buffer.from([0,255])]);
  expect(Metadata.fromHttp2Headers({"data-bin":"AA, /w=="}).get("data-bin")).toEqual([Buffer.from([0]),Buffer.from([255])]);
  const copy = metadata.clone(); copy.set("x-test","changed");
  expect(metadata.get("x-test")).toEqual(["one","two"]);
  expect(() => metadata.set("data-bin","not binary")).toThrow();
  expect(() => metadata.set("x-test","\r\ninjection")).toThrow();
  expect(() => Metadata.fromHttp2Headers({"data-bin":"!!!"})).toThrow();
  expect(() => ServerCredentials.createSsl(null,[])).toThrow();
});
