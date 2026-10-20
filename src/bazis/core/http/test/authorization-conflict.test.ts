import { describe, expect, test } from "bun:test";
import { AllowAnonymous, Authorize, HttpSetupError, resolveAuthorizeMeta } from "@/core/http";

// 0.110.0: @AllowAnonymous and @Authorize on the same method or class used to
// cancel each other silently, and the decorator order decided the outcome:
// `@AllowAnonymous() @Authorize(check)` left the route open with its check
// never called. The contradiction now stops the start.
const signedIn = () => true;

function failure(read: () => unknown): Error {
  try { read(); } catch (error) { return error as Error; }
  throw new Error("expected a failure");
}

describe("@AllowAnonymous and @Authorize together", () => {
  test("on one method, in either order, the route is rejected", () => {
    class Reports {
      @AllowAnonymous() @Authorize(signedIn) openFirst() {}
      @Authorize(signedIn) @AllowAnonymous() authorizeFirst() {}
    }
    for (const method of ["openFirst", "authorizeFirst"]) {
      const error = failure(() => resolveAuthorizeMeta(Reports, method));
      expect(error).toBeInstanceOf(HttpSetupError);
      expect(error.message).toBe(
        `Reports.${method} has both @AllowAnonymous() and @Authorize(...): the result would depend on the decorator order. `
          + "Keep @Authorize(...) to protect the route, or @AllowAnonymous() to open it.",
      );
    }
  });

  test("on one class, every route of the class is rejected", () => {
    @AllowAnonymous()
    @Authorize(signedIn)
    class Reports { list() {} }
    expect(failure(() => resolveAuthorizeMeta(Reports, "list")).message).toBe(
      "Reports has both @AllowAnonymous() and @Authorize(...) on the class: the result would depend on the decorator order. "
        + "Keep one; to open single methods of a protected class, put @AllowAnonymous() on them.",
    );
  });

  test("a class declaration and an opposite method declaration stay valid", () => {
    @Authorize(signedIn)
    class Protected { @AllowAnonymous() login() {} }
    @AllowAnonymous()
    class Open { @Authorize(signedIn) admin() {} }
    expect(resolveAuthorizeMeta(Protected, "login")).toEqual({ allowAnonymous: true });
    expect(resolveAuthorizeMeta(Open, "admin")).toEqual({ allowAnonymous: false, authorize: { checks: [signedIn] } });
  });

  test("a subclass may replace the declaration of its base", () => {
    class Base { @AllowAnonymous() value() {} }
    class Child extends Base { @Authorize(signedIn) override value() {} }
    expect(resolveAuthorizeMeta(Child, "value")).toEqual({ allowAnonymous: false, authorize: { checks: [signedIn] } });
    expect(resolveAuthorizeMeta(Base, "value")).toEqual({ allowAnonymous: true });
  });

  test("the start stops with a configuration error", async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/authorizeConflict.fixture.ts`], { stdout: "pipe", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(1);
    expect(stderr).toContain("[bazis] configuration error: ReportsController.bug has both @AllowAnonymous() and @Authorize(...)");
    expect(stderr).not.toContain("application failed");
  });
});
