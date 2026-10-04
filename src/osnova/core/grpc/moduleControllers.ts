import {
  createModuleOwnedProviderChannel, registerModuleOwnedProviderContributor, scoped,
  type Class, type OsnovaModuleRef,
} from "../di";
import type { GrpcControllerDefinition } from "./contracts";
import { grpcControllerDefinition } from "./decorators";

declare module "../di/module/types/OsnovaModule" {
  interface OsnovaModuleMetadata {
    /** gRPC controllers, automatically scoped to one RPC by core/grpc. */
    readonly grpcControllers?: readonly Class<object>[];
  }
}

export const GRPC_CONTROLLERS = createModuleOwnedProviderChannel<GrpcControllerDefinition, object>("gRPC controllers");

registerModuleOwnedProviderContributor((metadata, context) => {
  const seen = new Set<Class<object>>();
  for (const controller of metadata.grpcControllers ?? []) {
    if (seen.has(controller)) continue;
    seen.add(controller);
    context.addScoped(GRPC_CONTROLLERS, scoped(controller), grpcControllerDefinition(controller));
  }
});

/** @internal Discover only the feature tree published by this transport. */
export function collectGrpcControllers(roots: readonly OsnovaModuleRef[], extra: readonly Class<object>[] = []): Set<Class<object>> {
  const result = new Set(extra);
  const visited = new Set<OsnovaModuleRef>();
  const visit = (module: OsnovaModuleRef): void => {
    if (visited.has(module)) return;
    visited.add(module);
    for (const child of module.imports ?? []) visit(child);
    for (const controller of module.grpcControllers ?? []) result.add(controller);
  };
  for (const root of roots) visit(root);
  return result;
}
