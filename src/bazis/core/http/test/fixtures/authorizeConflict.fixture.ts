import { Module } from "../../../di";
import { Bazis } from "../../../kernel";
import { AllowAnonymous, Authorize, Controller, Get, httpModule } from "../../index";

// @AllowAnonymous and @Authorize on one action: the server cannot start.
@Controller("reports")
class ReportsController {
  @Get("bug") @AllowAnonymous() @Authorize(() => true) bug() { return {}; }
}

@Module({ imports: [httpModule({ imports: [{ controllers: [ReportsController] }], port: 0, docs: false })], exports: [] })
class AppModule {}

await Bazis.run(AppModule, { environment: "test", startupReport: false, signals: [] });
