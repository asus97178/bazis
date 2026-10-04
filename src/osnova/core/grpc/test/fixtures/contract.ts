import protoPath from "./echo.proto" with { type: "file" };
import { grpcService, loadGrpcPackage } from "../../index";

export const echoService = grpcService(loadGrpcPackage(protoPath, { defaults: true }), "osnova.test.Echo");
export { echoClient, type EchoMessage } from "./nativeClient";
