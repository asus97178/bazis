import { App } from "bazis/core/app";
import { AppInfra } from "./infra/App.infra";
import { AppModule } from "./modules/App.module";

/**
 * The application: its modules, its infrastructure and the HTTP server. The
 * address comes from the `http` settings: `BAZIS_HTTP__HOST`, `BAZIS_HTTP__PORT`.
 * `src/index.ts` runs it, the tests start the same one.
 */
@App({
  modules: [AppModule],
  infra: AppInfra,
  http: { health: true },
})
export class TodoApp {}
