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
