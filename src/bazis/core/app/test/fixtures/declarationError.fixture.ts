import { createToken, Module, type BazisModuleRef } from "../../../di";
import { GrpcController, GrpcMethod } from "../../../grpc";
import { echoService, type EchoMessage } from "../../../grpc/test/fixtures/contract";
import { Infra, llmRouter } from "../../../infra";
import { configEnum, defineConfig } from "../../../kernel";
import "../../../orm";
import { runApp } from "../../runApp";

// Each case declares something invalid while the module file is evaluated,
// the way an application's own files do at import.
let app: BazisModuleRef;
switch (process.argv[2]) {
  case "infra": {
    @Infra({ " db": { token: createToken<object>("db"), create: () => ({}), connect() {}, dispose() {} } })
    class AppInfra {}
    app = AppInfra;
    break;
  }
  case "llm-router": {
    @Infra({ llm: llmRouter({}) })
    class AppInfra {}
    app = AppInfra;
    break;
  }
  case "config-env": {
    const mail = defineConfig("mail", { default: { host: "localhost" }, env: { host: "SMTP_HOST" } });
    @Module({ config: [mail] })
    class AppModule {}
    app = AppModule;
    break;
  }
  case "config-enum": {
    const log = defineConfig("log", { default: { level: configEnum(["debug", "info"], "trace" as "info") } });
    @Module({ config: [log] })
    class AppModule {}
    app = AppModule;
    break;
  }
  case "grpc": {
    @GrpcController(echoService)
    class EchoController {
      @GrpcMethod("Echo", null as never)
      echo(request: EchoMessage) { return request; }
    }
    @Module({ grpcControllers: [EchoController] })
    class AppModule {}
    app = AppModule;
    break;
  }
  case "orm": {
    @Module({ ormBazis: { ensureCreated: true, migrateOnStart: true } } as never)
    class AppModule {}
    app = AppModule;
    break;
  }
  default:
    throw new Error(`unknown case ${process.argv[2]}`);
}

await runApp(app, { grpc: { address: "127.0.0.1:0" }, kernel: { environment: "development", signals: [] } });
