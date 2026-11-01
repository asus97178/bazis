import { defineConfig } from "../../kernel";

/**
 * Settings of the workflow pack, from the application configuration:
 * `BAZIS_WORKFLOW__WORKER__ENABLED=false` keeps an instance from running jobs,
 * for example a web-only one (WORKFLOW-001 §4). `language` is the default
 * language of texts, `languages` the comma-separated list a request may ask for
 * with `Accept-Language` (WORKFLOW-002 §6).
 */
export interface WorkflowSettings {
  readonly language: string;
  readonly languages: string;
  readonly "worker.enabled": boolean;
  readonly "worker.intervalMs": number;
  readonly "worker.batchSize": number;
  readonly "retention.enabled": boolean;
  readonly "retention.intervalMs": number;
  readonly "retention.batchSize": number;
}

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const workflowConfig = defineConfig<WorkflowSettings>("workflow", {
  default: {
    language: "en",
    languages: "en",
    "worker.enabled": true,
    "worker.intervalMs": 1000,
    "worker.batchSize": 10,
    "retention.enabled": true,
    "retention.intervalMs": 3_600_000,
    "retention.batchSize": 500,
  },
  validate: {
    language: (value) => (LANGUAGE.test(value) ? undefined : "must be a language: en, ru, pt-BR"),
    languages: (value) => (value.split(",").every((item) => LANGUAGE.test(item.trim())) ? undefined : "must be a comma-separated list of languages"),
    "worker.intervalMs": (value) => positive(value, 3_600_000),
    "worker.batchSize": (value) => positive(value, 1000),
    "retention.intervalMs": (value) => positive(value, 86_400_000),
    "retention.batchSize": (value) => positive(value, 10_000),
  },
});

function positive(value: unknown, max: number): string | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max ? undefined : `must be an integer 1–${max}`;
}
