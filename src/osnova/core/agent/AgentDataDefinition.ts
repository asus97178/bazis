/** Serializable behaviour; executable tools remain an explicit host capability. */
export interface AgentDataDefinition {
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  readonly toolNames?: readonly string[];
  readonly modelProfile?: string;
}
