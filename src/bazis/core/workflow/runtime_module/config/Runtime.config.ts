import { defineConfig } from "../../../kernel";

/**
 * Settings of the workflow background services (WORKFLOW-001 §4), from the
 * application configuration: `BAZIS_WORKFLOW__WORKER__ENABLED=false` keeps an
 * instance from running jobs, for example a web-only one.
 */
export const workflowRuntimeConfig = defineConfig("workflow", {
  default: {
    "worker.enabled": true,
    "worker.intervalMs": 1000,
    "worker.batchSize": 10,
    "retention.enabled": true,
    "retention.intervalMs": 3_600_000,
    "retention.batchSize": 500,
  },
  validate: {
    "worker.intervalMs": (value) => positive(value, 3_600_000),
    "worker.batchSize": (value) => positive(value, 1000),
    "retention.intervalMs": (value) => positive(value, 86_400_000),
    "retention.batchSize": (value) => positive(value, 10_000),
  },
});

function positive(value: unknown, max: number): string | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max ? undefined : `must be an integer 1–${max}`;
}
