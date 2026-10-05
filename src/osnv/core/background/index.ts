/**
 * Background services: long-running and periodic in-process workers integrated
 * with the kernel lifecycle (non-blocking start, cooperative cancellation,
 * graceful stop, optional restart-on-crash).
 */
export {
  BackgroundService,
  PeriodicBackgroundService,
  type BackgroundRestartPolicy,
  type BackgroundServiceOptions,
  type PeriodicBackgroundServiceOptions,
} from "./BackgroundService";
export { backgroundModule, type BackgroundModuleConfig } from "./backgroundModule";
export { Background, backgroundOptionsOf, type BackgroundDecoratorOptions } from "./decorator";
export { delay } from "./delay";
