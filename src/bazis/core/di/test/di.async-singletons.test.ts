import { expect, test } from "bun:test";
import { DI, Module, createContainer, createToken, scoped, singletonAsyncFactory } from "../index";

// Async singletons are created up front, so constructor injection (which
// resolves synchronously) can use them afterwards.
interface Db { readonly id: number }
const Db = createToken<Db>("Db");
const Cache = createToken<string>("Cache");
class Repo { constructor(readonly db: Db) {} }

test("initializeAsyncSingletons makes async singletons resolvable synchronously", async () => {
  let created = 0;
  @Module({ providers: [singletonAsyncFactory(Db, [] as const, async () => ({ id: ++created })), scoped(Repo, Repo, [Db] as const)], exports: [] })
  class App {}
  const container = createContainer(App);
  expect(() => container.createScope().resolve(Repo)).toThrow(/asynchronous/);

  await container.initializeAsyncSingletons();
  await container.initializeAsyncSingletons();
  expect(container.createScope().resolve(Repo).db.id).toBe(1);
  expect(created).toBe(1);
});

test("keyed and dependent async singletons are created in dependency order", async () => {
  const order: string[] = [];
  @Module({
    providers: [
      DI.keyedSingleton("primary", DI.asyncFactoryProvider(Cache, [Db] as const, async (db) => { order.push("cache"); return `cache of ${db.id}`; })),
      singletonAsyncFactory(Db, [] as const, async () => { order.push("db"); return { id: 7 }; }),
    ],
    exports: [],
  })
  class App {}
  const container = createContainer(App);
  await container.initializeAsyncSingletons();
  expect(container.resolveKeyed(Cache, "primary")).toBe("cache of 7");
  expect(order).toEqual(["db", "cache"]);
});
