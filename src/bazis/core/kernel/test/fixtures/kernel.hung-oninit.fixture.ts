import { DI } from "../../../di";
import { Bazis, LIFECYCLE_HOOK, type LifecycleHook } from "../../index";

// An onInit that never settles: the start can only fail by timeout or signal.
class HungWarmUp implements LifecycleHook {
  onInit() { return new Promise<void>(() => {}); }
}

const mode = Bun.argv[2];
if (mode !== "timeout" && mode !== "signal") throw new Error("Unknown fixture mode");
const root = { providers: [DI.singleton(DI.valueProvider(LIFECYCLE_HOOK, new HungWarmUp()))] };
if (mode === "signal") setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
await Bazis.run(root, {
  environment: "test",
  startupReport: false,
  unhandledErrorPolicy: "none",
  signals: mode === "signal" ? ["SIGTERM"] : [],
  startupTimeoutMs: mode === "timeout" ? 200 : 0,
  shutdownTimeoutMs: 100,
});
console.log("FACADE_RETURNED");
