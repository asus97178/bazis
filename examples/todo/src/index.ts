import { runApp } from "osnv/core/app";
import { AppModule } from "./app/modules/App.module";
import { AppInfra } from "./app/infra/App.infra";
import { registerOsnovaGeneratedRuntime } from "./generated/osnv/runtime";

await registerOsnovaGeneratedRuntime();
await runApp(AppModule, {
  infra: AppInfra,
  http: { hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true },
});
