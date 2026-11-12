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
  /**
   * A business reason the caller can act on, such as `card_declined`: it comes
   * back as `error.details.reason`. A process routes it to an error boundary
   * and does not retry it (WORKFLOW-001).
   */
  readonly reason?: string;

  constructor(message: string, options: { readonly reason?: string } = {}) {
    super(message);
    this.name = "ToolError";
    if (options.reason !== undefined) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(options.reason)) throw new TypeError("ToolError reason must match ^[A-Za-z][A-Za-z0-9_.-]{0,63}$");
      this.reason = options.reason;
    }
  }
}

/**
 * Explicit assertion by a tool that execution failed before any side effect
 * could commit. Only this typed error keeps write/external failures eligible
 * for an idempotency-gated retry. Its message reaches the model like a ToolError.
 */
export class AgentToolPreCommitError extends ToolError {
  constructor(message: string, options: { readonly reason?: string } = {}) {
    super(message, options);
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

/**
 * A model provider could not serve the request right now: it is overloaded,
 * limits the rate (HTTP 429), answered 5xx or the connection broke. The runtime
 * repeats such a call (`AgentRuntimeOptions.modelRetry`); any other provider
 * error fails the run at once.
 */
export class AgentModelUnavailableError extends Error {
  /** How long the provider asked to wait (`Retry-After`), when it said so. */
  readonly retryAfterMs?: number;

  constructor(message: string, options: { readonly retryAfterMs?: number } = {}) {
    super(message);
    this.name = "AgentModelUnavailableError";
    if (options.retryAfterMs !== undefined && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0) {
      this.retryAfterMs = Math.floor(options.retryAfterMs);
    }
  }
}

/** Error thrown when the agent runtime is configured incorrectly. */
export class AgentRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}
