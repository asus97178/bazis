import { describe, expect, test } from "bun:test";
import { createContainer, Module } from "@/core/di";
import { Column, DbContext, defineOrmOwnedStoreV1, Entity, Index, Key, OrmOwnedStoreAdmissionError, ormModule, type DatabaseProvider } from "@/core/orm";
import { explainOwnedStoreFailureV1 } from "@/library/orm/Schema/OwnedStoreExplain";

const provider = { name: "postgres", dialect: { name: "postgres" }, query: async () => [], execute: async () => ({ changes: 0, lastInsertId: 0 }), transaction: async <T>(work: never) => work as T, ping: async () => true, close: async () => undefined, introspect: async () => ({ tables: new Map() }) } as unknown as DatabaseProvider;
const store = (storeKey: string, tablePrefix: string, extra: object = {}) => defineOrmOwnedStoreV1({ contract: "bazis.orm-owned-store/v1", storeKey, formatVersion: 1, ownedScope: { schema: "public", tablePrefix }, ...extra });

@Entity({ table: "notes_items" }) class NoteItem { @Key() id = 0; @Column({ type: "text" }) text = ""; }
@Entity({ table: "outside_items" }) class OutsideItem { @Key() id = 0; }
@Entity({ table: "notesv2_items" }) class NoteV2Item { @Key() id = 0; }
class NotesDb extends DbContext {}
class OtherDb extends DbContext {}

function failure(build: () => unknown): OrmOwnedStoreAdmissionError {
  try { build(); } catch (error) { if (error instanceof OrmOwnedStoreAdmissionError) return error; throw error; }
  throw new Error("expected an owned-store error");
}
function app(...entries: object[]) {
  @Module({ imports: [ormModule({ provider, healthCheck: false })], ormBazis: entries as never })
  class Root {}
  return () => createContainer(Root);
}

describe("owned-store definition errors name the field", () => {
  test("each invalid field gets its reason after the code", () => {
    const valid = { contract: "bazis.orm-owned-store/v1" as const, storeKey: "acme.notes", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "notes_" } };
    const cases: [object, string][] = [
      [{ ...valid, contract: "v2" }, 'contract must be "bazis.orm-owned-store/v1"'],
      [{ ...valid, storeKey: "" }, "storeKey must be a string of 1 to 128 bytes without control characters"],
      [{ ...valid, formatVersion: 0 }, "formatVersion must be a positive integer"],
      [{ ...valid, ownedScope: { schema: "public", tablePrefix: "" } }, "ownedScope.schema and ownedScope.tablePrefix must be strings of 1 to 63 bytes"],
      [{ ...valid, extra: true }, 'the definition has an unknown field "extra"; allowed: contract, storeKey, formatVersion, ownedScope, rejectIfPresent'],
      [{ contract: valid.contract, storeKey: "k", formatVersion: 1 }, "the definition is missing the field ownedScope"],
      [{ ...valid, ownedScope: { schema: "public", tablePrefix: "x\n" } }, "ownedScope.schema and ownedScope.tablePrefix must be strings"],
    ];
    for (const [input, reason] of cases) {
      const error = failure(() => defineOrmOwnedStoreV1(input as never));
      expect(error.code).toBe("ORM_OWNED_STORE_IDENTITY_MISMATCH");
      expect(error.message).toStartWith("ORM_OWNED_STORE_IDENTITY_MISMATCH: owned store definition is invalid: ");
      expect(error.message).toContain(reason);
    }
    const own = failure(() => defineOrmOwnedStoreV1({ ...valid, rejectIfPresent: [valid.ownedScope] }));
    expect([own.code, own.message]).toEqual(["ORM_OWNED_STORE_OWNERSHIP_CONFLICT", 'ORM_OWNED_STORE_OWNERSHIP_CONFLICT: owned store definition is invalid: rejectIfPresent of "acme.notes" lists its own ownedScope.']);
    const hostile = failure(() => defineOrmOwnedStoreV1(new Proxy(valid, {}) as never));
    expect(hostile.message).toBe("ORM_OWNED_STORE_IDENTITY_MISMATCH");
  });
});

describe("owned-store graph errors name stores and tables", () => {
  test("an entity table outside the prefix", () => {
    expect(failure(app({ context: NotesDb, entities: [OutsideItem], ownedStore: store("acme.notes", "notes_"), registerRepositories: false })).message).toBe('ORM_OWNED_STORE_OWNERSHIP_CONFLICT: Owned store "acme.notes" (schema "public", prefix "notes_"): entity table "public"."outside_items" lies outside the store scope; name its tables with the prefix, for example "notes_outside_items".');
  });
  test("overlapping prefixes of two stores", () => {
    const message = failure(app(
      { context: NotesDb, entities: [NoteItem], ownedStore: store("acme.notes", "notes_"), registerRepositories: false },
      { context: OtherDb, entities: [NoteV2Item], ownedStore: store("acme.notes.v2", "notes"), registerRepositories: false },
    )).message;
    expect(message).toStartWith('ORM_OWNED_STORE_OWNERSHIP_CONFLICT: Owned store "acme.notes" (schema "public", prefix "notes_") overlaps the scope of owned store "acme.notes.v2" (schema "public", prefix "notes"); two prefixes overlap when one starts with the other');
  });
  test("a partial index in a store table", () => {
    // 0.115.0: @Index({ where }) is for ordinary contexts; owned stores refuse it.
    @Entity({ table: "notes_flags" })
    @Index<{ id: number; done: boolean }>(["id"], { unique: true, where: (f) => f.done.eq(false) })
    class NoteFlag { @Key() id = 0; @Column({ type: "boolean" }) done = false; }
    expect(failure(app({ context: NotesDb, entities: [NoteFlag], ownedStore: store("acme.notes", "notes_"), registerRepositories: false })).message).toBe('ORM_OWNED_STORE_IDENTITY_MISMATCH: Owned store "acme.notes" (schema "public", prefix "notes_"): index "ix_notes_flags_id" on "notes_flags" has a where condition; owned stores do not support partial indexes.');
  });
  test("a store key declared twice", () => {
    expect(failure(app(
      { context: NotesDb, entities: [NoteItem], ownedStore: store("acme.notes", "notes_"), registerRepositories: false },
      { context: OtherDb, entities: [NoteV2Item], ownedStore: store("acme.notes", "notesv2_"), registerRepositories: false },
    )).message).toBe('ORM_OWNED_STORE_OWNERSHIP_CONFLICT: Owned store key "acme.notes" is declared by more than one ormBazis entry.');
  });
  test("a prefix that would cover the registry", () => {
    expect(failure(app({ context: NotesDb, entities: [NoteItem], ownedStore: store("acme.notes", "__bazis"), registerRepositories: false })).message).toContain("would own the bazis registry table __bazis_orm_owned_stores_v1; choose another tablePrefix");
  });
  test("an ordinary context mapping a store table", () => {
    expect(failure(app(
      { context: NotesDb, entities: [NoteItem], ownedStore: store("acme.notes", "notes_"), registerRepositories: false },
      { context: OtherDb, entities: [NoteItem], registerRepositories: false },
    )).message).toBe('ORM_OWNED_STORE_OWNERSHIP_CONFLICT: OtherDb maps table "public"."notes_items", which belongs to owned store "acme.notes"; only the store\'s own context may map it.');
  });
});

describe("admission failures are explained from trusted snapshots", () => {
  const definition = store("acme.notes", "notes_");
  const prepared = [{ definition, modelHash: "sha256:new", ownedScopeHash: "sha256:scope" }];
  const row = (fields: object = {}) => ({ storeKey: "acme.notes", contract: "bazis.orm-owned-store/v1" as const, formatVersion: "1", ownedSchema: "public", tablePrefix: "notes_", ownedScopeHash: "sha256:scope", modelHash: "sha256:new", createdAtEpochMicroseconds: "0", ...fields });
  const registry = (...rows: object[]) => ({ contract: "bazis.orm-owned-store-registry-snapshot/v1" as const, publicSchemaExists: true, state: { kind: "present" as const, shape: {} as never, rows: rows as never } });
  const catalogue = (...names: string[]) => ({ relations: names.map((name) => ({ kind: "ordinaryTable", schema: "public", name })) }) as never;

  test("a changed model, format version or scope", () => {
    expect(explainOwnedStoreFailureV1("ORM_OWNED_STORE_IDENTITY_MISMATCH", { stores: prepared, registry: registry(row({ modelHash: "sha256:old" })) }).message).toStartWith('ORM_OWNED_STORE_IDENTITY_MISMATCH: Owned store "acme.notes" (schema "public", prefix "notes_"): its model changed since the store was created (tables, columns, keys, indexes or their names). An owned store does not change in place: declare a new storeKey');
    expect(explainOwnedStoreFailureV1("ORM_OWNED_STORE_IDENTITY_MISMATCH", { stores: prepared, registry: registry(row({ formatVersion: "2" })) }).message).toContain("is registered with format version 2, the code declares 1.");
  });
  test("unregistered tables in the scope, with database names escaped and bounded", () => {
    const message = explainOwnedStoreFailureV1("ORM_OWNED_STORE_IDENTITY_MISSING", { stores: prepared, registry: registry(), catalogue: catalogue("notes_items", "notes_x\n[INFO] login ok", `notes_${"y".repeat(80)}`) }).message;
    expect(message).toContain('its scope already contains tables that no owned store registered: "notes_items", "notes_x\\n[INFO] login ok", "notes_yyyy');
    expect(message).toContain("…");
    expect(message).not.toContain("\n");
  });
  test("an overlapping registered store and leftovers of a rejected scope", () => {
    expect(explainOwnedStoreFailureV1("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", { stores: [{ ...prepared[0]!, definition: store("acme.notes.v2", "notes_v2_") }], registry: registry(row()) }).message).toContain('overlaps the registered owned store "acme.notes" (schema "public", prefix "notes_")');
    const rejecting = store("acme.notes.v2", "notesv2_", { rejectIfPresent: [{ schema: "public", tablePrefix: "notes_" }] });
    expect(explainOwnedStoreFailureV1("ORM_OWNED_STORE_OWNERSHIP_CONFLICT", { stores: [{ ...prepared[0]!, definition: rejecting }], registry: registry(), catalogue: catalogue("notes_items") }).message).toContain('does not start while tables of the rejected scope (schema "public", prefix "notes_") exist: "notes_items". Move their data and drop them');
  });
  test("nothing observed keeps the bare code", () => {
    expect(explainOwnedStoreFailureV1("ORM_OWNED_STORE_DRIFT", {}).message).toBe("ORM_OWNED_STORE_DRIFT");
  });
});

test("ormModule says why an owned store cannot be combined with schema options or its own provider", () => {
  const owned = { context: NotesDb, entities: [NoteItem], ownedStore: store("acme.notes", "notes_") };
  expect(() => ormModule({ ...owned, ensureCreated: true })).toThrow("ORM owned store creates and verifies its own tables; remove ensureCreated, migrateOnStart and migrations from this ormBazis entry.");
  expect(() => ormModule({ ...owned, provider })).toThrow("ORM owned store uses the shared DATABASE_PROVIDER from @Infra; remove provider from this ormBazis entry.");
});
