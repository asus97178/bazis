import { App } from "bazis/core/app";
import { signedIn } from "./auth/signedIn";
import { AppInfra } from "./infra/App.infra";
import { AppModule } from "./modules/App.module";

/**
 * The application: its modules, its infrastructure and the HTTP server, where
 * every route needs a signed-in user. `src/index.ts` runs it, the tests start
 * the same one.
 */
@App({
  modules: [AppModule],
  infra: AppInfra,
  http: { health: true, authorize: signedIn },
})
export class OrdersApp {}
