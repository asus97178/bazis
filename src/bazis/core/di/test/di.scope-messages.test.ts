import { expect, test } from "bun:test";
import { DI, Module, createContainer, createToken } from "../index";
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

test("a class registered under a token is named together with the token", () => {
  const HOOK = createToken<{ run(): void }>("BazisLifecycleHook");
  class WarmUp { constructor(readonly state: RequestState) {} run() {} }
  class Mailer {}
  class Signup { constructor(readonly mailer: Mailer) {} }
  const MAILER = createToken<Mailer>("IMailer");
  @Module({ providers: [DI.scoped(DI.classProvider(RequestState, RequestState)), DI.singleton(DI.classProvider(HOOK, WarmUp, [RequestState] as const)), DI.scoped(DI.classProvider(createToken<Signup>("ISignup"), Signup, [MAILER] as const))], exports: [] })
  class AppModule {}
  let message = "";
  try { createContainer(AppModule, { validateOnBuild: true }); } catch (error) { message = redactSensitiveText((error as Error).message); }
  expect(message).toContain(
    'Singleton "WarmUp (as BazisLifecycleHook)" depends on scoped "RequestState". A scoped service lives for one request or scope: make "WarmUp" scoped too, or inject ServiceProvider and resolve "RequestState" in a scope you create (provider.createScope()).',
  );
  expect(message).toContain('Missing dependency "IMailer" for "Signup (as ISignup)"');
});
