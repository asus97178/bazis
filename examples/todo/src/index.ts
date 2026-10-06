import { runApp } from "bazis/core/app";
import { AppModule } from "./app/modules/App.module";
import { AppInfra } from "./app/infra/App.infra";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(AppModule, {
  infra: AppInfra,
  http: { hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true },
});
