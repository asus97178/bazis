import { Module } from "../../../di";
import { App, runApp } from "../../../app/runApp";
import { GrpcController, GrpcMethod } from "../../index";
import { echoService, type EchoMessage } from "./contract";

// Echo has four RPCs; this controller maps one.
@GrpcController(echoService)
class HalfEchoController {
  @GrpcMethod("Echo")
  echo(request: EchoMessage) { return request; }
}

@Module({ grpcControllers: [HalfEchoController] })
class AppModule {}

@App({ modules: [AppModule], grpc: { address: "127.0.0.1:0" }, kernel: { environment: "development", signals: [] } })
class Application {}
await runApp(Application);
