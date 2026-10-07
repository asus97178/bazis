import { expect, test } from "bun:test";
import { Module, ModuleEncapsulationError, createContainer, createToken, scoped, singleton, type AbstractClass, type Token } from "../index";

// An abstract class is a contract that exists at runtime, so it serves as a
// token without createToken: scoped(IClock, SystemClock). It is the recommended
// form; an interface with a createToken constant of the same name still works.
abstract class IClock {
  abstract now(): string;
}
class SystemClock implements IClock {
  now() { return "system"; }
}
class FixedClock implements IClock {
  now() { return "fixed"; }
}
class Report {
  constructor(private readonly clock: IClock) {}
  text() { return `at ${this.clock.now()}`; }
}

test("an abstract class is accepted as a token by the types", () => {
  const token: Token<IClock> = IClock;
  const key: AbstractClass<IClock> = IClock;
  expect(token).toBe(key);
});

test("an abstract class token resolves to its registered implementation", () => {
  @Module({ providers: [singleton(IClock, SystemClock), scoped(Report, Report, [IClock] as const)], exports: [] })
  class AppModule {}
  const container = createContainer(AppModule);
  const scope = container.createScope();
  expect(scope.resolve(IClock)).toBeInstanceOf(SystemClock);
  expect(scope.resolve(Report).text()).toBe("at system");
});

test("another implementation can be registered under the same contract", () => {
  @Module({ providers: [singleton(IClock, FixedClock), scoped(Report, Report, [IClock] as const)], exports: [] })
  class AppModule {}
  expect(createContainer(AppModule).createScope().resolve(Report).text()).toBe("at fixed");
});

test("module exports work with an abstract class token", () => {
  @Module({ providers: [singleton(IClock, SystemClock)], exports: [IClock] })
  class ClockModule {}
  @Module({ imports: [ClockModule], providers: [scoped(Report, Report, [IClock] as const)], exports: [] })
  class AppModule {}
  expect(createContainer(AppModule).createScope().resolve(Report).text()).toBe("at system");

  @Module({ providers: [singleton(IClock, SystemClock)], exports: [] })
  class HiddenClockModule {}
  @Module({ imports: [HiddenClockModule], providers: [scoped(Report, Report, [IClock] as const)], exports: [] })
  class HiddenAppModule {}
  expect(() => createContainer(HiddenAppModule)).toThrow(ModuleEncapsulationError);
});

test("createToken contracts keep working next to abstract class contracts", () => {
  interface IGreeting { text(): string }
  const IGreeting = createToken<IGreeting>("IGreeting");
  class Hello implements IGreeting { text() { return "hello"; } }
  class Page {
    constructor(private readonly greeting: IGreeting, private readonly clock: IClock) {}
    render() { return `${this.greeting.text()} ${this.clock.now()}`; }
  }

  @Module({
    providers: [singleton(IGreeting, Hello), singleton(IClock, SystemClock), scoped(Page, Page, [IGreeting, IClock] as const)],
    exports: [IGreeting, IClock],
  })
  class AppModule {}
  expect(createContainer(AppModule).createScope().resolve(Page).render()).toBe("hello system");
});
