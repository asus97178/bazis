import { expect, test } from "bun:test";
import { createContainer, Global, Module, singletonValue } from "@/core/di";
import { Configuration, defineConfig, LifecycleCoordinator, secret } from "@/core/kernel";
import { Infra } from "@/core/infra";
import { Column, DbContext, Entity, ormBazisConnect } from "@/core/orm";
import { ForeignKey, postgres, UUID } from "@/library/orm";
import { defineOrmOwnedStoreV1 } from "../../../library/orm/Schema/OrmOwnedStore";

/**
 * Live check of UUID v7 keys in an owned store: admission creates native `uuid`
 * columns without defaults (including a foreign key), the ORM assigns v7 keys,
 * and a second start replays the exact catalog check.
 *
 * Runs only against a dedicated throwaway database: set `BAZIS_PG_URL` to a
 * database whose name starts with `bazis_v7_` and `BAZIS_OWNED_STORE_V7_LIVE=1`.
 * The test drops its tables and the owned-store registry at the end.
 */
const url = process.env.BAZIS_PG_URL;
const database = (() => { try { return new URL(url ?? "").pathname.slice(1); } catch { return ""; } })();
const enabled = process.env.BAZIS_OWNED_STORE_V7_LIVE === "1" && database.startsWith("bazis_v7_");
const PREFIX = "ov7_";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Entity({ table: `${PREFIX}parent` })
class Parent {
  @UUID({ version: "v7", name: `${PREFIX}parent_pkey` }) id = "";
  @Column({ type: "text" }) name = "";
}

@ForeignKey(() => Parent, { properties: ["parentId"], name: `${PREFIX}child_parent_fk` })
@Entity({ table: `${PREFIX}child` })
class Child {
  @UUID({ version: "v7", name: `${PREFIX}child_pkey` }) id = "";
  @Column({ type: "text" }) parentId = "";
}

class StoreContext extends DbContext {
  readonly parents = this.set(Parent);
  readonly children = this.set(Child);
}

const store = defineOrmOwnedStoreV1({ contract: "bazis.orm-owned-store/v1", storeKey: "bazis.test.uuid-v7", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: PREFIX } });

function root(dsn: string) {
  const parsed = new URL(dsn);
  const dbConfig = defineConfig("ov7db", { default: { host: parsed.hostname, port: Number(parsed.port || "5432"), database: parsed.pathname.slice(1), username: decodeURIComponent(parsed.username), password: secret(decodeURIComponent(parsed.password)) } });
  @Global() @Module({ providers: [singletonValue(Configuration, new Configuration(new Map()))], exports: [Configuration] }) class ConfigModule {}
  @Infra({ db: ormBazisConnect(dbConfig) }) class TestInfra {}
  @Module({ ormBazis: { context: StoreContext, entities: [Parent, Child], ownedStore: store, registerRepositories: false } }) class StoreModule {}
  @Module({ imports: [ConfigModule, TestInfra, StoreModule] }) class Root {}
  return Root;
}

test.skipIf(!enabled)("owned store admits UUID v7 keys and a uuid foreign key (live)", async () => {
  const Root = root(url!);
  const observer = postgres({ url });
  try {
    expect(await observer.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'", [])).toEqual([]);

    const first = createContainer(Root), firstLifecycle = new LifecycleCoordinator(first);
    await firstLifecycle.start(undefined, 10_000);
    let parentId = "";
    const scope = first.createScope();
    try {
      const db = scope.resolve(StoreContext);
      const parent = Object.assign(new Parent(), { name: "parent" });
      db.parents.add(parent);
      await db.saveChanges();
      parentId = parent.id;
      db.children.add(Object.assign(new Child(), { parentId }));
      await db.saveChanges();
    } finally { await scope.dispose(); }
    expect(parentId).toMatch(UUID_V7);
    await firstLifecycle.stopServices();
    await first.dispose();

    const columns = await observer.query(
      `SELECT c.relname AS table_name, a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'ov7\\_%' AND a.attnum > 0 AND NOT a.attisdropped AND pg_catalog.format_type(a.atttypid, a.atttypmod) = 'uuid' ORDER BY 1, 2`, []);
    expect(columns).toEqual([
      { table_name: "ov7_child", column_name: "id", type: "uuid", default_expr: null },
      { table_name: "ov7_child", column_name: "parentId", type: "uuid", default_expr: null },
      { table_name: "ov7_parent", column_name: "id", type: "uuid", default_expr: null },
    ]);

    // Replay: the second start verifies the existing catalog and reads the rows.
    const second = createContainer(Root), secondLifecycle = new LifecycleCoordinator(second);
    await secondLifecycle.start(undefined, 10_000);
    const readScope = second.createScope();
    try {
      const db = readScope.resolve(StoreContext);
      expect((await db.parents.find(parentId))?.name).toBe("parent");
      const children = await db.children.toList();
      expect(children).toHaveLength(1);
      expect(children[0]!.id).toMatch(UUID_V7);
      expect(children[0]!.parentId).toBe(parentId);
    } finally { await readScope.dispose(); }
    await secondLifecycle.stopServices();
    await second.dispose();
  } finally {
    await observer.execute(`DROP TABLE IF EXISTS "public"."${PREFIX}child", "public"."${PREFIX}parent", "public"."__bazis_orm_owned_stores_v1"`, []);
    await observer.close();
  }
});
