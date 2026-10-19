import { expect, test } from "bun:test";
import { Module, scoped, singleton } from "../../di";
import { registerGeneratedClassDeps } from "../../di/module/autoDeps";
import { namedDependency } from "../../di/provider/types/NamedDependency";
import { defineConfig, Environment, EventBus, LOGGER, type ConfigView, type Logger } from "../../kernel";
import { createTestContainer } from "..";

interface MailConfig { host: string }
const mailConfig = defineConfig<MailConfig>("mail", { default: { host: "localhost" }, test: { host: "smtp.test" } });

class Clock { now() { return "real"; } }
class FakeClock extends Clock { override now() { return "fake"; } }

class Mailer {
  constructor(readonly logger: Logger, readonly events: EventBus, readonly config: ConfigView<MailConfig>, readonly clock: Clock) {}
}
registerGeneratedClassDeps(Mailer, [LOGGER, EventBus, namedDependency("Config:mail"), Clock]);

@Module({ config: mailConfig, providers: [singleton(Clock), scoped(Mailer)], exports: [Mailer] })
class MailModule {}

test("createTestContainer has the kernel services, the test environment and the overrides", async () => {
  const container = await createTestContainer(MailModule, { overrides: [singleton(Clock, FakeClock)] });
  const mailer = container.createScope().resolve(Mailer);
  expect(typeof mailer.logger.info).toBe("function");
  expect(mailer.events).toBeInstanceOf(EventBus);
  expect(mailer.config.get("host")).toBe("smtp.test");
  expect(mailer.clock.now()).toBe("fake");
  expect(container.resolve(Environment).name).toBe("test");
});
