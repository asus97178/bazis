import { describe, expect, test } from "bun:test";
import {
  ModelBuildError,
  OrmModel,
  PostgresDialect,
  buildDynamicModel,
  type DynamicTableDefinition,
} from "@/library/orm";

const productDef: DynamicTableDefinition = {
  name: "Product",
  tableName: "products",
  fields: [
    { name: "id", type: "int", isKey: true },
    { name: "title", type: "string", required: true, indexed: true },
    { name: "price", type: "decimal", required: true },
    { name: "active", type: "bool" },
    { name: "meta", type: "json" },
  ],
};

describe("DynamicModelBuilder", () => {
  test("builds a model with int identity key and mapped storage types", () => {
    const model = buildDynamicModel(productDef);

    expect(model.name).toBe("Product");
    expect(model.tableName).toBe("products");
    expect(model.key[0].propertyName).toBe("id");
    expect(model.key[0].type).toBe("integer");
    expect(model.key[0].generation).toBe("identity");

    expect(model.propertyByName("title")?.type).toBe("text");
    expect(model.propertyByName("price")?.type).toBe("real");
    expect(model.propertyByName("active")?.type).toBe("boolean");
    expect(model.propertyByName("meta")?.type).toBe("json");
    expect(model.propertyByName("title")?.required).toBe(true);
    expect(model.propertyByName("active")?.required).toBe(false);
  });

  test("qualifies table name with schema", () => {
    const model = buildDynamicModel({ ...productDef, schema: "data" });
    expect(model.tableName).toBe("data.products");
  });

  test("derives DB-generated uuid key for dynamic models", () => {
    const model = buildDynamicModel({
      name: "Doc",
      fields: [{ name: "id", type: "uuid", isKey: true }],
    });
    expect(model.key[0].type).toBe("text");
    expect(model.key[0].generation).toBe("uuid");
    expect(model.key[0].convention).toBeUndefined();
    expect(model.key[0].required).toBe(true);
  });

  test("builds indexes from flags and explicit definitions", () => {
    const model = buildDynamicModel({
      name: "Order",
      tableName: "orders",
      fields: [
        { name: "id", type: "int", isKey: true },
        { name: "sku", type: "string", unique: true },
        { name: "buyer", type: "string", indexed: true },
      ],
      indexes: [{ columns: ["sku", "buyer"] }],
    });

    const names = model.indexes.map((index) => index.name);
    expect(names).toContain("ix_orders_sku");
    expect(names).toContain("ix_orders_buyer");
    expect(names).toContain("ix_orders_sku_buyer");
    expect(model.indexes.find((index) => index.name === "ix_orders_sku")?.unique).toBe(true);
    expect(model.indexes.find((index) => index.name === "ix_orders_buyer")?.unique).toBe(false);
  });

  test("compiles a foreign-key field into storage, reference navigation and DDL metadata", () => {
    const category = buildDynamicModel({
      name: "Category",
      tableName: "categories",
      fields: [{ name: "id", type: "int", isKey: true }],
    });
    const product = buildDynamicModel({
      name: "Product",
      tableName: "products",
      fields: [
        { name: "id", type: "int", isKey: true },
        {
          name: "categoryId",
          columnName: "category_id",
          type: "foreignKey",
          target: "Category",
          navigationName: "category",
          inverseNavigationName: "products",
          targetKeyType: "int",
          required: true,
        },
      ],
    }, (name) => {
      if (name !== "Category") throw new Error(`Unexpected target ${name}`);
      return category.ctor;
    });

    expect(product.propertyByName("categoryId")).toMatchObject({
      columnName: "category_id",
      type: "integer",
      generation: "none",
      required: true,
    });
    expect(product.propertyByName("categoryId")?.convention).toBeUndefined();
    expect(product.relationByName("category")).toMatchObject({
      kind: "reference",
      foreignKey: "categoryId",
    });
    expect(product.relationByName("category")?.target()).toBe(category.ctor);
    expect(product.foreignKeys).toHaveLength(1);
    expect(product.foreignKeys[0]?.property).toBe("categoryId");
    expect(product.foreignKeys[0]?.target()).toBe(category.ctor);
  });

  test("resolves a self foreign key to the model own constructor", () => {
    const node = buildDynamicModel({
      name: "Node",
      fields: [
        { name: "id", type: "uuid", isKey: true },
        {
          name: "parentId",
          type: "foreignKey",
          target: "Node",
          navigationName: "parent",
          targetKeyType: "uuid",
        },
      ],
    });

    expect(node.propertyByName("parentId")).toMatchObject({ type: "text", generation: "none" });
    expect(node.propertyByName("parentId")?.convention).toBeUndefined();
    expect(node.relationByName("parent")?.target()).toBe(node.ctor);
    expect(node.foreignKeys[0]?.target()).toBe(node.ctor);
  });

  test("keeps server-derived inverse collection relations", () => {
    const productCtor = class Product {};
    const category = buildDynamicModel({
      name: "Category",
      fields: [{ name: "id", type: "int", isKey: true }],
      relations: [{
        navigationName: "products",
        kind: "collection",
        target: "Product",
        foreignKey: "categoryId",
      }],
    }, () => productCtor);

    expect(category.relationByName("products")).toMatchObject({
      kind: "collection",
      foreignKey: "categoryId",
    });
    expect(category.foreignKeys).toHaveLength(0);
  });

  test("rejects invalid definitions (fail fast)", () => {
    expect(() => buildDynamicModel({ name: "Empty", fields: [] })).toThrow(ModelBuildError);
    expect(() =>
      buildDynamicModel({ name: "NoKey", fields: [{ name: "x", type: "string" }] }),
    ).toThrow(ModelBuildError);
    expect(() =>
      buildDynamicModel({
        name: "TwoKeys",
        fields: [
          { name: "a", type: "int", isKey: true },
          { name: "b", type: "int", isKey: true },
        ],
      }),
    ).toThrow(ModelBuildError);
    expect(() =>
      buildDynamicModel({
        name: "DupField",
        fields: [
          { name: "id", type: "int", isKey: true },
          { name: "id", type: "string" },
        ],
      }),
    ).toThrow(ModelBuildError);
    expect(() =>
      buildDynamicModel({
        name: "BadIndex",
        fields: [{ name: "id", type: "int", isKey: true }],
        indexes: [{ columns: ["missing"] }],
      }),
    ).toThrow(ModelBuildError);

    const baseForeignKey = {
      name: "ownerId",
      type: "foreignKey" as const,
      target: "Owner",
      navigationName: "owner",
      targetKeyType: "int" as const,
    };
    const withForeignKey = (field: DynamicTableDefinition["fields"][number]): DynamicTableDefinition => ({
      name: "Owned",
      fields: [{ name: "id", type: "int" as const, isKey: true }, field],
    });
    expect(() => buildDynamicModel(withForeignKey({ ...baseForeignKey, target: "" }))).toThrow("has no target");
    expect(() => buildDynamicModel(withForeignKey({ ...baseForeignKey, navigationName: "" }))).toThrow("has no navigationName");
    expect(() => buildDynamicModel(withForeignKey({ ...baseForeignKey, targetKeyType: undefined }))).toThrow("has no targetKeyType");
    expect(() => buildDynamicModel(withForeignKey({ ...baseForeignKey, isKey: true }))).toThrow("cannot be a primary key");
    expect(() => buildDynamicModel(withForeignKey({ ...baseForeignKey, convention: "uuid" }))).toThrow("cannot declare convention");
    expect(() => buildDynamicModel(withForeignKey({ ...baseForeignKey, uuidVersion: "v7" }))).toThrow("cannot declare convention");
  });
});

describe("OrmModel runtime registration", () => {
  test("registerModel exposes model by name and ctor", () => {
    const registry = new OrmModel([]);
    const model = buildDynamicModel(productDef);

    expect(registry.tryByName("Product")).toBeUndefined();
    registry.registerModel(model);

    expect(registry.tryByName("Product")).toBe(model);
    expect(registry.tryByCtor(model.ctor)).toBe(model);
    expect(registry.entities).toContain(model);
  });

  test("unregister removes the model", () => {
    const registry = new OrmModel([]);
    const model = buildDynamicModel(productDef);
    registry.registerModel(model);
    registry.unregister("Product");

    expect(registry.tryByName("Product")).toBeUndefined();
    expect(registry.tryByCtor(model.ctor)).toBeUndefined();
  });

  test("re-registering a name drops the previous ctor", () => {
    const registry = new OrmModel([]);
    const first = buildDynamicModel(productDef);
    const second = buildDynamicModel(productDef); // a different ctor
    registry.registerModel(first);
    registry.registerModel(second);

    expect(registry.tryByName("Product")).toBe(second);
    expect(registry.tryByCtor(first.ctor)).toBeUndefined();
    expect(registry.tryByCtor(second.ctor)).toBe(second);
  });
});

describe("Dialect DDL for dynamic schema", () => {
  const model = buildDynamicModel({ ...productDef, schema: "data" });

  test("postgres quoteId escapes one literal identifier; qualifyTable joins schema and table", () => {
    const dialect = new PostgresDialect();
    expect(dialect.quoteId("data.products")).toBe('"data.products"');
    expect(dialect.quoteId("products")).toBe('"products"');
    expect(dialect.qualifyTable(model)).toBe('"data"."products"');
  });

  test("postgres dropColumnSql targets the qualified table", () => {
    const dialect = new PostgresDialect();
    expect(dialect.dropColumnSql(model, "title")).toBe(
      'ALTER TABLE "data"."products" DROP COLUMN IF EXISTS "title"',
    );
  });

  test("PostgreSQL renders a native UUID FK type and inline REFERENCES for add-column", () => {
    const owner = buildDynamicModel({
      name: "Owner",
      tableName: "owners",
      fields: [{ name: "id", type: "uuid", isKey: true }],
    });
    const owned = buildDynamicModel({
      name: "Owned",
      tableName: "owned",
      fields: [
        { name: "id", type: "int", isKey: true },
        {
          name: "ownerId",
          columnName: "owner_id",
          type: "foreignKey",
          target: "Owner",
          navigationName: "owner",
          targetKeyType: "uuid",
        },
      ],
    }, () => owner.ctor);
    const property = owned.propertyByName("ownerId")!;
    const constraint = {
      column: property.columnName,
      referencedTable: owner.tableName,
      referencedColumn: owner.key[0].columnName,
      columnType: "uuid" as const,
    };

    const postgres = new PostgresDialect();
    expect(postgres.createTableSql(owned, [constraint])).toContain('"owner_id" uuid');
    expect(postgres.createTableSql(owned, [constraint])).toContain(
      'FOREIGN KEY ("owner_id") REFERENCES "owners" ("id")',
    );
    expect(postgres.addColumnSql(owned, property, constraint)).toBe(
      'ALTER TABLE "owned" ADD COLUMN IF NOT EXISTS "owner_id" uuid REFERENCES "owners" ("id")',
    );

  });
});
