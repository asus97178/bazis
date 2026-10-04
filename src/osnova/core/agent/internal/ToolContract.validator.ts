import type { Class } from "../../di";
import type { JsonObject, JsonValue } from "../semantic";
import { AgentToolExecutionError } from "../errors";
import { agentModelJson, bindAgentModel } from "./AgentModelBinding";

export interface AgentToolValidationIssue {
  readonly property: string;
  readonly message: string;
  readonly code?: string;
}

export interface AgentToolValidationResult {
  readonly isValid: boolean;
  readonly errors: readonly AgentToolValidationIssue[];
}

export interface AgentToolSchemaValidator {
  validate(instance: object): AgentToolValidationResult | Promise<AgentToolValidationResult>;
}

type ContractResult =
  | { readonly ok: true; readonly value: object }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: JsonObject } };

/** DTO binding and validation only; execution outcomes belong to the executor. */
export class ToolContractValidator {
  public async validate(
    contract: Class<object>, value: unknown, direction: "input" | "output",
    toolName: string, validator?: AgentToolSchemaValidator,
  ): Promise<ContractResult> {
    const details = () => ({ toolName, schema: toolContractName(contract), direction });
    let instance: object;
    try {
      if (direction === "output" && typeof value === "object" && value !== null && !Array.isArray(value)) {
        value = agentModelJson(value, "tool.output");
      }
      instance = bindAgentModel(contract, value);
    } catch (error) {
      return { ok: false, error: {
        code: direction === "input" ? "TOOL_INPUT_INVALID" : "TOOL_OUTPUT_INVALID",
        message: toolErrorMessage(error), details: details(),
      } };
    }
    if (!validator) return { ok: true, value: instance };
    let validation: AgentToolValidationResult;
    try {
      const rawValidation = await validator.validate(instance);
      if (!validationResultIsValid(rawValidation)) throw new AgentToolExecutionError("schema validator returned an invalid result.");
      validation = rawValidation;
    } catch (error) {
      return { ok: false, error: {
        code: "TOOL_SCHEMA_VALIDATION_FAILED",
        message: `Tool ${direction} schema validation failed: ${toolErrorMessage(error)}`,
        details: details(),
      } };
    }
    if (!validation.isValid) return { ok: false, error: {
      code: direction === "input" ? "TOOL_INPUT_VALIDATION_FAILED" : "TOOL_OUTPUT_VALIDATION_FAILED",
      message: `Tool "${toolName}" ${direction} failed schema validation.`,
      details: { ...details(), issues: normalizeValidationIssues(validation.errors) },
    } };
    return { ok: true, value: instance };
  }
}

export function toolContractName(model: Class<object>): string {
  return model.name && model.name.trim().length > 0 ? model.name : "<anonymous class>";
}

export function toolErrorMessage(value: unknown): string {
  try {
    return value instanceof Error && typeof value.message === "string" ? value.message : String(value);
  } catch {
    return "Unknown error.";
  }
}

function normalizeValidationIssues(errors: readonly AgentToolValidationIssue[]): JsonValue {
  const issues: JsonValue[] = [];
  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index] as AgentToolValidationIssue;
    const issue: Record<string, JsonValue> = {
      property: typeof error.property === "string" ? error.property : toolErrorMessage(error.property),
      message: typeof error.message === "string" ? error.message : toolErrorMessage(error.message),
    };
    if (error.code !== undefined) {
      issue.code = toolErrorMessage(error.code);
    }
    issues.push(Object.freeze(issue));
  }
  return Object.freeze(issues);
}

function validationResultIsValid(value: unknown): value is AgentToolValidationResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { isValid?: unknown }).isValid === "boolean" &&
    Array.isArray((value as { errors?: unknown }).errors)
  );
}

