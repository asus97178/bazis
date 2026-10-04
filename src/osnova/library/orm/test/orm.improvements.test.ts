import { expect, test } from "bun:test";
import { ChangeTracker, Column, DbUpdateError, Entity, EntityState, ForeignKey, HasConversion, Key, ModelBuilder } from "../index";

const bytesAsText = {
  toProvider: (value: Uint8Array) => [...value].join(","),
  fromProvider: (value: string) => new Uint8Array(value.split(",").map(Number)),
};

@Entity()
class Account { @Key() id = 0; @Column({ type: "json" }) meta: Record<string, unknown> = {}; }

@Entity()
class TimestampedAccount { @Key({ generated: false }) id = 0; @Column({ type: "datetime" }) changedAt = new Date(0); }

@Entity()
class CompositeAccount { @Key(["tenant", "id"]) @Column({ type: "text" }) tenant = ""; @Column({ type: "integer" }) id = 0; @Column({ type: "text" }) name = ""; }

@Entity()
@ForeignKey(() => SelfReference, { properties: ["parentId"] })
class SelfReference { @Key({ generated: false }) id = 0; @Column({ type: "integer", nullable: true }) parentId: number | null = null; }

@Entity()
@ForeignKey(() => MutualRight, { properties: ["rightId"] })
class MutualLeft { @Key({ generated: false }) id = 0; @Column({ type: "integer" }) rightId = 0; }

@Entity()
@ForeignKey(() => MutualLeft, { properties: ["leftId"] })
class MutualRight { @Key({ generated: false }) id = 0; @Column({ type: "integer" }) leftId = 0; }

@Entity()
class ByteKeyAccount { @Key({ generated: false }) @HasConversion(bytesAsText) @Column({ type: "text" }) id = new Uint8Array([1]); @Column({ type: "text" }) name = ""; }

@Entity()
class CompositeByteKeyAccount { @Key(["tenant", "id"]) @HasConversion(bytesAsText) @Column({ type: "text" }) tenant = new Uint8Array([1]); @Column({ type: "text" }) id = "one"; @Column({ type: "text" }) name = ""; }

@Entity()
class BlobPayloadAccount { @Key({ generated: false }) id = 0; @HasConversion(bytesAsText) @Column({ type: "text" }) payload = new Uint8Array([1, 2]); }

@Entity()
class ConvertedDateAccount { @Key({ generated: false }) id = 0; @HasConversion({ toProvider: (value: Date) => value.toISOString(), fromProvider: (value: string) => new Date(value) }) @Column({ type: "text" }) at = new Date("2026-01-01T00:00:00Z"); }

test("detectChanges reuses JSON snapshot signatures", () => {
  const tracker = new ChangeTracker(); const account = new Account(); account.id = 1; account.meta = { items: [{ index: 1 }] };
  tracker.trackLoaded(account, ModelBuilder.build(Account)); tracker.detectChanges(); expect(tracker.stateOf(account)).toBe(EntityState.Unchanged);
  (account.meta.items as Array<unknown>).push({ index: 2 }); tracker.detectChanges(); expect(tracker.stateOf(account)).toBe(EntityState.Modified);
});

test("explicit update retains its full-column intent through detectChanges", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new Account(), { id: 1 }); const model = ModelBuilder.build(Account);
  tracker.update(account, model); tracker.detectChanges();
  expect(tracker.stateOf(account)).toBe(EntityState.Modified);
  expect(tracker.entriesToProcess()[0]!.modifiedProperties).toEqual(new Set(["meta"]));
});

test("tracked primary-key mutation is rejected without changing the identity entry", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new Account(), { id: 1 }); const model = ModelBuilder.build(Account);
  tracker.trackLoaded(account, model); account.id = 2;
  expect(() => tracker.detectChanges()).toThrow(DbUpdateError);
  expect(tracker.tryGetByKey(model, 1)).toBe(account);
  account.id = 1; tracker.detectChanges(); expect(tracker.stateOf(account)).toBe(EntityState.Unchanged);
});

test("deleted tracked primary-key mutation is rejected before a delete predicate is built", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new Account(), { id: 1 }); const model = ModelBuilder.build(Account);
  tracker.trackLoaded(account, model); tracker.remove(account, model); account.id = 2;
  expect(() => tracker.detectChanges()).toThrow(DbUpdateError);
  expect(tracker.tryGetByKey(model, 1)).toBeUndefined();
});

test("tracked composite primary-key mutation is rejected before DML", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new CompositeAccount(), { tenant: "a", id: 1 }); const model = ModelBuilder.build(CompositeAccount);
  tracker.trackLoaded(account, model); account.tenant = "b";
  expect(() => tracker.detectChanges()).toThrow(DbUpdateError);
  expect(tracker.tryGetByKey(model, { tenant: "a", id: 1 })).toBe(account);
});

test("tracked mutable byte primary-key mutation is rejected while an equal replacement remains valid", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new ByteKeyAccount(), { id: new Uint8Array([1]), name: "before" }); const model = ModelBuilder.build(ByteKeyAccount);
  tracker.trackLoaded(account, model); account.id[0] = 2; account.name = "after";
  expect(() => tracker.detectChanges()).toThrow(DbUpdateError);
  expect(tracker.tryGetByKey(model, new Uint8Array([1]))).toBe(account);
  account.id = new Uint8Array([1]); tracker.detectChanges(); expect(tracker.stateOf(account)).toBe(EntityState.Modified);
});

test("tracked composite mutable byte primary-key mutation is rejected", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new CompositeByteKeyAccount(), { tenant: new Uint8Array([1]), id: "one" }); const model = ModelBuilder.build(CompositeByteKeyAccount);
  tracker.trackLoaded(account, model); account.tenant[0] = 2;
  expect(() => tracker.detectChanges()).toThrow(DbUpdateError);
  expect(tracker.tryGetByKey(model, { tenant: new Uint8Array([1]), id: "one" })).toBe(account);
});

test("unchanged non-key byte payload does not become dirty through key snapshot protection", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new BlobPayloadAccount(), { id: 1 });
  tracker.trackLoaded(account, ModelBuilder.build(BlobPayloadAccount)); tracker.detectChanges();
  expect(tracker.stateOf(account)).toBe(EntityState.Unchanged);
});

test("unchanged converted non-datetime Date keeps its established reference tracking semantics", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new ConvertedDateAccount(), { id: 1 });
  tracker.trackLoaded(account, ModelBuilder.build(ConvertedDateAccount)); tracker.detectChanges();
  expect(tracker.stateOf(account)).toBe(EntityState.Unchanged);
});

test("Date snapshots compare timestamps and isolate in-place mutation", () => {
  const tracker = new ChangeTracker(); const account = Object.assign(new TimestampedAccount(), { id: 1, changedAt: new Date("2026-01-01T00:00:00Z") }); const model = ModelBuilder.build(TimestampedAccount);
  tracker.trackLoaded(account, model); account.changedAt.setUTCFullYear(2027); tracker.detectChanges(); expect(tracker.stateOf(account)).toBe(EntityState.Modified);
  const equal = Object.assign(new TimestampedAccount(), { id: 2, changedAt: new Date("2026-01-01T00:00:00Z") }); tracker.trackLoaded(equal, model); equal.changedAt = new Date("2026-01-01T00:00:00Z"); tracker.detectChanges(); expect(tracker.stateOf(equal)).toBe(EntityState.Unchanged);
});

test("class-level self and mutual foreign keys resolve without recursive model building", () => {
  expect(ModelBuilder.build(SelfReference).foreignKeys).toHaveLength(1);
  expect(ModelBuilder.build(MutualLeft).foreignKeys).toHaveLength(1);
  expect(ModelBuilder.build(MutualRight).foreignKeys).toHaveLength(1);
});
