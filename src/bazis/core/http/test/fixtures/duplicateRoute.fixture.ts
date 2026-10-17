import { Module } from "../../../di";
import { Bazis } from "../../../kernel";
import { Controller, Get, httpModule } from "../../index";

// Two actions on one route: the server cannot start.
@Controller("orders")
class OrdersController {
  @Get() list() { return []; }
  @Get() all() { return []; }
}

@Module({ imports: [httpModule({ imports: [{ controllers: [OrdersController] }], port: 0, docs: false })], exports: [] })
class AppModule {}

await Bazis.run(AppModule, { environment: "test", startupReport: false, signals: [] });
