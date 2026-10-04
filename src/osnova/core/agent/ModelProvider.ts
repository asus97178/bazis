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
}

export const AGENT_MODEL_PROVIDER = createToken<AgentModelProvider>("AgentModelProvider");
