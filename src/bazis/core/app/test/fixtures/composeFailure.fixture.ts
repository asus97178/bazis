import { Module } from "../../../di";
import { AllowAnonymous, Authorize, Controller, Get } from "../../../http";
import { App, runApp } from "../../runApp";

// A route error found while runApp composes the application (the OpenAPI
// document is built before the kernel starts).
@Controller("reports")
class ReportsController {
  @Get("bug") @AllowAnonymous() @Authorize(() => true) bug() { return {}; }
}

@Module({ controllers: [ReportsController] })
class AppModule {}

@App({ modules: [AppModule], http: { hostname: "127.0.0.1", port: 0 }, kernel: { environment: "development", signals: [] } })
class Application {}
await runApp(Application);
