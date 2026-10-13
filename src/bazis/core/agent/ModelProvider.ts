import { createToken } from "../di";
import type { AgentModelRequest, AgentModelResponse, JsonObject } from "./semantic";

export interface AgentModelProviderContext {
  readonly invocationId: string;
  readonly agentName: string;
  readonly modelProfile?: string;
  readonly metadata: JsonObject;
  readonly signal: AbortSignal;
  /** Optional synchronous observer of provisional text. complete() remains authoritative. */
  readonly onTextDelta?: (text: string) => void;
}

export interface AgentModelProvider {
  complete(
    request: AgentModelRequest,
    context: AgentModelProviderContext,
  ): AgentModelResponse | Promise<AgentModelResponse>;
  /**
   * Model profiles this provider serves, when it routes by profile
   * (`llmRouter`). AgentRuntime rejects an agent naming another profile before
   * the model is called. Without it any profile is passed through.
   */
  modelProfiles?(): readonly string[];
}

export const AGENT_MODEL_PROVIDER = createToken<AgentModelProvider>("AgentModelProvider");
