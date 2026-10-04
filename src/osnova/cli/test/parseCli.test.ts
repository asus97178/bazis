import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../parseCli";

describe("parseCliArgs", () => {
  test("parses osnova g module Product", () => {
    const parsed = parseCliArgs(["g", "module", "Product"]);
    expect(parsed.kind).toBe("generate");
    if (parsed.kind === "generate") {
      expect(parsed.args.generator).toBe("module");
      expect(parsed.args.name).toBe("Product");
      expect(parsed.args.profile).toBe("minimal");
    }
  });

  test("parses shorthand osnova g m Product", () => {
    const parsed = parseCliArgs(["g", "m", "Product"]);
    expect(parsed.kind).toBe("generate");
    if (parsed.kind === "generate") {
      expect(parsed.args.generator).toBe("module");
      expect(parsed.args.name).toBe("Product");
    }
  });

  test("accepts generate alias", () => {
    const parsed = parseCliArgs(["generate", "module", "User"]);
    expect(parsed.kind).toBe("generate");
  });

  test("parses full scaffold flag", () => {
    const parsed = parseCliArgs(["g", "m", "Product", "--full"]);
    expect(parsed.kind).toBe("generate");
    if (parsed.kind === "generate") {
      expect(parsed.args.profile).toBe("full");
    }
  });

  test("rejects missing g", () => {
    const parsed = parseCliArgs(["module", "Product"]);
    expect(parsed.kind).toBe("error");
  });

  test("rejects unknown generator", () => {
    const parsed = parseCliArgs(["g", "controller", "Product"]);
    expect(parsed.kind).toBe("error");
  });

  test.each([[], ["g"], ["g", "module"], ["g", "module", "Task"]].map((prefix) => ({ prefix })))("help at any depth is a read-only command: %j", ({ prefix }) => {
    expect(parseCliArgs([...prefix, "--help"])).toEqual({ kind: "help", help: true });
  });

  test.each(["--modules-root", "--app-module", "--parts", "--target"])("rejects missing or flag-shaped value for %s", (flag) => {
    for (const suffix of [[], ["--force"], [" "]]) {
      expect(parseCliArgs(["g", "module", "Task", flag, ...suffix]).kind).toBe("error");
    }
  });

  test.each([
    ["g", "module", "Task", "extra"],
    ["g", "constructor", "Task"],
    ["g", "__proto__", "Task"],
    ["g", "module", "Task", "--full", "--minimal"],
    ["g", "module", "Task", "--empty", "--full"],
    ["g", "module", "Task", "--parts", "a,b"],
    ["g", "pack", "DataManager"],
    ["g", "pack", "DataManager", "--parts", "records"],
    ["g", "pack", "DataManager", "--parts", "records,"],
    ["g", "pack", "DataManager", "--parts", "records,Records"],
    ["g", "pack", "DataManager", "--parts", "records,record"],
    ["g", "pack", "DataManager", "--parts", "a,b", "--full"],
    ["g", "module", "../Task"],
    ["g", "module", "Task", "--target", "all", "--no-codegen"],
    ["g", "module", "Task", "--target", "all", "--no-register"],
    ["g", "module", "Task", "--modules-root", "a", "--modules-root", "b"],
    ["codegen", "production"],
    ["codegen", "--force"],
    ["codegen", "--target", "../production"],
  ].map((args) => ({ args })))("rejects ambiguous or unsupported input: %j", ({ args }) => {
    expect(parseCliArgs(args).kind).toBe("error");
  });

  test.each(["pack", "p", "module-pack"])("accepts pack alias %s", (alias) => {
    const result = parseCliArgs(["generate", alias, "DataManager", "--parts", "tables, records", "--dry-run"]);
    expect(result.kind).toBe("generate");
    if (result.kind === "generate") {
      expect(result.args.parts).toEqual(["tables", "records"]);
      expect(result.args.dryRun).toBe(true);
    }
  });

  test("exposes an explicit codegen command with target forwarding", () => {
    expect(parseCliArgs(["codegen", "--target", "production"])).toEqual({ kind: "codegen", target: "production" });
  });
});
