import { Infra } from "bazis/core/infra";
import { ormBazisConnect } from "bazis/core/orm";
import { dbConfig } from "../config/db.config";

/**
 * Infrastructure of the app. `ormBazisConnect` opens the PostgreSQL pool
 * before the HTTP server starts and publishes it as DATABASE_PROVIDER;
 * feature modules attach their DbContext to it through `ormBazis`.
 */
@Infra({
  db: ormBazisConnect(dbConfig),
})
export class AppInfra {}
