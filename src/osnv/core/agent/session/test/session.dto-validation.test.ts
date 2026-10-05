import { describe, expect, test } from "bun:test";
import { Validator } from "@/library/validation";
import { CreateAgentSessionRequestV1, ReadAgentSessionEventsRequestV1, ReadAgentSessionRequestV1, ResumeAgentSessionRequestV1, RunAgentSessionRequestV1, StopAgentSessionRequestV1 } from "../contracts";

const id = "11111111-1111-4111-8111-111111111111";
describe("Session v1 DTO validation", () => {
  test("accepts declared DTO instances", async () => {
    const request = Object.assign(new CreateAgentSessionRequestV1(), { sessionId: id, requestId: id, agentName: "catalog", input: { question: "остаток" }, maxSteps: 8, maxToolCallsPerStep: 8, runTimeoutMs: 300000 });
    expect((await Validator.validateAsync(request)).isValid).toBe(true);
  });
  test("accepts null as JsonValue input but rejects absent and non-JSON input", async () => {
    const base = { sessionId: id, requestId: id, agentName: "catalog" };
    expect((await Validator.validateAsync(Object.assign(new CreateAgentSessionRequestV1(), { ...base, input: null }))).isValid).toBe(true);
    expect((await Validator.validateAsync(Object.assign(new CreateAgentSessionRequestV1(), base))).isValid).toBe(false);
    expect((await Validator.validateAsync(Object.assign(new CreateAgentSessionRequestV1(), { ...base, input: new Date() }))).isValid).toBe(false);
  });
  test("rejects missing identifiers and invalid numeric overrides", async () => {
    const request = Object.assign(new CreateAgentSessionRequestV1(), { sessionId: "no", requestId: id, agentName: "", input: {}, maxSteps: 0 });
    expect((await Validator.validateAsync(request)).isValid).toBe(false);
    expect((await Validator.validateAsync(Object.assign(new RunAgentSessionRequestV1(), { sessionId: id, commandId: "x" }))).isValid).toBe(false);
  });
  test("applies one strict UUID pattern and integer limits to every DTO", async () => {
    const malformed = "11111111-1111-4111-7111-111111111111";
    const requests = [
      Object.assign(new CreateAgentSessionRequestV1(), { sessionId: malformed, requestId: malformed, agentName: "catalog", input: null, maxSteps: 1.5, maxToolCallsPerStep: 1.5, runTimeoutMs: 1.5 }),
      Object.assign(new RunAgentSessionRequestV1(), { sessionId: malformed, commandId: malformed }),
      Object.assign(new ReadAgentSessionRequestV1(), { sessionId: malformed }),
      Object.assign(new StopAgentSessionRequestV1(), { sessionId: malformed, commandId: malformed }),
      Object.assign(new ResumeAgentSessionRequestV1(), { sessionId: malformed, commandId: malformed }),
      Object.assign(new ReadAgentSessionEventsRequestV1(), { sessionId: malformed, limit: 1.5 }),
    ];
    for (const request of requests) expect((await Validator.validateAsync(request)).isValid).toBe(false);
  });
});
