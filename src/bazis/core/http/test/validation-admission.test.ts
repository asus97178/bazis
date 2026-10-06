import { registerGeneratedBindings } from "../Binding/autoBindings";
import { describe, expect, spyOn, test } from "bun:test";
import { Validator, modelValidatorAdapter } from "../../../library/validation";
import { Middleware } from "../Decorators/attributes";
import { Controller } from "../Decorators/controller";
import { Post } from "../Decorators/routes";
import { HttpContext } from "../HttpContext/HttpContext";
import { errorHandler } from "../Middleware/errorHandler";
import { runPipeline } from "../Middleware/pipeline";
import { rateLimit } from "../Middleware/rateLimit";
import { RouterBuilder } from "../Routing/RouterBuilder";

describe("HTTP validation admission", () => {
  test("oversized input keeps the public 400 error contract without evaluating pattern", async () => {
    const pattern = /^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/;
    const check = spyOn(pattern, "test");
    class LoginInput {
      @Validator({ required: true, maxLength: 120, pattern })
      email = "";
    }

    @Controller("validation-admission")
    class LoginController {
      @Post()
      login(_input: LoginInput): void {
        throw new Error("invalid input must not reach controller");
      }
    }
// Unit fixture for the generated registry; real inference is covered by codegen-dx.integration.test.ts.
registerGeneratedBindings(LoginController, {
  login: [{source: "body", model: "LoginInput"}],
}, new Map([["LoginInput", LoginInput]]));

    const router = new RouterBuilder([errorHandler()], undefined, undefined).build([LoginController]);
    const match = router.match("POST", ["validation-admission"]);
    if (match.kind !== "matched") throw new Error("test route did not match");
    const email = "a@" + ".".repeat(2_000) + "@";
    const request = new Request("http://localhost/validation-admission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const ctx = new HttpContext(request, new URL(request.url), {}, {} as never, undefined, undefined, "127.0.0.1", modelValidatorAdapter);
    try {
      await runPipeline(match.action.chain, ctx);
      expect(check).not.toHaveBeenCalled();
      expect(ctx.response?.status).toBe(400);
      expect(ctx.response?.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const body = await ctx.response!.json();
      expect(body).toEqual({
        error: "Validation failed",
        details: [{ property: "email", message: 'Field "email" must be at most 120 characters long', code: "maxLength" }],
      });
      expect(JSON.stringify(body)).not.toContain(email);
    } finally {
      check.mockRestore();
    }
  });

  test("controller rateLimit counts rejected DTOs and refuses excess requests before reading body", async () => {
    let validations = 0;
    class LoginInput {
      @Validator({ custom: () => { validations++; return false; } })
      email = "";
    }

    @Controller("limited-validation")
    @Middleware(rateLimit({ windowMs: 60_000, max: 1 }))
    class LoginController {
      @Post()
      login(_input: LoginInput): void {
        throw new Error("invalid input must not reach controller");
      }
    }
registerGeneratedBindings(LoginController, {
  login: [{source: "body", model: "LoginInput"}],
}, new Map([["LoginInput", LoginInput]]));

    const router = new RouterBuilder([errorHandler()], undefined, undefined).build([LoginController]);
    const match = router.match("POST", ["limited-validation"]);
    if (match.kind !== "matched") throw new Error("test route did not match");
    const send = async (body: string, forwarded: string) => {
      const request = new Request("http://localhost/limited-validation", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
        body,
      });
      const ctx = new HttpContext(request, new URL(request.url), {}, {} as never, undefined, undefined, "127.0.0.1", modelValidatorAdapter);
      await runPipeline(match.action.chain, ctx);
      return ctx;
    };

    const admitted = await send('{"email":"invalid"}', "198.51.100.1");
    expect(admitted.response?.status).toBe(400);
    expect(validations).toBe(1);
    const denied = await send("invalid JSON must not be read", "198.51.100.2");
    expect(denied.response?.status).toBe(429);
    expect(Number(denied.response?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await denied.response!.json()).toEqual({ error: "Too Many Requests" });
    expect(denied.request.bodyUsed).toBe(false);
    expect(validations).toBe(1);
  });
});
