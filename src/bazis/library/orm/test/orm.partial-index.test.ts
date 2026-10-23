import { expect, test } from "bun:test";
import { Column, Entity, Index, Key, OrmModel, Required, SoftDelete } from "../index";
import { PostgresDialect } from "../Providers/PostgresDialect";
import { collectPostgresIndexes } from "../Providers/PostgresSchema.decoder";
import { ExactSchemaVerifier } from "../Schema/ExactSchemaVerifier";
import { compileExpectedSchema } from "../Schema/ExpectedSchema";
import { renderSafeAdditivePostgres } from "../Schema/SafeAdditiveSchema";
import type { IntrospectedIndex, IntrospectedSchema } from "../Schema/introspection";

// 0.115.0: a unique index next to @SoftDelete made a soft-deleted row block
// its value forever. `where` makes the index partial: only rows that match
// it take part, so a deleted user's email can be used again.
@Entity({ table: "members" })
@Index<Member>(["email"], { unique: true, where: (m) => m.deletedAt.isNull() })
class Member {
  @Key() id = 0;
  @Required() @Column({ type: "text" }) email = "";
  @Index<Member>({ where: (m) => m.active.eq(true) }) @Column({ type: "text" }) nick = "";
  @Column({ type: "boolean" }) active = true;
  @SoftDelete() deletedAt: Date | null = null;
}

const model = new OrmModel([Member]);
const entity = model.entities[0]!;

test("the index keeps its condition and renders it as WHERE", () => {
  expect(entity.indexes.map((index) => [index.name, index.unique, index.where])).toEqual([
    ["ix_members_nick", false, { kind: "compare", op: "=", left: "active", right: true }],
    ["ix_members_email", true, { kind: "null", left: "deletedAt", not: false }],
  ]);
  const dialect = new PostgresDialect();
  expect(dialect.createIndexSql(entity)).toEqual([
    'CREATE INDEX IF NOT EXISTS "ix_members_nick" ON "members" ("nick") WHERE "active" = TRUE',
    'CREATE UNIQUE INDEX IF NOT EXISTS "ix_members_email" ON "members" ("email") WHERE "deletedAt" IS NULL',
  ]);
  const table = compileExpectedSchema(model).tables[0]!;
  const email = table.indexes.find((index) => index.name === "ix_members_email")!;
  expect(renderSafeAdditivePostgres({ kind: "createIndex", table, index: email })).toBe('CREATE UNIQUE INDEX "ix_members_email" ON "public"."members" ("email") WHERE "deletedAt" IS NULL');
});

test("the catalog predicate is read back and compared with the declared one", () => {
  const rows = (predicate: string) => [{ index_name: "ix_members_email", is_unique: true, method: "btree", has_predicate: true, predicate, is_valid: true, is_ready: true, column_name: "email", is_expression: false, is_include: false, backing_constraint: false }];
  const [read] = collectPostgresIndexes(rows('("deletedAt" IS NULL)'));
  expect(read!.predicate).toEqual({ kind: "null", left: "deletedAt", not: false });
  expect(read!.unsupported).toBe(false);
  const [unknown] = collectPostgresIndexes(rows("lower(email) = 'x'::text"));
  expect(unknown!.unsupported).toBe(true);

  const expected = compileExpectedSchema(new OrmModel([Member]));
  const actual = (email: IntrospectedIndex): IntrospectedSchema => {
    const table = expected.tables[0]!;
    const nick: IntrospectedIndex = { name: "ix_members_nick", columns: ["nick"], unique: false, method: "btree", predicate: { kind: "compare", op: "=", left: "active", right: true } };
    const columns = new Map(table.columns.map((column) => [column.column, { name: column.column, notNull: !column.nullable, isPrimaryKey: column.column === "id", physicalType: column.physicalType, default: column.default, generation: column.generation } as never]));
    return { tables: new Map([["public.members", { name: "members", columns, indexes: [nick, email], primaryKey: { name: "pk_members", columns: ["id"] }, foreignKeys: [], checks: [], databaseDefault: { kind: "none" } } as never]]) };
  };
  const codes = (email: IntrospectedIndex) => new ExactSchemaVerifier().verify(expected, actual(email)).differences.map((difference) => difference.code);
  expect(codes({ name: "ix_members_email", columns: ["email"], unique: true, method: "btree", predicate: { kind: "null", left: "deletedAt", not: false } })).toEqual([]);
  expect(codes({ name: "ix_members_email", columns: ["email"], unique: true, method: "btree" })).toEqual(["index.predicate"]);
  expect(codes({ name: "ix_members_email", columns: ["email"], unique: true, method: "btree", predicate: { kind: "null", left: "deletedAt", not: true } })).toEqual(["index.predicate"]);
});

test("a condition on an unknown property fails when the model is built", () => {
  @Entity({ table: "broken_members" })
  @Index<{ id: number; missing: string }>(["id"], { where: (m) => m.missing.isNull() })
  class Broken { @Key() id = 0; }
  expect(() => new OrmModel([Broken])).toThrow('Entity "Broken": index "ix_broken_members_id" condition references unknown property "missing".');
});
