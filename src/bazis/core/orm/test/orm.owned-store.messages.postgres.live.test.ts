import { afterAll, describe, expect, test } from "bun:test";
import { createContainer, Global, Module, singletonValue } from "@/core/di";
import { Configuration, defineConfig, LifecycleCoordinator, secret } from "@/core/kernel";
import { Infra } from "@/core/infra";
import { Column, DbContext, defineOrmOwnedStoreV1, Entity, Key, ormBazisConnect, OrmOwnedStoreAdmissionError, postgres } from "@/core/orm";

const url = process.env.BAZIS_PG_URL;
const live = url === undefined ? test.skip : test;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const p = `osm${run}`;
const registry = "__bazis_orm_owned_stores_v1";

@Entity({ table: `${p}a_items` }) class ItemV1 { @Key() id = 0; @Column({ type: "text" }) text = ""; }
@Entity({ table: `${p}a_items` }) class ItemV2 { @Key() id = 0; @Column({ type: "text" }) text = ""; @Column({ type: "text" }) tag: string | null = null; }
@Entity({ table: `${p}a_v2_items` }) class OverlapItem { @Key() id = 0; }
@Entity({ table: `${p}b_items` }) class FreshItem { @Key() id = 0; }
@Entity({ table: `${p}c_items` }) class NextItem { @Key() id = 0; }
@Entity({ table: `${p}d_items` }) class ForgedScopeItem { @Key() id = 0; }
@Entity({ table: `${p}g_items` }) class FormatItem { @Key() id = 0; @Column({ type: "text" }) text = ""; }
@Entity({ table: `${p}e_items` }) class DroppedColumnItem { @Key() id = 0; @Column({ type: "text" }) text = ""; }
@Entity({ table: `${p}f_items` }) class AddedColumnItem { @Key() id = 0; @Column({ type: "text" }) text = ""; }
class StoreDb extends DbContext {}

const definition = (storeKey: string, prefix: string, extra: object = {}) => defineOrmOwnedStoreV1({ contract: "bazis.orm-owned-store/v1", storeKey: `${p}.${storeKey}`, formatVersion: 1, ownedScope: { schema: "public", tablePrefix: prefix }, ...extra });

async function start(entity: new () => object, store: ReturnType<typeof definition>): Promise<unknown> {
  const parsed = new URL(url!);
  const config = defineConfig(`osm${run}db`, { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Global() @Module({ providers: [singletonValue(Configuration, new Configuration(new Map()))], exports: [Configuration] }) class ConfigModule {}
  @Infra({ db: ormBazisConnect(config) }) class TestInfra {}
  @Module({ ormBazis: { context: StoreDb, entities: [entity], ownedStore: store, registerRepositories: false } }) class StoreModule {}
  @Module({ imports: [ConfigModule, TestInfra, StoreModule] }) class Root {}
  const coordinator = new LifecycleCoordinator(createContainer(Root));
  try { await coordinator.start(); return undefined; } catch (error) { return error; } finally { await coordinator.stopServices().catch(() => {}); }
}

afterAll(async () => {
  if (!url) return;
  const db = postgres({ url });
  try {
    for (const row of await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE $1", [`${p}%`])) await db.execute(`DROP TABLE IF EXISTS "${String(row.tablename)}" CASCADE`, []);
    await db.execute(`DELETE FROM "${registry}" WHERE store_key LIKE $1`, [`${p}.%`]).catch(() => undefined);
  } finally { await db.close(); }
});

describe("owned-store admission explains its failures against a disposable PostgreSQL database", () => {
  live("a changed model names the store and the way forward", async () => {
    expect(await start(ItemV1, definition("a", `${p}a_`))).toBeUndefined();
    const error = await start(ItemV2, definition("a", `${p}a_`)) as OrmOwnedStoreAdmissionError;
    expect(error).toBeInstanceOf(OrmOwnedStoreAdmissionError);
    expect(error.code).toBe("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    expect(error.message).toStartWith(`ORM_OWNED_STORE_IDENTITY_MISMATCH: Owned store "${p}.a" (schema "public", prefix "${p}a_"): its model changed since the store was created`);
    expect(Object.hasOwn(error, "cause")).toBe(false);
  }, 20_000);

  live("a prefix overlapping a registered store names that store", async () => {
    const error = await start(OverlapItem, definition("a2", `${p}a_v2_`)) as OrmOwnedStoreAdmissionError;
    expect(error.code).toBe("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
    expect(error.message).toContain(`overlaps the registered owned store "${p}.a" (schema "public", prefix "${p}a_")`);
  }, 20_000);

  live("unregistered tables in the scope are listed", async () => {
    const db = postgres({ url: url! });
    try { await db.execute(`CREATE TABLE "${p}b_legacy" (id int)`, []); } finally { await db.close(); }
    const error = await start(FreshItem, definition("b", `${p}b_`)) as OrmOwnedStoreAdmissionError;
    expect(error.code).toBe("ORM_OWNED_STORE_IDENTITY_MISSING");
    expect(error.message).toContain(`its scope already contains tables that no owned store registered: "${p}b_legacy". Remove them, or choose another tablePrefix.`);
  }, 20_000);

  live("an object with a forged name is not read and not echoed", async () => {
    const db = postgres({ url: url! });
    try { await db.execute(`CREATE TABLE "${p}d_x\n[INFO] ok" (id int)`, []); } finally { await db.close(); }
    const error = await start(ForgedScopeItem, definition("d", `${p}d_`)) as OrmOwnedStoreAdmissionError;
    expect(error.code).toBe("ORM_OWNED_STORE_DRIFT");
    expect(error.message).toContain("the store scope contains an object bazis does not expect there");
    expect(error.message).not.toContain("[INFO]");
    expect(error.message).not.toContain("\n");
  }, 20_000);

  // 0.116.0: a column added and dropped outside bazis leaves a dropped
  // attribute in pg_attribute. The table matches the model again, yet the
  // store reported drift forever and asked to restore something that cannot be.
  live("a column added and dropped outside bazis does not block the store", async () => {
    expect(await start(DroppedColumnItem, definition("e", `${p}e_`))).toBeUndefined();
    const db = postgres({ url: url! });
    try {
      await db.execute(`ALTER TABLE "${p}e_items" ADD COLUMN extra text`, []);
      await db.execute(`ALTER TABLE "${p}e_items" DROP COLUMN extra`, []);
    } finally { await db.close(); }
    const again = await start(DroppedColumnItem, definition("e", `${p}e_`));
    expect(again === undefined ? undefined : String((again as Error).message)).toBeUndefined();
  }, 20_000);

  live("a column added outside bazis is still drift", async () => {
    expect(await start(AddedColumnItem, definition("f", `${p}f_`))).toBeUndefined();
    const db = postgres({ url: url! });
    try { await db.execute(`ALTER TABLE "${p}f_items" ADD COLUMN extra text`, []); } finally { await db.close(); }
    const error = await start(AddedColumnItem, definition("f", `${p}f_`)) as OrmOwnedStoreAdmissionError;
    expect(error).toBeInstanceOf(OrmOwnedStoreAdmissionError);
    expect(error.code).toBe("ORM_OWNED_STORE_DRIFT");
  }, 20_000);

  // 0.118.0: a changed formatVersion said only "the registered identity does
  // not match the code"; it now names both versions.
  live("a changed formatVersion names the registered and the declared version", async () => {
    expect(await start(FormatItem, definition("g", `${p}g_`))).toBeUndefined();
    const error = await start(FormatItem, definition("g", `${p}g_`, { formatVersion: 2 })) as OrmOwnedStoreAdmissionError;
    expect(error).toBeInstanceOf(OrmOwnedStoreAdmissionError);
    expect(error.code).toBe("ORM_OWNED_STORE_IDENTITY_MISMATCH");
    expect(error.message).toContain(`Owned store "${p}.g" (schema "public", prefix "${p}g_") is registered with format version 1, the code declares 2.`);
  }, 20_000);

  live("leftovers of a rejected scope are listed", async () => {
    const error = await start(NextItem, definition("c", `${p}c_`, { rejectIfPresent: [{ schema: "public", tablePrefix: `${p}a_` }] })) as OrmOwnedStoreAdmissionError;
    expect(error.code).toBe("ORM_OWNED_STORE_OWNERSHIP_CONFLICT");
    expect(error.message).toContain(`does not start while tables of the rejected scope (schema "public", prefix "${p}a_") exist: "${p}a_items"`);
  }, 20_000);
});
