import { describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer } from "@/core/di";
import {
  AllowAnonymous,
  Authorize,
  Controller,
  createAuthorizeComposer,
  ForbiddenError,
  Get,
  HttpServer,
  Middleware,
  UnauthorizedError,
  httpModule,
  resolveAuthorizeMeta,
  type HttpMiddleware,
} from "@/core/http";

describe("HTTP authorization metadata inheritance", () => {
  const authorizeCheck = () => true;

  test("class decorators override inherited state without mutating the base class", () => {
    @AllowAnonymous()
    class AnonymousBase {}

    @Authorize(authorizeCheck)
    class AuthorizedChild extends AnonymousBase {}

    expect(resolveAuthorizeMeta(AuthorizedChild, "value")).toEqual({
      allowAnonymous: false,
      authorize: { checks: [authorizeCheck] },
    });
    expect(resolveAuthorizeMeta(AnonymousBase, "value")).toEqual({ allowAnonymous: true });

    @Authorize(authorizeCheck)
    class AuthorizedBase {}

    @AllowAnonymous()
    class AnonymousChild extends AuthorizedBase {}

    expect(resolveAuthorizeMeta(AnonymousChild, "value")).toEqual({ allowAnonymous: true });
    expect(resolveAuthorizeMeta(AuthorizedBase, "value")).toEqual({
      allowAnonymous: false,
      authorize: { checks: [authorizeCheck] },
    });
  });

  test("overridden methods replace inherited state copy-on-write", () => {
    class AnonymousActionBase {
      @AllowAnonymous()
      value(): string {
        return "base";
      }
    }

    class AuthorizedActionChild extends AnonymousActionBase {
      @Authorize(authorizeCheck)
      override value(): string {
        return "child";
      }
    }

    expect(resolveAuthorizeMeta(AuthorizedActionChild, "value")).toEqual({
      allowAnonymous: false,
      authorize: { checks: [authorizeCheck] },
    });
    expect(resolveAuthorizeMeta(AnonymousActionBase, "value")).toEqual({ allowAnonymous: true });

    class AuthorizedActionBase {
      @Authorize(authorizeCheck)
      value(): string {
        return "base";
      }
    }

    class AnonymousActionChild extends AuthorizedActionBase {
      @AllowAnonymous()
      override value(): string {
        return "child";
      }
    }

    expect(resolveAuthorizeMeta(AnonymousActionChild, "value")).toEqual({ allowAnonymous: true });
    expect(resolveAuthorizeMeta(AuthorizedActionBase, "value")).toEqual({
      allowAnonymous: false,
      authorize: { checks: [authorizeCheck] },
    });
  });

  test("stacked @Authorize decorators accumulate locally without retaining overridden base checks", () => {
    const baseCheck = () => true;
    const firstCheck = () => true;
    const secondCheck = () => true;

    @Authorize(baseCheck)
    class Base {}

    @Authorize(firstCheck)
    @Authorize(secondCheck)
    class Child extends Base {
      @Authorize(firstCheck)
      @Authorize(secondCheck)
      value(): string {
        return "value";
      }
    }

    expect(resolveAuthorizeMeta(Child, "other")).toEqual({
      allowAnonymous: false,
      authorize: { checks: [firstCheck, secondCheck] },
    });
    expect(resolveAuthorizeMeta(Child, "value")).toEqual({
      allowAnonymous: false,
      authorize: { checks: [firstCheck, secondCheck] },
    });
    expect(resolveAuthorizeMeta(Base, "other")).toEqual({
      allowAnonymous: false,
      authorize: { checks: [baseCheck] },
    });
  });
});

describe("HTTP authorization ordering", () => {
  test("authorization runs before controller middleware", async () => {
    const calls: string[] = [];
    const controllerMiddleware: HttpMiddleware = async (_ctx, next) => {
      calls.push("controller");
      await next();
    };

    @Controller("secure")
    @Middleware(controllerMiddleware)
    @Authorize(() => {
      calls.push("authorize");
      return false;
    })
    class SecureController {
      @Get()
      get(): string {
        calls.push("action");
        return "secret";
      }
    }

    @Module({ controllers: [SecureController] })
    class Feature {}

    @Module({ imports: [httpModule({ imports: [Feature], port: 0 })] })
    class App {}

    const container = createContainer(App, { validateOnBuild: true });
    const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
    await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/secure`);
      expect(response.status).toBe(403);
      expect(calls).toEqual(["authorize"]);
    } finally {
      await server.stop();
      await container.dispose();
    }
  });

  test("every stacked authorization check runs before route work", async () => {
    const calls: string[] = [];

    @Controller("stacked-secure")
    @Authorize(() => {
      calls.push("first");
      return true;
    })
    @Authorize(() => {
      calls.push("second");
      return false;
    })
    class StackedSecureController {
      @Get()
      get(): string {
        calls.push("action");
        return "secret";
      }
    }

    const [middleware] = createAuthorizeComposer()(
      StackedSecureController,
      "get",
      {} as never,
      {} as never,
    );
    expect(middleware).toBeDefined();
    await expect(middleware!({} as never, async () => {
      calls.push("action");
    })).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toEqual(["first", "second"]);
  });
});

// A method-level @Authorize used to replace the controller's checks, silently
// dropping, for example, the sign-in check on an admin-only method.
describe("HTTP authorization: controller and method checks combine", () => {
  const signedIn = () => true;
  const isAdmin = () => true;

  test("the class checks run first, then the method checks", () => {
    @Authorize(signedIn)
    class Secure {
      @Authorize(isAdmin)
      admin(): void {}
      plain(): void {}
    }

    expect(resolveAuthorizeMeta(Secure, "admin")).toEqual({ allowAnonymous: false, authorize: { checks: [signedIn, isAdmin] } });
    expect(resolveAuthorizeMeta(Secure, "plain")).toEqual({ allowAnonymous: false, authorize: { checks: [signedIn] } });
  });

  test("a check repeated on the class and the method runs once", () => {
    @Authorize(signedIn)
    class Secure {
      @Authorize(signedIn, isAdmin)
      admin(): void {}
    }

    expect(resolveAuthorizeMeta(Secure, "admin")).toEqual({ allowAnonymous: false, authorize: { checks: [signedIn, isAdmin] } });
  });

  test("@AllowAnonymous on a method removes the controller checks", () => {
    @Authorize(signedIn)
    class Secure {
      @AllowAnonymous()
      login(): void {}
    }

    expect(resolveAuthorizeMeta(Secure, "login")).toEqual({ allowAnonymous: true });
  });

  test("on an anonymous controller only methods with their own @Authorize are protected", () => {
    @AllowAnonymous()
    class Open {
      @Authorize(isAdmin)
      admin(): void {}
      plain(): void {}
    }

    expect(resolveAuthorizeMeta(Open, "admin")).toEqual({ allowAnonymous: false, authorize: { checks: [isAdmin] } });
    expect(resolveAuthorizeMeta(Open, "plain")).toEqual({ allowAnonymous: true });
  });

  test("over HTTP: no credentials → 401 from the class check, wrong role → 403 from the method check", async () => {
    const calls: string[] = [];

    @Controller("combined")
    @Authorize((ctx) => {
      calls.push("signedIn");
      if (ctx.header("authorization") === undefined) throw new UnauthorizedError();
      return true;
    })
    class CombinedController {
      @Get("admin")
      @Authorize((ctx) => {
        calls.push("isAdmin");
        return ctx.header("authorization") === "admin";
      })
      admin(): string {
        calls.push("action");
        return "secret";
      }
    }

    @Module({ controllers: [CombinedController] })
    class Feature {}

    @Module({ imports: [httpModule({ imports: [Feature], port: 0 })] })
    class App {}

    const container = createContainer(App, { validateOnBuild: true });
    const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
    await server.start();
    const get = async (authorization?: string) => {
      calls.length = 0;
      const response = await fetch(`http://127.0.0.1:${server.port}/combined/admin`, { headers: authorization ? { authorization } : {} });
      return { status: response.status, calls: [...calls] };
    };
    try {
      expect(await get()).toEqual({ status: 401, calls: ["signedIn"] });
      expect(await get("user")).toEqual({ status: 403, calls: ["signedIn", "isAdmin"] });
      expect(await get("admin")).toEqual({ status: 200, calls: ["signedIn", "isAdmin", "action"] });
    } finally {
      await server.stop();
      await container.dispose();
    }
  });
});
