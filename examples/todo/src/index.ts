import { runApp } from "osnv/core/app";
import { AppModule } from "./app/modules/App.module";
import { AppInfra } from "./app/infra/App.infra";
import { registerOsnvGeneratedRuntime } from "./generated/osnv/runtime";

await registerOsnvGeneratedRuntime();
await runApp(AppModule, {
  infra: AppInfra,
  http: { hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true },
});
