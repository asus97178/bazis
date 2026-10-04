import { expect, test } from "bun:test";
import { serverCancellationCases } from "./fixtures/serverCancellationQualification";

const enabled = process.env.OSNOVA_ORM_SERVER_CANCELLATION_LIVE === "owned-disposable-v1";
if (!enabled) test.skip("Server cancellation qualification requires its owned disposable runner", () => {});
else for (const scenario of serverCancellationCases()) test(scenario.name, async () => {
  const result = await scenario.run();
  console.log(JSON.stringify({ qualification: "orm-server-cancellation", ...result }));
  expect(result.assertions).toBeGreaterThan(0);
}, 30000);
