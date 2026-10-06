import { expect, test } from "bun:test";
import { defineOrmOwnedStoreV1, OrmOwnedStoreAdmissionError } from "bazis/library/orm";
import { isDefinedOrmOwnedStoreV1 } from "../Schema/OrmOwnedStore";

const valid = () => ({ contract: "bazis.orm-owned-store/v1" as const, storeKey: "fixtures", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "bazis_td_" } });

test("owned-store definition creates a deeply frozen canonical clone", () => {
  const input = { ...valid(), rejectIfPresent: [{ schema: "z", tablePrefix: "z_" }, { schema: "a", tablePrefix: "a_" }, { schema: "z", tablePrefix: "z_" }] };
  const definition = defineOrmOwnedStoreV1(input);
  expect(definition).not.toBe(input);
  expect(definition.rejectIfPresent).toEqual([{ schema: "a", tablePrefix: "a_" }, { schema: "z", tablePrefix: "z_" }]);
  expect(Object.isFrozen(definition)).toBe(true);
  expect(Object.isFrozen(definition.ownedScope)).toBe(true);
  expect(Object.isFrozen(definition.rejectIfPresent!)).toBe(true);
  expect(isDefinedOrmOwnedStoreV1(definition)).toBe(true);
  expect(isDefinedOrmOwnedStoreV1({ ...definition })).toBe(false);
  expect(isDefinedOrmOwnedStoreV1(input)).toBe(false);
  input.ownedScope.schema = "other";
  expect(definition.ownedScope.schema).toBe("public");
});

test("owned-store definition rejects hostile descriptors before value hooks", () => {
  const unsafe = [
    new Proxy(valid(), { get() { throw new Error("hook"); } }),
    { ...valid(), extra: true },
    { ...valid(), ownedScope: Object.create({ schema: "public", tablePrefix: "x_" }) },
    { ...valid(), storeKey: undefined },
    { ...valid(), ownedScope: { schema: "public\0", tablePrefix: "x_" } },
    { ...valid(), ownedScope: { schema: "public", tablePrefix: "x\u007f" } },
    { ...valid(), storeKey: "\ud800" },
    { ...valid(), rejectIfPresent: Object.assign([{ schema: "x", tablePrefix: "x_" }], { extra: true }) },
    { ...valid(), rejectIfPresent: [,, { schema: "x", tablePrefix: "x_" }] },
  ];
  for (const value of unsafe) {
    expect(() => defineOrmOwnedStoreV1(value as never)).toThrow(OrmOwnedStoreAdmissionError);
    try { defineOrmOwnedStoreV1(value as never); } catch (error) { expect((error as OrmOwnedStoreAdmissionError).code).toBe("ORM_OWNED_STORE_IDENTITY_MISMATCH"); }
  }
  expect(defineOrmOwnedStoreV1({ ...valid(), storeKey: "Журнал😀" }).storeKey).toBe("Журнал😀");
});

test("owned-store definition maps true scope ambiguity separately", () => {
  expect(() => defineOrmOwnedStoreV1({ ...valid(), rejectIfPresent: [{ schema: "public", tablePrefix: "bazis_td_" }] })).toThrow("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
});

test("owned-store accepts readonly data and observes no hostile getters", () => {
  const readonly = Object.freeze({ contract: "bazis.orm-owned-store/v1" as const, storeKey: "fixtures", formatVersion: 1, ownedScope: Object.freeze({ schema: "public", tablePrefix: "bazis_td_" }), rejectIfPresent: Object.freeze([Object.freeze({ schema: "archive", tablePrefix: "old_" })]) });
  const first = defineOrmOwnedStoreV1(readonly);
  const second = defineOrmOwnedStoreV1(first);
  expect(second).not.toBe(first);
  let hooks = 0;
  const getter = { ...valid() };
  Object.defineProperty(getter, "storeKey", { enumerable: true, get() { hooks++; return "fixtures"; } });
  expect(() => defineOrmOwnedStoreV1(getter)).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  expect(hooks).toBe(0);
  const extra = [{ schema: "archive", tablePrefix: "old_" }] as Array<{ schema: string; tablePrefix: string }>;
  Object.defineProperty(extra, "4294967295", { enumerable: true, value: "extra" });
  expect(() => defineOrmOwnedStoreV1({ ...valid(), rejectIfPresent: extra })).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("owned-store enforces byte boundaries and exact descriptor controls", () => {
  expect(defineOrmOwnedStoreV1({ ...valid(), storeKey: "a".repeat(128) }).storeKey).toHaveLength(128);
  for (const invalid of ["", "a".repeat(129), "line\nfeed", "\u0085", "\udc00"]) {
    expect(() => defineOrmOwnedStoreV1({ ...valid(), storeKey: invalid })).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  }
  expect(() => defineOrmOwnedStoreV1({ ...valid(), formatVersion: 0 })).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  expect(() => defineOrmOwnedStoreV1({ ...valid(), formatVersion: Number.NaN })).toThrow("ORM_OWNED_STORE_IDENTITY_MISMATCH");
});

test("reject scopes are UTF-8 sorted independently of input order", () => {
  const descriptor = defineOrmOwnedStoreV1({ ...valid(), rejectIfPresent: [{ schema: "я", tablePrefix: "б_" }, { schema: "é", tablePrefix: "a_" }] });
  expect(descriptor.rejectIfPresent).toEqual([{ schema: "é", tablePrefix: "a_" }, { schema: "я", tablePrefix: "б_" }]);
});
