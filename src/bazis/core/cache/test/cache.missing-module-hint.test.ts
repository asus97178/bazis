import { expect, test } from "bun:test";
import { createContainer, createToken, Module, scoped } from "../../di";
import { ICache } from "..";

const CLOCK = createToken<{ now(): string }>("IClock");
class Catalog { constructor(readonly cache: ICache, readonly clock: { now(): string }) {} }

test("a missing ICache says to add a cache module; a dependency without a hint ends without a period", () => {
  @Module({ providers: [scoped(Catalog, Catalog, [ICache, CLOCK] as const)], exports: [] })
  class App {}
  let message = "";
  try { createContainer(App, { validateOnBuild: true }); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('Missing dependency "ICache" for "Catalog". The cache is provided by a cache module: add cache: memory() to the runApp options (startTestApp takes the same options).');
  expect(message.split("\n")).toContain('Missing dependency "IClock" for "Catalog"');
});
