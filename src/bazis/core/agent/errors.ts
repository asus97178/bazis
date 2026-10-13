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
 * A failure a tool reports to the model on purpose: the message reaches the
 * model as written, so the model can explain it or try another way. Any other
 * exception from `execute` reaches the model as "Tool execution failed." and
 * goes to the application log with its stack.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Explicit assertion by a tool that execution failed before any side effect
 * could commit. Only this typed error keeps write/external failures eligible
 * for an idempotency-gated retry. Its message reaches the model like a ToolError.
 */
export class AgentToolPreCommitError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolPreCommitError";
  }
}

/**
 * A model provider gave up on a request after its own deadline (for example
 * the connector's `timeoutMs`). The run reports it as AGENT_PROVIDER_TIMEOUT.
 */
export class AgentModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelTimeoutError";
  }
}

/** Error thrown when the agent runtime is configured incorrectly. */
export class AgentRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}
