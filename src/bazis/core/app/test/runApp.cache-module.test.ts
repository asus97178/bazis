import { expect, test } from "bun:test";
import { CacheableRedis, Cacheable, memory } from "@/core/cache";
import { Module, singleton } from "@/core/di";
import { Bazis } from "@/core/kernel";
import { composeApp } from "@/core/app/runApp";

// 0.111.0: without a cache module (`cache: memory()`) the cache decorators had
// no effect and nothing said so: every call ran the method.
class Stock {
  calls = 0;
  @CacheableRedis({ seconds: 30, key: (sku) => `stock:${String(sku)}` })
  async stock(sku: string) { this.calls++; return { sku }; }
}
class Prices {
  calls = 0;
  @Cacheable({ seconds: 30 })
  async price() { this.calls++; return 1; }
}

@Module({ providers: [singleton(Stock), singleton(Prices)] })
class AppModule {}

const build = (options: Parameters<typeof composeApp>[1]) =>
  Bazis.createBuilder(composeApp(AppModule, options)).useApplicationRoot(AppModule).useEnvironment("test").build();

test("a cached service without a cache module stops the start and says how to fix it", async () => {
  const error = await build({}).then(() => undefined, (e: unknown) => e as Error);
  expect(error?.message).toContain(`Missing dependency "ICache" for "Stock"`);
  expect(error?.message).toContain("add cache: memory() to the runApp options");
});

test("with cache: memory() the services are cached as before", async () => {
  const kernel = await build({ cache: memory() });
  const prices = kernel.container.resolve(Prices);
  await prices.price(); await prices.price();
  expect(prices.calls).toBe(1);
  await kernel.container.dispose();
});
