/** A codec contract, compatible structurally with generated protobuf services. */
export interface MethodDefinition<Request = any, Response = any> {
  readonly path: string;
  readonly requestStream: boolean;
  readonly responseStream: boolean;
  readonly requestSerialize: (value: Request) => Buffer;
  readonly requestDeserialize: (buffer: Buffer) => Request;
  readonly responseSerialize: (value: Response) => Buffer;
  readonly responseDeserialize: (buffer: Buffer) => Response;
  readonly originalName?: string;
}
export type ServiceDefinition = Record<string, MethodDefinition>;
export type PackageDefinition = Record<string, ServiceDefinition | { readonly format: string }>;

/** Supported transport controls. Unknown controls fail before opening a port. */
export interface ServerOptions {
  readonly "grpc.max_receive_message_length"?: number;
  readonly "grpc.max_send_message_length"?: number;
  readonly "grpc.max_concurrent_streams"?: number;
}
