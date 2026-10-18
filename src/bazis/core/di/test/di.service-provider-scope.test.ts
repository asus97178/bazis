import { expect, test } from "bun:test";
import { createContainer, Module, scoped, ServiceProvider, singleton } from "../index";
import { registerGeneratedClassDeps } from "../module/autoDeps";
import { createEventToken, EventBus, KernelBuilder, OnEvent, withEventSubscribers } from "../../kernel";

class RequestState { readonly id = crypto.randomUUID(); }
class ScopedReader { constructor(readonly services: ServiceProvider) {} }
class RootReader { constructor(readonly services: ServiceProvider) {} }
registerGeneratedClassDeps(ScopedReader, [ServiceProvider]);
registerGeneratedClassDeps(RootReader, [ServiceProvider]);

@Module({ providers: [scoped(RequestState), scoped(ScopedReader), singleton(RootReader)], exports: [RequestState, ScopedReader, RootReader] })
class App {}

test("ServiceProvider in a scoped service is its scope; in a singleton it is the root", async () => {
  const container = createContainer(App);
  const scope = container.createScope();
  const reader = scope.resolve(ScopedReader);
  expect(reader.services.resolve(RequestState)).toBe(scope.resolve(RequestState));
  expect(scope.resolve(ServiceProvider)).toBe(reader.services);
  expect(container.resolve(RootReader).services).toBe(container);
  expect(scope.resolve(RootReader).services).toBe(container);

  // A new scope from it is independent; the request scope is not disposed by its consumers.
  const own = reader.services.createScope();
  expect(own.resolve(RequestState)).not.toBe(scope.resolve(RequestState));
  await own.dispose();
  await expect(reader.services.dispose()).rejects.toThrow("This ServiceProvider is the scope that resolved the service; whoever created the scope disposes it. To own a scope, call createScope() and dispose that one.");
  await scope.dispose();
});

interface Pinged { readonly at: string }
const PINGED = createEventToken<Pinged>("test.pinged");

class Audit {
  readonly seen: string[] = [];
  constructor(readonly state: RequestState) {}
  @OnEvent(PINGED)
  onPinged(event: Pinged) { this.seen.push(`${event.at}:${this.state.id}`); }
}
class Pinger {
  constructor(private readonly events: EventBus, private readonly services: ServiceProvider) {}
  ping() { return this.events.publishScoped(this.services, PINGED, { at: "now" }); }
}
registerGeneratedClassDeps(Audit, [RequestState]);
registerGeneratedClassDeps(Pinger, [EventBus, ServiceProvider]);

test("a scoped service publishes to scoped subscribers of its own request", async () => {
  @Module({ providers: [scoped(RequestState), scoped(Audit), ...withEventSubscribers(Audit), scoped(Pinger)], exports: [Pinger, Audit, RequestState] })
  class Events {}
  const kernel = await new KernelBuilder(Events).useStartupReport(false).build();
  const scope = kernel.container.createScope();
  await scope.resolve(Pinger).ping();
  expect(scope.resolve(Audit).seen).toEqual([`now:${scope.resolve(RequestState).id}`]);
  await scope.dispose();
});
