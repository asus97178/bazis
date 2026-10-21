import { Module } from "../../../di";
import { AllowAnonymous, Authorize, Controller, Get } from "../../../http";
import { runApp } from "../../runApp";

// A route error found while runApp composes the application (the OpenAPI
// document is built before the kernel starts).
@Controller("reports")
class ReportsController {
  @Get("bug") @AllowAnonymous() @Authorize(() => true) bug() { return {}; }
}

@Module({ controllers: [ReportsController] })
class AppModule {}

await runApp(AppModule, { http: { hostname: "127.0.0.1", port: 0 }, kernel: { environment: "development", signals: [] } });
