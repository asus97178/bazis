import { expect, spyOn, test } from "bun:test";
import { Module } from "@/core/di";
import { Bazis, defineConfig, secret } from "@/core/kernel";
import { Infra } from "@/core/infra";
import { Column, DbContext, Entity, Key, ormBazisConnect } from "@/core/orm";
import { postgres, type PostgresProvider } from "@/library/orm";

const url = process.env.BAZIS_PG_URL?.trim();
const table = `ocrep_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}_items`;

@Entity({ table })
class ReportItem {
  @Key()
  id = 0;

  @Column({ type: "text" })
  name = "";
}

class ReportContext extends DbContext {
  readonly items = this.set(ReportItem);
}

if (url === undefined || url.length === 0) {
  test.skip("SKIP — startup report on PostgreSQL requires BAZIS_PG_URL", () => {});
} else {
  test("the startup screen gets the connection with its server version and the schema changes instead of log lines", async () => {
    const parsed = new URL(url);
    const config = defineConfig("reportLive", {
      default: {
        host: parsed.hostname,
        port: Number(parsed.port || "5432"),
        database: parsed.pathname.replace(/^\//, ""),
        username: decodeURIComponent(parsed.username),
        password: secret(decodeURIComponent(parsed.password)),
      },
    });
    @Infra({ db: ormBazisConnect(config) })
    class TestInfra {}
    @Module({ ormBazis: { context: ReportContext, entities: [ReportItem], ensureCreated: true } })
    class ItemsModule {}
    @Module({ imports: [TestInfra, ItemsModule] })
    class App {}

    const info = spyOn(console, "info").mockImplementation(() => undefined);
    const observer = postgres({ url }) as PostgresProvider;
    try {
      const kernel = await Bazis.createBuilder(App).useEnvironment("test").useStartupScreen(() => undefined).build();
      await kernel.start();
      await kernel.stop();
      const [db] = kernel.report.connections;
      expect(db?.status).toBe("up");
      expect(db?.kind).toMatch(/^PostgreSQL \d+/);
      expect(db?.address).toBe(`${decodeURIComponent(parsed.username)}@${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`);
      const [schema] = kernel.report.schemas;
      expect(schema?.context).toBe("ReportContext");
      expect(schema?.applied.some((operation) => operation.includes(table))).toBe(true);
      // The screen lists the changes; the log lines are for runs without it.
      expect(info.mock.calls.some((call) => String(call[0]).startsWith("[orm:schema]"))).toBe(false);
    } finally {
      info.mockRestore();
      await observer.execute(`DROP TABLE IF EXISTS "${table}" CASCADE`, []);
      await observer.close();
    }
  });
}
