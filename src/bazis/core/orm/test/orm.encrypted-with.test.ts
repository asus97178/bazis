import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "@/core/di";
import { registerGeneratedClassDeps } from "@/core/di/module/autoDeps";
import { defineConfig, KernelBuilder, memorySource, secret, secretFilesSource } from "@/core/kernel";
import { Column, DbContext, DbContextOptions, encryptedWith, Entity, HasConversion, Key, ormModule, type DatabaseProvider } from "@/core/orm";
import { PostgresDialect } from "@/library/orm/Providers/PostgresDialect";

const provider = { name: "postgres", dialect: new PostgresDialect(), limits: { maxParametersPerCommand: 32767 }, query: async () => [], execute: async () => ({ changes: 1, lastInsertId: 0 }), transaction: async <T>(work: (p: DatabaseProvider) => Promise<T>) => work(provider), isTransactionActive: () => false, ping: async () => true, close: async () => undefined, introspect: async () => ({ tables: new Map() }) } as unknown as DatabaseProvider;

const cryptoConfig = defineConfig("crypto", { default: { phoneKey: secret() } });
const phone = encryptedWith(cryptoConfig, "phoneKey");

@Entity()
class Customer {
  @Key({ generated: false }) id = 0;
  @HasConversion(phone) @Column({ type: "text" }) phone = "";
}
class CustomersDb extends DbContext {}
registerGeneratedClassDeps(CustomersDb, [DbContextOptions]);

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

test("encryptedWith takes the key from a secret file when the application starts", async () => {
  expect(() => phone.toProvider("+7 900")).toThrow("encryptedWith(crypto.phoneKey): the key is not bound yet; the column is used outside a started application.");
  const dir = await mkdtemp(join(tmpdir(), "bazis-secrets-"));
  dirs.push(dir);
  await writeFile(join(dir, "BAZIS_CRYPTO__PHONEKEY"), "file-key-0123456789abcdef0123456789\n");
  @Module({ imports: [ormModule({ provider, healthCheck: false })], config: [cryptoConfig], ormBazis: { context: CustomersDb, entities: [Customer] }, exports: [] })
  class App {}
  const kernel = await new KernelBuilder(App).useEnvironment("production").useStartupReport(false).addConfigSource(secretFilesSource(dir)).build();
  await kernel.start();
  try {
    const stored = phone.toProvider("+7 900");
    expect(stored).not.toContain("+7 900");
    expect(phone.fromProvider(stored)).toBe("+7 900");

    // The same column in a second application with another key is refused.
    @Module({ imports: [ormModule({ provider, healthCheck: false })], config: [cryptoConfig], ormBazis: { context: CustomersDb, entities: [Customer] }, exports: [] })
    class Other {}
    const other = await new KernelBuilder(Other).useStartupReport(false).addConfigSource(memorySource({ crypto: { phoneKey: "another-key-0123456789abcdef012345" } })).build();
    await expect(other.start()).rejects.toThrow("Customer.phone: encryptedWith(crypto.phoneKey): the column is already bound to another key in this process.");
  } finally {
    await kernel.stop();
  }
});

test("encryptedWith names the config that is not declared in the application", async () => {
  @Entity()
  class Lead {
    @Key({ generated: false }) id = 0;
    @HasConversion(encryptedWith(cryptoConfig, "phoneKey")) @Column({ type: "text" }) phone = "";
  }
  class LeadsDb extends DbContext {}
  registerGeneratedClassDeps(LeadsDb, [DbContextOptions]);
  @Module({ imports: [ormModule({ provider, healthCheck: false })], ormBazis: { context: LeadsDb, entities: [Lead] }, exports: [] })
  class App {}
  const kernel = await new KernelBuilder(App).useStartupReport(false).addConfigSource(memorySource({})).build();
  await expect(kernel.start()).rejects.toThrow('Lead.phone: encryptedWith(crypto.phoneKey): the config "crypto" is not declared in the application; add it to `config` of the module that owns Lead or to runApp({ config }).');
});
