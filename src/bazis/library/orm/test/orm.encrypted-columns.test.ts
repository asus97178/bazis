import { expect, test } from "bun:test";
import { Column, DbContext, DbContextOptions, DecryptionError, Entity, HasConversion, Index, Key, ModelBuilder, ModelBuildError, OrmError, ValueConverters, type DatabaseProvider, type Row, type SqlParam } from "../index";
import { PostgresDialect } from "../Providers/PostgresDialect";

class Context extends DbContext {}
function recording(read: (sql: string, params: readonly SqlParam[]) => Row[] = () => []) {
  const statements: { sql: string; params: readonly SqlParam[] }[] = [];
  const provider: DatabaseProvider = {
    name: "postgres", dialect: new PostgresDialect(), limits: { maxParametersPerCommand: 32767 },
    async query(sql, params) { statements.push({ sql, params }); return read(sql, params); },
    async execute(sql, params) { statements.push({ sql, params }); return { changes: 1, lastInsertId: 0 }; },
    async transaction(work) { return await work(provider); },
    isTransactionActive: () => false,
    async ping() { return true; }, async introspect() { return { tables: new Map() }; }, async close() {},
  };
  return { provider, statements };
}

const phone = ValueConverters.encrypted("test-key-0123456789abcdef0123456789");

@Entity()
class Customer {
  @Key({ generated: false }) id = 0;
  @HasConversion(phone) @Column({ type: "text" }) phone = "";
}

test("a condition or an ordering on an encrypted column fails instead of matching nothing", async () => {
  const { provider, statements } = recording();
  const context = new Context(new DbContextOptions({ provider, entities: [Customer], validateOnSave: false }));
  const hint = "Customer.phone is encrypted with a random nonce: it cannot be compared or sorted in SQL. To find rows by it, store a separate column with a keyed hash of the value (HMAC) and compare that.";
  await expect(context.setOf(Customer).where((x) => x.phone.eq("+7 900")).toList()).rejects.toThrow(hint);
  await expect(context.setOf(Customer).where((x) => x.phone.in(["+7 900"])).toList()).rejects.toThrow(hint);
  await expect(context.setOf(Customer).orderBy((x) => x.phone).toList()).rejects.toThrow(hint);
  expect(statements).toHaveLength(0);
  await context.setOf(Customer).where((x) => x.phone.isNull()).toList();
  expect(statements).toHaveLength(1);
});

test("an encrypted column that cannot be decrypted names the entity and the property", async () => {
  const other = ValueConverters.encrypted("another-key-0123456789abcdef012345");
  const stored = other.toProvider("+7 900");
  const { provider } = recording(() => [{ id: 1, phone: stored }]);
  const context = new Context(new DbContextOptions({ provider, entities: [Customer], validateOnSave: false }));
  const read = context.setOf(Customer).toList();
  await expect(read).rejects.toBeInstanceOf(OrmError);
  await expect(read).rejects.toThrow("Cannot read Customer.phone: cannot decrypt the value: it was encrypted with another key, or the stored value was changed");
  expect(() => phone.fromProvider("short")).toThrow(DecryptionError);
});

test("an empty string is encrypted; an empty stored value still reads as empty", () => {
  const stored = phone.toProvider("");
  expect(stored).not.toBe("");
  expect(phone.fromProvider(stored)).toBe("");
  expect(phone.fromProvider("")).toBe("");
  expect(phone.toProvider("a")).not.toBe(phone.toProvider("a"));
  expect(phone.comparable).toBe(false);
});

test("an encrypted key or unique index is refused when the model is built", () => {
  @Entity()
  class EncryptedKey { @Key({ generated: false }) @HasConversion(phone) @Column({ type: "text" }) id = ""; }
  @Entity()
  class UniquePhone { @Key({ generated: false }) id = 0; @HasConversion(phone) @Index({ unique: true }) @Column({ type: "text" }) phone = ""; }
  expect(() => ModelBuilder.build(EncryptedKey)).toThrow(ModelBuildError);
  expect(() => ModelBuilder.build(EncryptedKey)).toThrow('Entity "EncryptedKey": key "id" cannot be encrypted: equal values are stored differently.');
  expect(() => ModelBuilder.build(UniquePhone)).toThrow('Entity "UniquePhone": a unique index on encrypted "phone" cannot work: equal values are stored differently. Put it on a keyed hash (HMAC) column.');
});
