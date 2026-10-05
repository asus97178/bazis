import { describe, expect, test } from "bun:test";
import { createContainer, createToken, Global, markGlobal, Module, singleton, type OsnvModuleMetadata } from "../index";

/** Decorators assign module metadata at runtime without changing the class's static type. */
const meta = (moduleClass: unknown): OsnvModuleMetadata => moduleClass as OsnvModuleMetadata;

const CONFIG = createToken<{ readonly value: string }>("Config");

class ConfigService {
  public readonly value = "ok";
}

@Module({
  providers: [singleton(CONFIG, ConfigService)],
  exports: [CONFIG],
})
class ConfigModule {}

describe("@Module", () => {
  test("registers metadata on the decorated class", () => {
    expect(meta(ConfigModule).exports).toEqual([CONFIG]);
    expect(meta(ConfigModule).providers?.length).toBe(1);
  });

  test("builds a valid DI graph", () => {
    class AppModule {}

    Module({
      imports: [ConfigModule],
    })(AppModule, {} as ClassDecoratorContext);

    const container = createContainer(AppModule, { validateOnBuild: true });
    expect(container.resolve(CONFIG).value).toBe("ok");
  });
});

describe("@Global", () => {
  test("marks a decorated module as global", () => {
    @Global()
    @Module({
      providers: [singleton(CONFIG, ConfigService)],
      exports: [CONFIG],
    })
    class GlobalConfigModule {}

    expect(meta(GlobalConfigModule).global).toBe(true);
  });

  test("exports are visible without an explicit import", () => {
    @Global()
    @Module({
      providers: [singleton(CONFIG, ConfigService)],
      exports: [CONFIG],
    })
    class GlobalConfigModule {}

    class ConsumerService {
      public constructor(public readonly config: { readonly value: string }) {}
    }

    @Module({
      imports: [GlobalConfigModule],
      providers: [singleton(createToken<ConsumerService>("Consumer"), ConsumerService, [CONFIG] as const)],
    })
    class ConsumerModule {}

    @Module({
      imports: [ConsumerModule],
    })
    class AppModule {}

    const container = createContainer(AppModule, { validateOnBuild: true });
    expect(container.resolve(CONFIG).value).toBe("ok");
  });

  test("markGlobal works on factory-created modules", () => {
    class FactoryModule {}

    Module({
      providers: [singleton(CONFIG, ConfigService)],
      exports: [CONFIG],
    })(FactoryModule, {} as ClassDecoratorContext);

    markGlobal(FactoryModule);
    expect(meta(FactoryModule).global).toBe(true);
  });
});
