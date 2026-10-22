import { KernelError } from "../kernel/errors";

/**
 * A gRPC controller that cannot be served as declared (an RPC without
 * @GrpcMethod, a duplicate RPC). A configuration error of the code: the start
 * prints it as one line and exits with code 1.
 */
export class GrpcSetupError extends KernelError {}
