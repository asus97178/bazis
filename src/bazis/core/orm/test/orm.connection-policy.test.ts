import { expect, test } from "bun:test";
import { ConfigRegistry, Configuration, configEnum, defineConfig, secret } from "../../kernel";
import { InfraError } from "../../infra";
import { ormBazisConnect } from "../databaseConnector";
import { DbContext, DbContextOptions, PostgresProvider } from "../../../library/orm";

const defaults = { host: "localhost", port: 5432, database: "test", username: "test", password: secret("synthetic-test-password") };
class Context extends DbContext {}

for (const [field, value] of [["max", 0], ["connectionTimeout", -1], ["maxLifetime", -1], ["idleTimeout", -1], ["operationTimeoutMs", 0], ["cancellationTimeoutMs", 1.2], ["maxPendingOperations", -2], ["statementTimeoutMs", 0], ["cancellationMode", "invalid"], ["tls", "invalid"], ["tlsCa", " "]] as const) {
  test(`ORM connector rejects invalid ${field} before connection`, () => {
    const config = defineConfig("db", { default: { ...defaults, [field]: value } });
    expect(() => ormBazisConnect(config).create()).toThrow(InfraError);
  });
}

const sslMode = (mode: "require" | "verify-full") => configEnum(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"], mode);
test("ORM connector treats an empty tlsCa as no additional CA and requires verify-full for a PEM", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----";
  const plain = ormBazisConnect(defineConfig("db", { default: { ...defaults, tls: sslMode("require"), tlsCa: "" } })).create() as PostgresProvider;
  const pinned = ormBazisConnect(defineConfig("db", { default: { ...defaults, tls: sslMode("verify-full"), tlsCa: pem } })).create() as PostgresProvider;
  try {
    // The control pool reuses the working pool's TLS options.
    expect((plain as unknown as { controlConfig: { tls: unknown } }).controlConfig.tls).toBe("require");
    expect((pinned as unknown as { controlConfig: { tls: unknown } }).controlConfig.tls).toEqual({ ca: pem, serverName: "localhost", rejectUnauthorized: true });
  } finally { void plain.close(); void pinned.close(); }
  expect(() => ormBazisConnect(defineConfig("db", { default: { ...defaults, tls: sslMode("require"), tlsCa: pem } })).create()).toThrow(InfraError);
});

test("ORM connector forwards operation deadline and health cancellation", async () => {
  const config = defineConfig("db", { default: { ...defaults, operationTimeoutMs: 30, cancellationTimeoutMs: 20, max: 1, connectionTimeout: 2, idleTimeout: 0, maxLifetime: 0 } });
  const connector = ormBazisConnect(config); const provider = connector.create() as PostgresProvider;
  let calls = 0;
  Object.defineProperty(provider, "sql", { value: { reserve: () => { calls++; return new Promise(() => {}); }, close: async () => {} } });
  const db = new Context(new DbContextOptions({ provider, entities: [] }));
  const start = performance.now();
  await expect(db.transactionScope(async () => {})).rejects.toThrow();
  expect(performance.now() - start).toBeLessThan(500);
  expect(await connector.healthCheck!(provider, AbortSignal.abort())).toBe(false);
  expect(calls).toBe(1);
  await connector.dispose(provider);
});

test("cancellation modes stay isolated between kernel configuration views and provider lifetimes", async () => {
  const config = defineConfig("db", { default: { ...defaults, cancellationMode: configEnum(["server", "close"], "server") } });
  const serverView = new ConfigRegistry([config], "test", Configuration.empty());
  const closeView = new ConfigRegistry([config], "test", new Configuration(new Map([["db.cancellationMode", "close"]])));
  const connector = ormBazisConnect(config), first = connector.create(serverView) as PostgresProvider, second = connector.create(closeView) as PostgresProvider;
  try {
    expect((first as unknown as { cancellationMode: string }).cancellationMode).toBe("server");
    expect((second as unknown as { cancellationMode: string }).cancellationMode).toBe("close");
    expect((first as unknown as { controlSql?: unknown }).controlSql).toBeUndefined();
    expect(() => connector.create(new ConfigRegistry([config], "test", new Configuration(new Map([["db.cancellationMode", "invalid"]]))))).toThrow();
    await connector.dispose(second);
    expect(first.statistics().closed).toBe(false);
    expect(serverView.get(config).get("cancellationMode")).toBe("server");
    expect(config.resolve("test", Configuration.empty()).get("cancellationMode")).toBe("server");
  } finally { await connector.dispose(first); await connector.dispose(second); }
});
