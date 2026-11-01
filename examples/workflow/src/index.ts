import { runApp } from "bazis/core/app";
import { signedIn } from "./app/auth/signedIn";
import { AppInfra } from "./app/infra/App.infra";
import { AppModule } from "./app/modules/App.module";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(AppModule, {
  infra: AppInfra,
  http: { hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true, authorize: signedIn },
});
