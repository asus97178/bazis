import { expect, test } from "bun:test";
import { DI, Module, createContainer } from "../index";
import { redactSensitiveText } from "../../../library/redaction";

// A singleton that takes a scoped service says what to do about it (0.98.15).
class RequestState { readonly id = Math.random(); }
class PriceCache { constructor(readonly state: RequestState) {} }

test("a singleton depending on a scoped service gets a hint", () => {
  @Module({ providers: [DI.scoped(DI.classProvider(RequestState, RequestState)), DI.singleton(DI.classProvider(PriceCache, PriceCache, [RequestState] as const))], exports: [] })
  class AppModule {}
  let message = "";
  try { createContainer(AppModule, { validateOnBuild: true }); } catch (error) { message = redactSensitiveText((error as Error).message); }
  expect(message).toContain(
    'Singleton "PriceCache" depends on scoped "RequestState". A scoped service lives for one request or scope: make "PriceCache" scoped too, or inject ServiceProvider and resolve "RequestState" in a scope you create (provider.createScope()).',
  );
});
