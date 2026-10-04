import { createGeneratedProviderAttachmentChannel, getGeneratedProviderAttachment } from "../di/module/generatedProviderAttachments";
import type { RequestModelClass } from "../http/Binding/requestModelRegistry";
import type { Class } from "../di";

interface RequestBinding {
  readonly model: RequestModelClass;
  readonly requestStream: boolean;
}
type RequestBindings = Readonly<Record<string, RequestBinding>>;

/** @internal Exact-class metadata; committed/rolled back with the generated target. */
export const GRPC_REQUEST_BINDINGS = createGeneratedProviderAttachmentChannel<RequestBindings>({
  description: "gRPC request DTOs",
  normalize(target, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid gRPC DTO bindings.");
    const snapshot: Record<string, RequestBinding> = Object.create(null);
    for (const [name, binding] of Object.entries(value)) {
      if (!binding || typeof binding.model !== "function" || !binding.model.prototype
        || typeof binding.requestStream !== "boolean" || typeof target.prototype[name] !== "function") {
        throw new TypeError(`Invalid gRPC DTO binding: ${target.name}.${name}.`);
      }
      snapshot[name] = Object.freeze({ model: binding.model, requestStream: binding.requestStream });
    }
    return Object.freeze(snapshot);
  },
  equals(left, right) {
    return Object.keys(left).length === Object.keys(right).length
      && Object.keys(left).every((key) => left[key]!.model === right[key]?.model
        && left[key]!.requestStream === right[key]?.requestStream);
  },
});

export function getGrpcRequestBinding(controller: Class<object>, name: string | symbol): RequestBinding | undefined {
  return typeof name === "string" ? getGeneratedProviderAttachment(GRPC_REQUEST_BINDINGS, controller)?.[name] : undefined;
}
