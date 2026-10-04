import { DI, HOSTED_SERVICE } from "../../../di";
import { KernelBuilder } from "../../KernelBuilder";

const mode = process.argv[2];
const signals: NodeJS.Signals[] = mode === "single" ? ["SIGUSR2"] : ["SIGUSR2", "SIGUSR2"];
const kernel = await new KernelBuilder({ providers: [DI.singleton(DI.valueProvider(HOSTED_SERVICE, {
  start() { console.log("STARTED"); },
  async stop() {
    console.log("STOP_ENTER");
    if (mode === "second") {
      setTimeout(() => process.emit("SIGUSR2"), 5);
      await new Promise<void>(() => {});
    }
    console.log("STOPPED");
  },
}))] }).useOptions({ environment: "test", startupReport: false, signals, shutdownTimeoutMs: 200 }).build();
if (mode === "mutated") signals.splice(0, signals.length, "SIGUSR1");
kernel.lifetime.onStarted(() => { setTimeout(() => process.emit("SIGUSR2"), 5); });
const guard = setTimeout(() => process.exit(2), 1000);
try { console.log("RETURNED", await kernel.run()); }
finally { clearTimeout(guard); }
