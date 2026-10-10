import { describe, expect, test } from "bun:test";
import { Column, DbContextOptions, Entity, Index, Key, ManyToOne, OrmError, SchemaAdmissionError, type DatabaseProvider, type DbExecutor, type Row } from "../index";
import { compileExpectedSchema } from "../Schema/ExpectedSchema";
import { physicalColumnTypes } from "../Schema/physicalColumnTypes";
import { SchemaDiffer } from "../Schema/SchemaDiffer";
import { MigrationRunner } from "../Schema/MigrationRunner";
import type { IntrospectedColumn, IntrospectedSchema } from "../Schema/introspection";

@Entity({ table: "app_users" })
class User { @Key() id = 0; @Index({ unique: true }) @Column({ type: "text" }) email = ""; }
@Entity({ table: "dx_products" })
class Product { @Key() id = 0; @Column({ type: "real" }) price = 0; @Column({ type: "text", nullable: false }) sku = ""; @Column({ type: "text" }) note: string | null = null; @Index({ unique: true }) @Column({ type: "text" }) code = ""; }
@Entity({ table: "dx_orders" })
class Order { @Key() id = 0; @Column({ type: "integer" }) productId = 0; @ManyToOne(() => Product, { foreignKey: "productId" }) product?: Product; }
@Entity({ table: "dx_products" })
class ProductCopy { @Key() id = 0; }

const provider = { name: "test", dialect: { name: "test" } } as unknown as DatabaseProvider;
const modelOf = (...entities: (new () => object)[]) => new DbContextOptions({ provider, entities }).model;

describe("schema names and messages", () => {
  test("a property-level index is named after the table, like a class-level one", () => {
    expect(modelOf(User).entities[0]!.indexes.map((index) => index.name)).toEqual(["ix_app_users_email"]);
  });

  test("a foreign key to an entity of another context explains the way out", () => {
    const message = 'Entity "Order" has a foreign key (productId) to "Product", which is not an entity of the same DbContext. A database foreign key can only point to an entity of the same context: keep productId as a plain column without @ManyToOne, or map both entities in one context.';
    expect(() => compileExpectedSchema(modelOf(Order))).toThrow(message);
    expect(() => physicalColumnTypes(modelOf(Order).entities)).toThrow(message);
    let error: unknown;
    try { compileExpectedSchema(modelOf(Order)); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SchemaAdmissionError);
    expect((error as SchemaAdmissionError).code).toBe("ORM_SCHEMA_CROSS_UNIT_FOREIGN_KEY");
  });

  test("two entities of one context mapping one table are named", () => {
    expect(() => compileExpectedSchema(modelOf(Product, ProductCopy))).toThrow('Entities "Product" and "ProductCopy" both map table "public"."dx_products"; one table belongs to one entity.');
  });
});

describe("migrateOnStart reports what it leaves untouched", () => {
  const column = (name: string, physicalType: string, notNull: boolean): [string, IntrospectedColumn] => [name, { name, notNull, isPrimaryKey: name === "id", physicalType }];
  const existing: IntrospectedSchema = { tables: new Map([["dx_products", {
    name: "dx_products",
    columns: new Map([column("id", "integer", true), column("price", "integer", false), column("sku", "text", false), column("note", "text", true), column("code", "text", false)]),
    indexes: [{ name: "ix_productlegacy_code", columns: ["code"], unique: true, method: "btree" }],
  }]]) };

  test("type, NULL-ability and a renamed index become warnings, not operations", () => {
    const entities = modelOf(Product).entities;
    const { operations, warnings } = new SchemaDiffer(physicalColumnTypes(entities)).diff(entities, existing);
    expect(operations).toEqual([]);
    expect(warnings).toEqual([
      'table "dx_products": column "price" is integer in the database but real in the model (left untouched; change it with an explicit migration).',
      'table "dx_products": column "sku" allows NULL in the database but is required in the model (left untouched; fill the NULL values and set NOT NULL with an explicit migration).',
      'table "dx_products": column "note" is NOT NULL in the database but nullable in the model (left untouched; drop NOT NULL with an explicit migration).',
      'table "dx_products": index "ix_productlegacy_code" matches "ix_dx_products_code" from the model except for its name (left untouched; to align it run: ALTER INDEX "ix_productlegacy_code" RENAME TO "ix_dx_products_code";).',
    ]);
  });
});

describe("versioned migrations name the failed step", () => {
  const fake = (failOn: string) => {
    const executor: DbExecutor = {
      query: async (): Promise<Row[]> => [],
      execute: async (sql) => { if (sql.includes(failOn)) throw Object.assign(new Error(`relation "${failOn}" does not exist`), { name: "PostgresError" }); return { changes: 0, lastInsertId: 0 }; },
    };
    return { name: "test", dialect: { name: "test", quoteId: (name: string) => `"${name}"`, parameter: (index: number) => `$${index + 1}` }, query: executor.query, execute: executor.execute, transaction: async <T>(work: (tx: DbExecutor) => Promise<T>) => work(executor) } as unknown as DatabaseProvider;
  };

  test("a failing up() reports its id and keeps the original error as the cause", async () => {
    const error = await new MigrationRunner(fake("nope"), [{ id: "20261010_03_bad", up: async (db) => { await db.execute("ALTER TABLE nope ADD COLUMN x int"); } }]).migrate().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrmError);
    expect((error as Error).message).toBe('Migration "20261010_03_bad" failed and was rolled back: PostgresError: relation "nope" does not exist');
    expect(((error as Error).cause as Error).message).toBe('relation "nope" does not exist');
  });
});
