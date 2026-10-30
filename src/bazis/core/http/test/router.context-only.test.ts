import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Module } from "@/core/di";
import { Controller, Get, type HttpContext } from "@/core/http";
import { startTestApp } from "@/core/testing";
import { warnIfGeneratedSourcesChanged } from "@/core/generatedRuntime";
import { contextOnlyController } from "../Routing/contextOnlyControllers";

// 0.124.1: with a stale application codegen the router refused framework
// controllers (workflow, UI) that read the HttpContext themselves.
let root = "";
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("a stale codegen stops an application controller without bindings, not a framework one", async () => {
  root = await mkdtemp(path.join(tmpdir(), "bazis-context-only-"));
  await Bun.write(path.join(root, "bazis.config.json"), "{}");
  expect(warnIfGeneratedSourcesChanged(root, { root: ".", framework: "0.0.0", files: [], hash: "stale" }, () => {})).toBe(true);

  @Controller("framework")
  class FrameworkController {
    @Get("ping")
    ping(ctx: HttpContext) {
      return { path: ctx.path };
    }
  }
  contextOnlyController(FrameworkController);

  @Controller("app")
  class AppController {
    @Get("ping")
    ping(ctx: HttpContext) {
      return { path: ctx.path };
    }
  }

  @Module({ controllers: [FrameworkController] })
  class FrameworkOnly {}
  const app = await startTestApp(FrameworkOnly);
  try {
    expect(await (await app.fetch("/framework/ping")).json()).toEqual({ path: "/framework/ping" });
  } finally {
    await app.stop();
  }

  @Module({ controllers: [AppController] })
  class WithApplicationController {}
  await expect(startTestApp(WithApplicationController)).rejects.toThrow("AppController.ping has parameters but no generated argument bindings");
});
