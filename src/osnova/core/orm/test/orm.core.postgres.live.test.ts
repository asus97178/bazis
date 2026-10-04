import { describe, expect, test } from "bun:test";
import { Global, HOSTED_SERVICE, Module, createContainer, singletonValue } from "@/core/di";
import { Configuration, defineConfig, secret } from "@/core/kernel";
import { Infra } from "@/core/infra";
import { Column, DbContext, Entity, Key, DATABASE_PROVIDER, ormOsnovaConnect, paginate } from "@/core/orm";
import { postgres, type PostgresProvider } from "@/library/orm";
import { parseListQuery, type ListQueryOptions } from "@/library/jsonapi";
import { Validator } from "@/library/validation";

const url = process.env.OSNOVA_PG_URL?.trim();
const prefix = `ocorm_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}_`;
const notesTable = `${prefix}notes`;
const validTable = /^ocorm_[a-f0-9]{16}_[a-z0-9_]+$/;
const listOptions: ListQueryOptions = {
  sort: ["text", "rank"],
  filter: { text: ["eq", "contains", "in"], rank: ["gte", "lte", "eq"] },
  page: { defaultSize: 20, maxSize: 100 },
};

@Entity({ table: notesTable })
class LiveNote {
  @Key()
  id = 0;

  @Column({ type: "text" })
  @Validator({ required: true, minLength: 2 })
  text = "";

  @Column({ type: "integer" })
  rank = 0;
}

class LiveNotesContext extends DbContext {
  readonly notes = this.set(LiveNote);
}

if (url === undefined || url.length === 0) {
  test.skip("SKIP — core ORM PostgreSQL qualification requires OSNOVA_PG_URL", () => {});
} else {
  describe("core ORM PostgreSQL qualification", () => {
    test("uses @Infra shared provider, ensureCreated, scoped context and repository CRUD", async () => {
      const fixture = await createFixture(url);
      try {
        const hosted = [...fixture.container.resolveAll(HOSTED_SERVICE)]
          .sort((left, right) => (left.phase ?? 0) - (right.phase ?? 0));
        for (const service of hosted) await service.start();
        const provider = fixture.container.resolve(DATABASE_PROVIDER);
        expect(provider.name).toBe("postgres");
        expect(await provider.ping()).toBe(true);

        const scope = fixture.container.createScope();
        try {
          const context = scope.resolve(LiveNotesContext);
          const note = context.notes.add(Object.assign(new LiveNote(), { text: "first", rank: 2 }));
          expect(await context.saveChanges()).toBe(1);
          expect(note.id).toBeGreaterThan(0);
          note.text = "updated";
          expect(await context.saveChanges()).toBe(1);
          expect(await context.notes.where((value) => value.rank.gte(1)).orderBy((value) => value.text).count()).toBe(1);
          expect((await context.notes.find(note.id))?.text).toBe("updated");
        } finally {
          await scope.dispose();
        }
      } finally {
        await fixture.close();
      }
    });

    test("uses PostgreSQL ordering and paged query semantics through the feature context", async () => {
      const fixture = await createFixture(url);
      try {
        const hosted = [...fixture.container.resolveAll(HOSTED_SERVICE)]
          .sort((left, right) => (left.phase ?? 0) - (right.phase ?? 0));
        for (const service of hosted) await service.start();
        const scope = fixture.container.createScope();
        try {
          const context = scope.resolve(LiveNotesContext);
          context.notes.addRange([
            Object.assign(new LiveNote(), { text: "beta", rank: 2 }),
            Object.assign(new LiveNote(), { text: "alpha", rank: 1 }),
            Object.assign(new LiveNote(), { text: "gamma", rank: 3 }),
          ]);
          await context.saveChanges();
          const page = await context.notes.orderBy((value) => value.text).skip(1).take(1).toList();
          expect(page.map((value) => value.text)).toEqual(["beta"]);
          const remaining = await context.notes.orderBy((value) => value.text).skip(1).toList();
          expect(remaining.map((value) => value.text)).toEqual(["beta", "gamma"]);
          expect(await context.notes.count((value) => value.rank.gte(2))).toBe(2);
        } finally {
          await scope.dispose();
        }
      } finally {
        await fixture.close();
      }
    });

    test("replays ensureCreated and preserves tracked update, raw SQL and delete semantics", async () => {
      const fixture = await createFixture(url);
      try {
        const hosted = await startHosted(fixture.container);
        const scope = fixture.container.createScope();
        try {
          const context = scope.resolve(LiveNotesContext);
          await context.database.ensureCreated();
          await context.database.ensureCreated();
          const note = context.notes.add(Object.assign(new LiveNote(), { text: "tracked", rank: 1 }));
          await context.saveChanges();
          note.rank = 9;
          expect(await context.saveChanges()).toBe(1);
          expect((await context.notes.asNoTracking().firstOrDefault((value) =>
            value.id.eq(note.id)))?.rank).toBe(9);
          expect((await context.database.executeSqlRaw(`UPDATE "${notesTable}" SET "rank" = {0} WHERE "id" = {1}`, 11, note.id)).changes).toBe(1);
          expect(Number((await context.database.querySqlRaw(`SELECT "rank" FROM "${notesTable}" WHERE "id" = {0}`, note.id))[0]?.rank)).toBe(11);
          context.notes.remove(note);
          await context.saveChanges();
          expect(await context.notes.count()).toBe(0);
        } finally { await scope.dispose(); }
        await stopHosted(hosted);
      } finally { await fixture.close(); }
    });

    test("applies ListQuery filters, deterministic order and pagination against PostgreSQL", async () => {
      const fixture = await createFixture(url);
      try {
        await startHosted(fixture.container);
        const scope = fixture.container.createScope();
        try {
          const context = scope.resolve(LiveNotesContext);
          context.notes.addRange([
            Object.assign(new LiveNote(), { text: "Ann", rank: 30 }),
            Object.assign(new LiveNote(), { text: "Bob", rank: 17 }),
            Object.assign(new LiveNote(), { text: "Cara", rank: 41 }),
            Object.assign(new LiveNote(), { text: "Alex", rank: 25 }),
          ]);
          await context.saveChanges();
          const page = await paginate(context.notes, parseListQuery(
            new URLSearchParams("filter[rank][gte]=18&sort=text&page[number]=1&page[size]=2"),
            listOptions,
          ));
          expect(page.items.map((value) => value.text)).toEqual(["Alex", "Ann"]);
          expect(page.total).toBe(3);
          const filtered = await paginate(context.notes, parseListQuery(
            new URLSearchParams("filter[text][contains]=a&sort=-rank"), listOptions,
          ));
          expect(filtered.items.map((value) => value.text)).toEqual(["Cara"]);
        } finally { await scope.dispose(); }
      } finally { await fixture.close(); }
    });

    test("rejects invalid entities before PostgreSQL mutation", async () => {
      const fixture = await createFixture(url);
      try {
        await startHosted(fixture.container);
        const scope = fixture.container.createScope();
        try {
          const context = scope.resolve(LiveNotesContext);
          context.notes.add(Object.assign(new LiveNote(), { text: "x", rank: 1 }));
          await expect(context.saveChanges()).rejects.toThrow();
          expect(await context.notes.count()).toBe(0);
        } finally { await scope.dispose(); }
      } finally { await fixture.close(); }
    });
  });
}

async function startHosted(container: ReturnType<typeof createContainer>) {
  const hosted = [...container.resolveAll(HOSTED_SERVICE)]
    .sort((left, right) => (left.phase ?? 0) - (right.phase ?? 0));
  for (const service of hosted) await service.start();
  return hosted;
}

async function stopHosted(hosted: readonly { readonly stop: () => Promise<void> | void }[]) {
  for (const service of [...hosted].reverse()) await service.stop();
}

async function createFixture(baseUrl: string) {
  const parsed = new URL(baseUrl);
  const config = defineConfig("coreOrmLive", {
    default: {
      host: parsed.hostname,
      port: Number(parsed.port || "5432"),
      database: parsed.pathname.replace(/^\//, ""),
      username: decodeURIComponent(parsed.username),
      password: secret(decodeURIComponent(parsed.password)),
    },
  });
  @Global()
  @Module({ providers: [singletonValue(Configuration, new Configuration(new Map()))], exports: [Configuration] })
  class ConfigModule {}
  @Infra({ db: ormOsnovaConnect(config) })
  class TestInfra {}
  @Module({ ormOsnova: { context: LiveNotesContext, entities: [LiveNote], ensureCreated: true } })
  class NotesModule {}
  @Module({ imports: [ConfigModule, TestInfra, NotesModule] })
  class App {}
  const container = createContainer(App);
  const observer = postgres({ url: baseUrl }) as PostgresProvider;
  return Object.freeze({
    container,
    async close() {
      try {
        const hosted = [...container.resolveAll(HOSTED_SERVICE)]
          .sort((left, right) => (right.phase ?? 0) - (left.phase ?? 0));
        for (const service of hosted) {
          try { await service.stop(); } catch { /* best-effort fixture teardown */ }
        }
        await container.dispose();
      } finally {
        try { await dropOwnedTables(observer, [notesTable]); }
        finally { await observer.close(); }
      }
    },
  });
}

async function dropOwnedTables(observer: PostgresProvider, names: readonly string[]): Promise<void> {
  for (const name of [...names].reverse()) {
    if (!validTable.test(name)) throw new Error("Unsafe core ORM live table name.");
    await observer.execute(`DROP TABLE IF EXISTS "${name}" CASCADE`, []);
  }
}
