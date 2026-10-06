import type { EnvironmentName } from "../types";
import { createEventToken } from "./EventToken";

export interface ApplicationStartedEvent {
  readonly environment: EnvironmentName;
  /** Total time from build start to fully started, in milliseconds. */
  readonly startupMs: number;
}

export interface ApplicationStoppingEvent {
  readonly signal?: string;
  readonly exitCode: number;
}

export const APPLICATION_STARTED = createEventToken<ApplicationStartedEvent>("bazis.application.started");
export const APPLICATION_STOPPING = createEventToken<ApplicationStoppingEvent>("bazis.application.stopping");
