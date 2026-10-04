import { describe, expect, test } from "bun:test";
import { errorHandler } from "../Middleware/errorHandler";
import { BadRequestError, UnauthorizedError } from "../Errors/HttpError";

describe("HTTP error handler", () => {
  test("redacts fallback unexpected-error logs", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
    try {
      const middleware = errorHandler();
      const ctx: { response?: Response } = {};
      const error = Object.assign(new Error("Authorization: Bearer abcdefghijk"), {
        password: "p@ss",
      });

      await middleware(ctx as never, async () => {
        throw error;
      });

      expect(ctx.response?.status).toBe(500);
      expect(lines.join("\n")).toContain("Bearer ***");
      expect(lines.join("\n")).toContain('"password":"***"');
      expect(lines.join("\n")).not.toContain("abcdefghijk");
      expect(lines.join("\n")).not.toContain("p@ss");
    } finally {
      console.error = original;
    }
  });

  test("broken hooks and sinks cannot escape the boundary", async () => {
    const middleware = errorHandler({
      onUnexpectedError: () => { throw new Error("hook failed"); },
      logError: () => { throw new Error("sink failed"); },
    });
    const ctx: { response?: Response } = {};

    await middleware(ctx as never, async () => { throw new Error("route failed"); });

    expect(ctx.response?.status).toBe(500);
    expect(await ctx.response?.json()).toEqual({ error: "Internal Server Error" });
  });

  test("non-serializable HttpError details fall back to a safe 500", async () => {
    const middleware = errorHandler({ logError: () => {} });
    const ctx: { response?: Response } = {};
    const details: Record<string, unknown> = {};
    details.self = details;

    await middleware(ctx as never, async () => { throw new BadRequestError("bad", details); });

    expect(ctx.response?.status).toBe(500);
    expect(await ctx.response?.json()).toEqual({ error: "Internal Server Error" });
  });

  test("Bearer authentication errors advertise the challenge", async () => {
    const middleware = errorHandler();
    const ctx: { response?: Response } = {};
    await middleware(ctx as never, async () => { throw new UnauthorizedError(); });
    expect(ctx.response?.status).toBe(401);
    expect(ctx.response?.headers.get("www-authenticate")).toBe("Bearer");
  });
});
