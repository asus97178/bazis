import { createToken } from "../di";
import type { DatabaseProvider } from "../../library/orm";

/** Общее соединение БД, публикуемое connection-режимом `ormModule({ provider })`. */
export const DATABASE_PROVIDER = createToken<DatabaseProvider>("DatabaseProvider");
