/** Error thrown while declaring or discovering Bazis agent metadata. */
export class AgentSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSetupError";
  }
}

/** Error thrown when provider-neutral agent semantic objects are invalid. */
export class AgentSemanticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSemanticError";
  }
}

/** Error thrown when an agent tool executor is configured incorrectly. */
export class AgentToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolExecutionError";
  }
}

/**
 * Explicit assertion by a tool that execution failed before any side effect
 * could commit. Only this typed error keeps write/external failures eligible
 * for an idempotency-gated retry.
 */
export class AgentToolPreCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolPreCommitError";
  }
}

/** Error thrown when the agent runtime is configured incorrectly. */
export class AgentRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}
