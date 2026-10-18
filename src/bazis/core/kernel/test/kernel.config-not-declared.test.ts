import { expect, test } from "bun:test";
import { Module, scoped } from "../../di";
import { registerGeneratedClassDeps } from "../../di/module/autoDeps";
import { namedDependency } from "../../di/provider/types/NamedDependency";
import { defineConfig, KernelBuilder, memorySource, type ConfigView } from "..";

interface CryptoConfig { phoneKey: string }
const cryptoConfig = defineConfig<CryptoConfig>("crypto", { default: { phoneKey: "dev" } });

class PhoneHash { constructor(readonly config: ConfigView<CryptoConfig>) {} }
registerGeneratedClassDeps(PhoneHash, [namedDependency("Config:crypto")]);

test("a ConfigView<T> of a config no module declares names the service and where to declare the config", async () => {
  @Module({ providers: [scoped(PhoneHash)], exports: [] })
  class App {}
  const error = await new KernelBuilder(App).useStartupReport(false).addConfigSource(memorySource({})).build().catch((caught: unknown) => caught);
  expect(String((error as Error).message)).toContain(
    'Missing dependency "Config:crypto" for "PhoneHash". The config defineConfig("crypto", …) is not declared in the application: add it to `config` of the module that uses it, or to runApp({ config }).',
  );
});

test("the same ConfigView<T> resolves once the module declares the config", async () => {
  @Module({ config: cryptoConfig, providers: [scoped(PhoneHash)], exports: [PhoneHash] })
  class App {}
  const kernel = await new KernelBuilder(App).useStartupReport(false).addConfigSource(memorySource({})).build();
  expect(kernel.container.createScope().resolve(PhoneHash).config.get("phoneKey")).toBe("dev");
});
