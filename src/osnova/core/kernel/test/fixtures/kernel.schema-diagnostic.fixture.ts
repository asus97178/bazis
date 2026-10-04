import { DI, HOSTED_SERVICE, type HostedService } from "../../../di";
import { SchemaMigrationRequiredError } from "../../../../library/orm";
import { Osnova } from "../../index";

// Synthetic startup rejection: exercises stderr and exit handling without a database.
const error = new SchemaMigrationRequiredError({ compatible: false, differences: [{
  code: "column.unexpected", schema: "public", table: "dm_table", objectName: "osnova_drill_unexpected",
  expected: { kind: "absent" }, actual: { kind: "present" },
}] });
Object.assign(error, { password: "fixture-password-must-stay-private", revision: 12n, self: error });
await Osnova.run({ providers: [DI.singleton(DI.valueProvider(HOSTED_SERVICE, {
  start() { throw error; }, stop() {},
} satisfies HostedService))] }, {
  environment: "test", startupReport: false, signals: [], unhandledErrorPolicy: "none",
});
