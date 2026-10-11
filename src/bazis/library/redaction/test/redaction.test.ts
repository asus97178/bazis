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

  test("redacts credentials embedded in URLs", () => {
    expect(redactSensitiveText("connect failed postgres://app:pa55word@db:5432/app")).toBe(
      "connect failed postgres://***:***@db:5432/app",
    );
    expect(redactSensitiveText("clone https://ghp_abcdef123@github.com/x/y.git")).toBe("clone https://***@github.com/x/y.git");
    expect(redactSensitiveText("see https://example.com/a@b and mail ann@example.com")).toBe(
      "see https://example.com/a@b and mail ann@example.com",
    );
    expect(redactSensitive({ dsn: "redis://:s3cret@cache:6379" })).toEqual({ dsn: "redis://***:***@cache:6379" });
    const error = redactSensitive(new Error("SMTP rejected smtp://mailer:live-key@smtp.local")) as { message: string; stack: string };
    expect(error.message).toBe("SMTP rejected smtp://***:***@smtp.local");
    expect(error.stack).not.toContain("live-key");
  });

  test("handles circular objects", () => {
    const value: { self?: unknown; token: string } = { token: "secret" };
    value.self = value;

    expect(redactSensitive(value)).toEqual({ token: "***", self: "[Circular]" });
  });
});
