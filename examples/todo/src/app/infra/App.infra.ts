import { Infra } from "osnv/core/infra";
import { ormOsnovaConnect } from "osnv/core/orm";
import { dbConfig } from "../config/db.config";

/**
 * Infrastructure of the app. `ormOsnovaConnect` opens the PostgreSQL pool
 * before the HTTP server starts and publishes it as DATABASE_PROVIDER;
 * feature modules attach their DbContext to it through `ormOsnova`.
 */
@Infra({
  db: ormOsnovaConnect(dbConfig),
})
export class AppInfra {}
