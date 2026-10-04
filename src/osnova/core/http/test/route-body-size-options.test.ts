import { describe, expect, test } from "bun:test";
import {
  All,
  ApiVersion,
  Controller,
  Get,
  Head,
  Put,
  type RouteOptions,
} from "../index";
import { controllerMetaOf } from "../Decorators/metadata";
import { HttpSetupError } from "../Errors/HttpError";
import { Router, type RouteAction } from "../Routing/Router";
import { RouterBuilder } from "../Routing/RouterBuilder";
import { parseTemplate } from "../Routing/template";

const publicValid: RouteOptions = { maxBodySize: "4mb" };
const runtimeZeroAllowedByTemplateLiteral: RouteOptions = { maxBodySize: "0b" };
const runtimeNegativeAllowedByTemplateLiteral: RouteOptions = { maxBodySize: "-1kb" };
if (false) {
  // @ts-expect-error Public route size is not numeric.
  const numeric: RouteOptions = { maxBodySize: 4096 };
  // @ts-expect-error Uppercase units are outside the public contract.
  const uppercase: RouteOptions = { maxBodySize: "4MB" };
  // @ts-expect-error Spaced values are outside the public contract.
  const spaced: RouteOptions = { maxBodySize: "4 mb" };
  // @ts-expect-error MiB is not a supported unit label.
  const mib: RouteOptions = { maxBodySize: "4mib" };
  // @ts-expect-error The old numeric alias is not public RouteOptions.
  const oldAlias: RouteOptions = { maxBodyBytes: 4096 };
  void [numeric, uppercase, spaced, mib, oldAlias];
}

function defineSingle(value: unknown): number | undefined {
  @Controller("single")
  class SingleController {
    @Get("value", { maxBodySize: value as never })
    value() { return "ok"; }
  }
  return controllerMetaOf(SingleController)!.actions.get("value")!.maxBodyBytes;
}

function expectSetup(value: unknown, message: string): void {
  expect(() => defineSingle(value)).toThrow(new HttpSetupError(message));
}

describe("route maxBodySize parser", () => {
  test("normalizes exact binary units and safe-integer boundary once", () => {
    expect(publicValid.maxBodySize).toBe("4mb");
    expect(runtimeZeroAllowedByTemplateLiteral.maxBodySize).toBe("0b");
    expect(runtimeNegativeAllowedByTemplateLiteral.maxBodySize).toBe("-1kb");
    expect(defineSingle("1b")).toBe(1);
    expect(defineSingle("4kb")).toBe(4_096);
    expect(defineSingle("4mb")).toBe(4_194_304);
    expect(defineSingle("1gb")).toBe(1_073_741_824);
    expect(defineSingle("9007199254740991b")).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejects non-primitive and every unapproved syntax with the fixed format error", () => {
    const message = "HTTP route maxBodySize must match '<positive integer><b|kb|mb|gb>' (e.g. '4mb').";
    for (const value of [
      4_096, new String("4kb"), null, {}, true,
      "", "0b", "01mb", "-1b", "+1b", "1.0mb", "1e3b", "1_000b",
      "4 MB", "4 MiB", "4MB", "4 mb", "4mib", "4tb", "4kb ", " 4kb", "4kb\n",
      "10000000000000000b", "99999999999999999b",
    ]) expectSetup(value, message);
  });

  test("rejects exact arithmetic overflow with the fixed overflow error", () => {
    const message = "HTTP route maxBodySize exceeds Number.MAX_SAFE_INTEGER bytes.";
    for (const value of ["9007199254740992b", "8796093022208kb", "8589934592mb", "8388608gb", "9999999999999999gb"]) {
      expectSetup(value, message);
    }
  });
});

describe("route action metadata", () => {
  test("accepts byte-equivalent multi-route values and lets an unspecified sibling inherit", () => {
    @Controller("equal")
    class EqualController {
      @Get("one", { maxBodySize: "1mb" })
      @Get("two", { maxBodySize: "1024kb" })
      @Get("three", { maxBodySize: "1048576b" })
      @Get("inherited")
      read() { return "ok"; }
    }
    const action = controllerMetaOf(EqualController)!.actions.get("read")!;
    expect(action.maxBodyBytes).toBe(1_048_576);
    expect(action.routes).toHaveLength(4);
    const router = new RouterBuilder([], undefined, undefined).build([EqualController]);
    for (const path of ["one", "two", "three", "inherited"]) {
      const match = router.match("GET", ["equal", path]);
      expect(match.kind).toBe("matched");
      expect(match.kind === "matched" && match.action.maxBodyBytes).toBe(1_048_576);
    }
  });

  test("rejects conflicting multi-route byte values", () => {
    expect(() => {
      @Controller("conflict")
      class ConflictController {
        @Get("decimal", { maxBodySize: "1000000b" })
        @Get("binary", { maxBodySize: "1mb" })
        read() { return "ok"; }
      }
      return ConflictController;
    }).toThrow("HTTP route decorators on one action must resolve maxBodySize to the same byte limit.");
  });

  test("copy-on-write keeps base and sibling actions isolated", () => {
    @Controller("base")
    class BaseController {
      @Get("read", { maxBodySize: "1kb" })
      read() { return "base"; }

      @Get("plain")
      plain() { return "plain"; }
    }
    @Controller("child")
    class ChildController extends BaseController {
      @Get("write", { maxBodySize: "2kb" })
      write() { return "child"; }
    }
    const base = controllerMetaOf(BaseController)!;
    const child = controllerMetaOf(ChildController)!;
    expect(base.actions.get("read")!.maxBodyBytes).toBe(1_024);
    expect(base.actions.has("write")).toBe(false);
    expect(base.actions.get("plain")!.maxBodyBytes).toBeUndefined();
    expect(child.actions.get("read")!.maxBodyBytes).toBe(1_024);
    expect(child.actions.get("write")!.maxBodyBytes).toBe(2_048);
    expect(child.actions.get("plain")!.maxBodyBytes).toBeUndefined();
  });
});

describe("compiled route metadata", () => {
  test("rejects invalid private numeric metadata before route composition", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      let composed = 0;
      @Controller("synthetic")
      class SyntheticController {
        @Get()
        read() { return "ok"; }
      }
      controllerMetaOf(SyntheticController)!.actions.get("read")!.maxBodyBytes = value;
      const builder = new RouterBuilder([], undefined, undefined, () => {
        composed += 1;
        return [];
      });
      expect(() => builder.build([SyntheticController])).toThrow(
        "HTTP route maxBodyBytes metadata must be a positive safe integer.",
      );
      expect(composed).toBe(0);
    }
  });

  test("selected Router action remains the single authority for method, version, HEAD and All", () => {
    const router = new Router();
    const action = (name: string, maxBodyBytes: number): RouteAction => ({ chain: [], name, maxBodyBytes });
    router.register(parseTemplate("items"), "GET", "", action("get", 1_024));
    router.register(parseTemplate("items"), "HEAD", "", action("head", 2_048));
    router.register(parseTemplate("items"), "PUT", "", action("put", 4_096));
    router.register(parseTemplate("versioned"), "GET", "", action("fallback", 8_192));
    router.register(parseTemplate("versioned"), "GET", "2", action("v2", 16_384));
    router.register(parseTemplate("all"), "*", "", action("all", 32_768));
    const cap = (method: string, path: string, version?: string) => {
      const match = router.match(method, [path], version);
      return match.kind === "matched" ? match.action.maxBodyBytes : undefined;
    };
    expect(cap("GET", "items")).toBe(1_024);
    expect(cap("HEAD", "items")).toBe(2_048);
    expect(cap("PUT", "items")).toBe(4_096);
    expect(cap("GET", "versioned", "2")).toBe(16_384);
    expect(cap("GET", "versioned", "9")).toBe(8_192);
    expect(cap("PATCH", "all")).toBe(32_768);
  });

  test("decorator factories retain public HEAD, All and method-local caps", () => {
    @Controller("methods")
    class MethodsController {
      @Get("same", { maxBodySize: "1kb" }) get() { return "get"; }
      @Head("same", { maxBodySize: "2kb" }) head() { return "head"; }
      @Put("same", { maxBodySize: "4kb" }) put() { return "put"; }
      @All("all", { maxBodySize: "8kb" }) all() { return "all"; }
      @Get("version", { maxBodySize: "16kb" }) @ApiVersion("2") version() { return "v2"; }
    }
    const router = new RouterBuilder([], undefined, { source: "header", headerName: "x-version" }).build([MethodsController]);
    expect((router.match("HEAD", ["methods", "same"]) as { action: RouteAction }).action.maxBodyBytes).toBe(2_048);
    expect((router.match("PUT", ["methods", "same"]) as { action: RouteAction }).action.maxBodyBytes).toBe(4_096);
    expect((router.match("PATCH", ["methods", "all"]) as { action: RouteAction }).action.maxBodyBytes).toBe(8_192);
    expect((router.match("GET", ["methods", "version"], "2") as { action: RouteAction }).action.maxBodyBytes).toBe(16_384);
  });
});
