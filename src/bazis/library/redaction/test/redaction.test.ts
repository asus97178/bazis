import { describe, expect, test } from "bun:test";
import { redactSensitive, redactSensitiveText, rememberSecretValue } from "@/library/redaction";

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

  test("an object reached twice without a cycle is printed both times", () => {
    // ORM schema differences share one { kind: "absent" } descriptor; the
    // startup error printed the second one as "[Circular]".
    const absent = { kind: "absent" };
    const shared = [{ expected: absent, actual: { kind: "present" } }, { expected: absent, actual: absent }];
    const error = Object.assign(new Error("schema"), { differences: shared });

    expect(redactSensitive(shared)).toEqual([
      { expected: { kind: "absent" }, actual: { kind: "present" } },
      { expected: { kind: "absent" }, actual: { kind: "absent" } },
    ]);
    expect((redactSensitive(error) as unknown as { differences: unknown }).differences).toEqual(redactSensitive(shared));
  });
});

// 0.118.0: redaction knew secrets only by shape (key names, password=, Bearer,
// URL userinfo). A revealed secret pasted into plain text reached the logs.
describe("known secret values", () => {
  test("a remembered value is removed wherever it appears", () => {
    rememberSecretValue("sk-live-4f9a7c2e1b8d");
    expect(redactSensitiveText("calling the API with sk-live-4f9a7c2e1b8d failed")).toBe("calling the API with *** failed");
    expect(redactSensitive({ note: "key=sk-live-4f9a7c2e1b8d;" })).toEqual({ note: "key=***;" });
    expect(redactSensitiveText("sk-live-4f9a7c2e1b8d", { replacement: "[hidden]" })).toBe("[hidden]");
  });
  test("a value shorter than 10 characters is not remembered: it would mask ordinary words", () => {
    rememberSecretValue("postgres");
    expect(redactSensitiveText("postgres://db:5432/app")).toBe("postgres://db:5432/app");
  });
  test("a longer value wins over its own prefix", () => {
    rememberSecretValue("abcdefghij");
    rememberSecretValue("abcdefghij-0123456789");
    expect(redactSensitiveText("token abcdefghij-0123456789 end")).toBe("token *** end");
  });
});

describe("known secret values in connection URLs", () => {
  test("a URL with credentials keeps its server; its password is remembered", () => {
    rememberSecretValue("redis://app:Very-Long-Pass-42@cache.internal:6379");
    expect(redactSensitiveText("failed to connect to redis://app:Very-Long-Pass-42@cache.internal:6379")).toBe("failed to connect to redis://***:***@cache.internal:6379");
    expect(redactSensitiveText("AUTH Very-Long-Pass-42")).toBe("AUTH ***");
  });
});
