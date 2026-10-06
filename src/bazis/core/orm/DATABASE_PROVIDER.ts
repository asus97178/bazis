import { createToken } from "../di";
import type { DatabaseProvider } from "../../library/orm";

/** Shared database connection published by the connection mode of `ormModule({ provider })`. */
export const DATABASE_PROVIDER = createToken<DatabaseProvider>("DatabaseProvider");
