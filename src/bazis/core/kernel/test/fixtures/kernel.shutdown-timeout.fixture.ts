import { DI, HOSTED_SERVICE, type HostedService } from "../../../di";
import { APPLICATION_STARTED, ApplicationLifetime, Bazis, onEvent } from "../../index";

const mode = Bun.argv[2];
if (!["started-failure", "rollback-failure", "normal-stop"].includes(mode ?? "")) throw new Error("Unknown kernel fixture mode");
const root = { providers: [
  // Explicit factory dependency: this test fixture is not a codegen-owned class.
  DI.singleton(DI.factoryProvider(HOSTED_SERVICE, [ApplicationLifetime] as const, lifetime => ({
    start() {
      setInterval(() => {}, 1000);
      if (mode === "normal-stop") setTimeout(() => lifetime.stop(0), 0);
    },
    stop() { return new Promise<void>(() => {}); },
  } satisfies HostedService))),
  ...(mode === "rollback-failure" ? [DI.singleton(DI.valueProvider(HOSTED_SERVICE, {
    start() { throw new Error("audit hosted failure"); }, stop() {},
  } satisfies HostedService))] : []),
  onEvent(APPLICATION_STARTED, () => { if (mode === "started-failure") throw new Error("audit started failure"); }),
] };
const code = await Bazis.run(root, { environment: "test", startupReport: false, signals: [], unhandledErrorPolicy: "none", startupTimeoutMs: 500, shutdownTimeoutMs: 20 });
console.log(`FACADE_RETURNED:${code}`);
