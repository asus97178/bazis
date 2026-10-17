import { expect, test } from "bun:test";
import { DI, InvalidProviderError, Module, ServiceValidationError, createContainer } from "../index";

// 0.100.8: DI errors found while writing the error reference.

class Clock {}

test("a raw { provide } object in module providers is an InvalidProviderError with the module and position", () => {
  @Module({ providers: [DI.singleton(DI.valueProvider(Symbol.for("x") as never, 1)), { provide: Clock } as never], exports: [] })
  class ClockModule {}
  // 0.100.7: TypeError: undefined is not an object (evaluating 'definition.provider.provide')
  expect(() => createContainer(ClockModule)).toThrow(InvalidProviderError);
  expect(() => createContainer(ClockModule)).toThrow(
    'Module "ClockModule": providers[1] is not a provider registration ({ provide: Clock }). Register it with singleton(Clock), scoped(Clock), transient(Clock), singletonValue(TOKEN, value) or singletonFactory(TOKEN, [deps], factory).',
  );
});

class OrderService { constructor(readonly invoices: InvoiceService) {} }
class InvoiceService { constructor(readonly orders: OrderService) {} }

test("a dependency cycle is reported once, not once per member", () => {
  @Module({
    providers: [
      DI.scoped(DI.classProvider(OrderService, OrderService, [InvoiceService] as const)),
      DI.scoped(DI.classProvider(InvoiceService, InvoiceService, [OrderService] as const)),
    ],
    exports: [],
  })
  class CycleModule {}
  let error: unknown;
  try { createContainer(CycleModule, { validateOnBuild: true }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ServiceValidationError);
  expect((error as ServiceValidationError).issues).toEqual(["Cycle detected: InvoiceService -> OrderService -> InvoiceService"]);
});

class CartRepository {}

test("a scoped service resolved from the root says how to get a scope", () => {
  @Module({ providers: [DI.scoped(DI.classProvider(CartRepository, CartRepository))], exports: [] })
  class CartModule {}
  const container = createContainer(CartModule);
  expect(() => container.resolve(CartRepository)).toThrow(
    'Cannot resolve scoped service "CartRepository" from root provider. A scoped service lives in a request or a scope: create one with provider.createScope(), resolve "CartRepository" from it and dispose the scope when done.',
  );
});
