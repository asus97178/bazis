import { Infra } from "osnv/core/infra";
import { ormOsnvConnect } from "osnv/core/orm";
import { dbConfig } from "../config/db.config";

/**
 * Infrastructure of the app. `ormOsnvConnect` opens the PostgreSQL pool
 * before the HTTP server starts and publishes it as DATABASE_PROVIDER;
 * feature modules attach their DbContext to it through `ormOsnv`.
 */
@Infra({
  db: ormOsnvConnect(dbConfig),
})
export class AppInfra {}
