import type { ServiceDefinition } from "./serviceDefinition";
import { GrpcSetupError } from "./GrpcSetupError";
import type { Class } from "../di";
import type { GrpcControllerDefinition } from "./contracts";
import type { RequestModelClass } from "../http/Binding/requestModelRegistry";

(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");
const GRPC_META = Symbol("bazis:grpc:controller");

interface ControllerMetadata {
  service?: ServiceDefinition;
  methods: Map<string | symbol, string>;
  requestModels: Map<string | symbol, RequestModelClass>;
  /** Declaration problems, reported by grpcControllerDefinition at start. */
  problems: string[];
}
interface Carrier { [GRPC_META]?: ControllerMetadata }

function ownMetadata(metadata: object): ControllerMetadata {
  const carrier = metadata as Carrier;
  if (!Object.hasOwn(carrier, GRPC_META)) {
    const parent = carrier[GRPC_META];
    carrier[GRPC_META] = {
      service: parent?.service,
      methods: new Map(parent?.methods),
      requestModels: new Map(parent?.requestModels),
      problems: [...(parent?.problems ?? [])],
    };
  }
  return carrier[GRPC_META]!;
}

/** Bind a controller to a generated codec definition or grpcService(). */
export function GrpcController(service: ServiceDefinition) {
  return (_value: Class<object>, context: ClassDecoratorContext): void => {
    const meta = ownMetadata(context.metadata);
    if (!service || typeof service !== "object" || Object.keys(service).length === 0) {
      meta.problems.push("@GrpcController requires a non-empty gRPC service definition.");
      return;
    }
    const snapshot: Record<string, ServiceDefinition[string]> = Object.create(null);
    for (const [name, method] of Object.entries(service)) {
      if (!method || typeof method.path !== "string" || !/^\/[^/]+\/[^/]+$/.test(method.path)
        || typeof method.requestStream !== "boolean" || typeof method.responseStream !== "boolean"
        || typeof method.requestDeserialize !== "function" || typeof method.responseSerialize !== "function") {
        meta.problems.push(`invalid gRPC service method: ${name}.`);
        return;
      }
      snapshot[name] = Object.freeze({ ...method });
    }
    meta.service = Object.freeze(snapshot);
  };
}

/** Request/response values for unary; AsyncIterable values for streaming sides. */
export function GrpcMethod(rpcName?: string, requestModel?: RequestModelClass) {
  return (_value: unknown, context: ClassMethodDecoratorContext): void => {
    const meta = ownMetadata(context.metadata);
    // Problems are reported when the controller is registered, not at import.
    const method = String(context.name);
    if (requestModel !== undefined && (typeof requestModel !== "function" || !requestModel.prototype)) {
      meta.problems.push(`${method}: gRPC requestModel must be a DTO class.`);
      return;
    }
    if (context.static || context.private) {
      meta.problems.push(`${method}: @GrpcMethod requires a public instance method.`);
      return;
    }
    const name = rpcName ?? (typeof context.name === "string" ? context.name : "");
    if (typeof name !== "string" || name.trim().length === 0) {
      meta.problems.push(`${method}: gRPC method name must not be empty.`);
      return;
    }
    meta.methods.set(context.name, name);
    // A redecorated override must not silently retain the base method's DTO.
    if (requestModel === undefined) meta.requestModels.delete(context.name);
    else meta.requestModels.set(context.name, requestModel);
  };
}

/** @internal Resolve aliases and reject contract mismatches before opening a port. */
export function grpcControllerDefinition(controller: Class<object>): GrpcControllerDefinition {
  const carrier = (controller as unknown as { [Symbol.metadata]?: Carrier })[Symbol.metadata];
  const meta = carrier?.[GRPC_META];
  const problem = meta?.problems[0];
  if (problem !== undefined) throw new GrpcSetupError(`${controller.name}: ${problem}`);
  if (!meta?.service) throw new GrpcSetupError(`${controller.name} must use @GrpcController().`);
  const methods = new Map<string, string | symbol>();
  for (const [methodName, rpcName] of meta.methods) {
    const keys = Object.keys(meta.service).filter((key) => {
      const rpc = meta.service![key]!;
      return key === rpcName || rpc.originalName === rpcName || rpc.path.split("/").at(-1) === rpcName;
    });
    if (keys.length !== 1) throw new GrpcSetupError(`${controller.name}.${String(methodName)}: unknown or ambiguous RPC ${rpcName}.`);
    const key = keys[0]!;
    if (methods.has(key)) throw new GrpcSetupError(`${controller.name}: duplicate RPC ${rpcName}.`);
    if (typeof controller.prototype[methodName] !== "function") throw new GrpcSetupError(`Missing RPC handler ${String(methodName)}.`);
    methods.set(key, methodName);
  }
  for (const key of Object.keys(meta.service)) {
    if (!methods.has(key)) throw new GrpcSetupError(`${controller.name}: RPC ${key} is missing @GrpcMethod().`);
  }
  return Object.freeze({ controller, service: meta.service, methods, requestModels: new Map(meta.requestModels) });
}
