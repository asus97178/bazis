import { Metadata } from "./Metadata";
import { GrpcStatus as status } from "./GrpcStatus";

/** An intentional, public RPC error. Other exceptions are redacted to INTERNAL. */
export class GrpcError extends Error {
  constructor(
    readonly code: status,
    message: string,
    readonly metadata?: Metadata,
  ) {
    super(message);
    this.name = "GrpcError";
    if (!Number.isInteger(code) || code <= status.OK || code > status.UNAUTHENTICATED) {
      throw new TypeError("GrpcError requires a non-OK gRPC status code.");
    }
    if (typeof message !== "string") throw new TypeError("GrpcError message must be a string.");
    if (metadata !== undefined && !(metadata instanceof Metadata)) throw new TypeError("GrpcError metadata must be Bazis Metadata.");
  }
}
