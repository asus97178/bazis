import { expect, test } from "bun:test";
import { Module, singleton } from "@/core/di";
import { AllowAnonymous, Authorize, Controller, Get } from "@/core/http";
import { Bazis } from "@/core/kernel";
import { StartupScreen } from "@/core/kernel/report/StartupScreen";
import { composeApp } from "@/core/app/runApp";

class ReportsService {}

@Controller("reports")
class ReportsController {
  @Get()
  list() { return []; }

  @Get("secret")
  @Authorize(() => true)
  secret() { return {}; }

  @Get("public")
  @AllowAnonymous()
  open() { return {}; }
}

@Module({ controllers: [ReportsController], providers: [singleton(ReportsService)], exports: [ReportsService] })
class ReportsModule {}

@Module({})
class EmptyModule {}

@Module({ imports: [ReportsModule, EmptyModule] })
class AppModule {}

test("the startup screen lists the application's modules, routes with their protection and the links", async () => {
  let text = "";
  const output = { write: (chunk: string) => { text += chunk; }, isTTY: false };
  const screen = new StartupScreen({ stdout: output, stderr: output, language: "en", header: false, watch: "src/" });
  const kernel = await Bazis.createBuilder(composeApp(AppModule, { http: { hostname: "127.0.0.1", port: 0, health: true } }))
    .useApplicationRoot(AppModule)
    .useEnvironment("development")
    .useStartupScreen((started) => screen.started(started))
    .build();
  await kernel.start();
  await kernel.stop();
  // The tree starts at the application module, not at the HTTP host around it.
  expect(text).toContain("◉ AppModule");
  expect(text).not.toContain("HttpModule");
  expect(text).toMatch(/controller ReportsController · \/reports · 3 routes/);
  expect(text).toContain("service    ReportsService · singleton");
  expect(text).toContain("empty — add providers, controllers or tools");
  expect(text).toMatch(/GET\s+\/reports\s+ReportsController\.list\s+○ open/);
  expect(text).toMatch(/GET\s+\/reports\/secret\s+ReportsController\.secret\s+🔒 protected/);
  expect(text).toContain("plus GET /health");
  // An explicit @AllowAnonymous is a decision, not a warning.
  expect(text).toContain("1 route is open — no @Authorize.");
  expect(text).toMatch(/Local\s+http:\/\/127\.0\.0\.1:\d+/);
  expect(text).toMatch(/Health\s+http:\/\/127\.0\.0\.1:\d+\/health/);
  expect(text).toContain("watching src/ · restarts on change");
});
