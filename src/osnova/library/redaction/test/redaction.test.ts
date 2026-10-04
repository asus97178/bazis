import { describe, expect, test } from "bun:test";
import { redactSensitive, redactSensitiveText } from "@/library/redaction";

describe("sensitive redaction", () => {
  test("redacts common secret keys recursively without mutating the source", () => {
    const source = {
      username: "alice",
      password: "p@ss",
      nested: {
        apiKey: "api-secret",
        value: "visible",
      },
      list: [{ refresh_token: "refresh-secret" }],
    };

    const redacted = redactSensitive(source);

    expect(redacted).toEqual({
      username: "alice",
      password: "***",
      nested: {
        apiKey: "***",
        value: "visible",
      },
      list: [{ refresh_token: "***" }],
    });
    expect(source.password).toBe("p@ss");
  });

  test("redacts bearer/basic credentials embedded in text", () => {
    expect(redactSensitiveText("Authorization: Bearer abcdefghijk")).toBe("Authorization: Bearer ***");
    expect(redactSensitiveText("password=super-secret token: abcdefghijk")).toBe("password=*** token: ***");
  });

  test("handles circular objects", () => {
    const value: { self?: unknown; token: string } = { token: "secret" };
    value.self = value;

    expect(redactSensitive(value)).toEqual({ token: "***", self: "[Circular]" });
  });
});
