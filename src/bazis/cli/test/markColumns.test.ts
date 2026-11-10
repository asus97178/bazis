import { expect, test } from "bun:test";
import { markColumns } from "../upgrade/markColumns";

test("every column gets the mark of what it was; keys and timestamps are left alone", () => {
  const source = `import { Column, CreatedAt, Entity, Index, Key, SoftDelete, UUID } from "bazis/core/orm";

@Entity({ table: "orders" })
export class Order {
  @UUID()
  id = "";

  @Index({ unique: true })
  @Column({ type: "text" })
  code = "";

  @Column()
  note = "";

  @Column({
    type: "integer",
    nullable: true,
    default: 0,
  })
  amount = 0;

  @Column({ type: "datetime", nullable: true })
  paidAt: Date | null = null;

  @Column({ type: "text", nullable: false })
  status = "new";

  @Column({ nullable: false })
  kind = "";

  @Column({ type: "uuid" })
  ownerId = "";

  @Index()
  shopId = "";

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @CreatedAt()
  @Column()
  madeAt = new Date(0);

  @SoftDelete()
  deletedAt: Date | null = null;
}

@Key(["shopId", "sku"])
@Entity()
export class Stock {
  @Column({ type: "text" }) shopId = "";
  @Column({ type: "text" }) sku = "";
  @Column({ type: "integer" }) left = 0;
  @Key() @Column({ type: "integer", nullable: false }) legacy = 0;
}
`;
  const result = markColumns(source);
  expect(result).toMatchObject({ nullable: 7, required: 2, skipped: [] });
  expect(result.text).toContain(`import { Column, CreatedAt, Entity, Index, Key, SoftDelete, UUID, Nullable, Required } from "bazis/core/orm";`);
  expect(result.text).toContain(`  @Index({ unique: true })\n  @Nullable()\n  @Column({ type: "text" })\n  code = "";`);
  expect(result.text).toContain(`  @Nullable()\n  @Column()\n  note = "";`);
  expect(result.text).toContain(`  @Nullable()\n  @Column({\n    type: "integer",\n    default: 0,\n  })\n  amount = 0;`);
  expect(result.text).toContain(`  @Nullable()\n  @Column({ type: "datetime" })\n  paidAt`);
  expect(result.text).toContain(`  @Required()\n  @Column({ type: "text" })\n  status = "new";`);
  expect(result.text).toContain(`  @Required()\n  @Column()\n  kind = "";`);
  expect(result.text).toContain(`  @Nullable()\n  @Column({ type: "uuid" })\n  ownerId = "";`);
  expect(result.text).toContain(`  @Nullable()\n  @Index()\n  shopId = "";`);
  expect(result.text).toContain(`@Nullable() @Column({ type: "integer" }) left = 0;`);
  // Untouched: the keys, the timestamps, the soft-delete column.
  expect(result.text).toContain(`  @UUID()\n  id = "";`);
  expect(result.text).toContain(`  @Column({ type: "createdAt" })\n  createdAt`);
  expect(result.text).toContain(`  @CreatedAt()\n  @Column()\n  madeAt`);
  expect(result.text).toContain(`  @SoftDelete()\n  deletedAt`);
  expect(result.text).toContain(`  @Column({ type: "text" }) shopId = "";`);
  expect(result.text).toContain(`  @Key() @Column({ type: "integer" }) legacy = 0;`);
  expect(result.text).not.toContain("nullable:");
  // A second run changes nothing.
  expect(markColumns(result.text)).toMatchObject({ text: result.text, nullable: 0, required: 0 });
});

test("a column that already has a mark keeps it", () => {
  const source = `import { Column, Entity, Nullable, Required, UUID } from "bazis/core/orm";
@Entity()
export class Task {
  @UUID() id = "";
  @Required() @Column({ type: "text" }) title = "";
  @Nullable() @Column({ type: "text" }) note: string | null = null;
}
`;
  expect(markColumns(source)).toEqual({ text: source, nullable: 0, required: 0, skipped: [] });
});

test("what cannot be decided is reported, not guessed", () => {
  const result = markColumns(`const text = { type: "text" } as const;
const maybe = true;
class A {
  @Column(text) a = "";
  @Column({ ...text }) b = "";
  @Column({ nullable: maybe }) c = "";
  @Column({ type: "text" }) d = "";
  plain = 1;
}
`, "a.ts");
  expect(result.nullable).toBe(1);
  expect(result.skipped).toEqual([
    "a.ts: A.a: the options of @Column are not written in place; mark the column @Required() or @Nullable() by hand",
    "a.ts: A.b: the options of @Column are not written in place; mark the column @Required() or @Nullable() by hand",
    "a.ts: A.c: nullable is not true or false here; mark the column @Required() or @Nullable() by hand",
    "a.ts: import Nullable from the ORM by hand: the file has no import of its decorators to add them to",
  ]);
});

test("a file without entities is returned as it is", () => {
  const source = `export const x = 1;\n`;
  expect(markColumns(source)).toEqual({ text: source, nullable: 0, required: 0, skipped: [] });
});

test("bazis upgrade columns: parsed, and it changes a directory once", async () => {
  const { parseCliArgs } = await import("../parseCli");
  expect(parseCliArgs(["upgrade", "columns"])).toEqual({ kind: "upgrade", action: "columns", dryRun: false });
  expect(parseCliArgs(["upgrade", "columns", "--path", "packages/shop/src", "--dry-run"])).toEqual({ kind: "upgrade", action: "columns", path: "packages/shop/src", dryRun: true });
  expect(parseCliArgs(["upgrade"])).toMatchObject({ kind: "error" });
  expect(parseCliArgs(["upgrade", "columns", "--force"])).toMatchObject({ kind: "error" });

  const { runUpgradeColumns } = await import("../upgrade/runUpgrade");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "bazis-upgrade-"));
  try {
    const model = path.join(root, "src/app/Task.model.ts");
    const original = `import { Column, Entity, UUID } from "bazis/core/orm";\n@Entity()\nexport class Task {\n  @UUID() id = "";\n  @Column({ type: "text", nullable: false }) title = "";\n  @Column({ type: "text" }) note = "";\n}\n`;
    await Bun.write(model, original);
    await Bun.write(path.join(root, "src/generated/bazis/skip.ts"), original);
    await Bun.write(path.join(root, "src/plain.ts"), "export const x = 1;\n");
    const lines: string[] = [];
    expect(await runUpgradeColumns(root, undefined, true, (line) => lines.push(line))).toBe(0);
    expect(await Bun.file(model).text()).toBe(original);
    expect(lines.join("\n")).toContain("would change src/app/Task.model.ts: 1 @Nullable(), 1 @Required()");

    lines.length = 0;
    expect(await runUpgradeColumns(root, undefined, false, (line) => lines.push(line))).toBe(0);
    expect(await Bun.file(model).text()).toBe(`import { Column, Entity, UUID, Nullable, Required } from "bazis/core/orm";\n@Entity()\nexport class Task {\n  @UUID() id = "";\n  @Required() @Column({ type: "text" }) title = "";\n  @Nullable() @Column({ type: "text" }) note = "";\n}\n`);
    expect(await Bun.file(path.join(root, "src/generated/bazis/skip.ts")).text()).toBe(original);
    expect(lines.at(-1)).toContain("Changed 1 file: 1 columns marked @Nullable(), 1 marked @Required()");

    lines.length = 0;
    expect(await runUpgradeColumns(root, undefined, false, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual(["Nothing to change: every column already says whether it may be empty."]);
    expect(await runUpgradeColumns(root, "nope", false, (line) => lines.push(line))).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
