export { ApplicationLifetime } from "./ApplicationLifetime";
export { Environment } from "./Environment";
export { Kernel, type KernelRuntimeOptions, type KernelTimings } from "./Kernel";
export { KernelBuilder, type RootModuleInput } from "./KernelBuilder";
export { LifecycleCoordinator } from "./LifecycleCoordinator";
export { Bazis } from "./Bazis";
export { SupervisedHostedService, supervised, type RestartPolicy } from "./SupervisedHostedService";
export { LIFECYCLE_HOOK, addLifecycleHook } from "./lifecycleHooks";
export { LOGGER, type LogFields, type LogLevel, type Logger } from "./logging/Logger";
export { ConsoleLogger, type ConsoleLoggerOptions } from "./logging/ConsoleLogger";

export { Configuration, loadConfiguration } from "./config/Configuration";
export { ConfigRegistry } from "./config/ConfigRegistry";
export { Secret } from "./config/Secret";
export {
  defineConfig,
  configEnum,
  secret,
  type AppConfig,
  type ConfigDefinition,
  type ConfigView,
  type ConfigInspection,
  type ConfigEnum,
  type ConfigSchema,
  type ConfigShape,
  type ConfigValueType,
  type SchemaFor,
  type SecretSpec,
  type ValidatableConfig,
} from "./config/defineConfig";
export { addConfigOptions, configOptions, type ConfigOptionsBinding } from "./config/addConfigOptions";
export { argsSource, envSource, jsonFileSource, memorySource } from "./config/sources";

export {
  EVENT_HANDLER,
  EventBus,
  EventHandlerTimeoutError,
  type EventSubscription,
  type PublishErrorContext,
  type PublishOptions,
} from "./events/EventBus";
export { createEventToken, type EventHandler, type EventToken } from "./events/EventToken";
export {
  OnEvent,
  eventSubscriptionsOf,
  eventsModule,
  withEventSubscribers,
  type EventsModuleConfig,
  type OnEventOptions,
} from "./events/eventSubscribers";
export {
  APPLICATION_STARTED,
  APPLICATION_STOPPING,
  type ApplicationStartedEvent,
  type ApplicationStoppingEvent,
} from "./events/kernelEvents";
export { addEventHandler, onEvent, type SubscribeOptions } from "./events/onEvent";

export {
  HEALTH_CHECK,
  addHealthCheck,
  type HealthCheck,
  type HealthCheckOptions,
  type HealthCheckResult,
  type HealthReport,
  type HealthReportEntry,
} from "./health/HealthCheckContracts";
export { HealthService } from "./health/HealthService";

export {
  REQUEST_ID_HEADER,
  REQUEST_ID_STATE_KEY,
  TRACEPARENT_HEADER,
  TRACEPARENT_STATE_KEY,
  getOutboundCorrelationHeaders,
  getRequestId,
  getTraceparent,
  runWithRequestContext,
  runWithRequestContextAsync,
  type RequestLogContext,
} from "./correlation/requestContext";

export {
  ConfigKeyMissingError,
  KernelError,
  ShutdownTimeoutError,
  StartupAbortedError,
  StartupTimeoutError,
} from "./errors";
export type {
  ConfigSource,
  EnvironmentName,
  KernelOptions,
  LifecycleHook,
  UnhandledErrorPolicy,
} from "./types";
