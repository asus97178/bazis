import { describe, expect, test } from "bun:test";
import { HttpSetupError } from "../Errors/HttpError";
import { Router, type RouteAction } from "../Routing/Router";
import { joinPaths, parseRequestPath, parseTemplate } from "../Routing/template";

function action(name: string): RouteAction {
  return { chain: [], name };
}

function register(router: Router, template: string, method = "GET", version = ""): void {
  router.register(parseTemplate(template), method, version, action(template));
}

describe("парсер шаблонов", () => {
  test("статические, параметры, ограничения, wildcard", () => {
    const segments = parseTemplate("users/:id(int)/files/*path");
    expect(segments).toHaveLength(4);
    expect(segments[0]).toEqual({ kind: "static", value: "users" });
    expect(segments[1]!.kind).toBe("param");
    expect(segments[3]).toEqual({ kind: "wildcard", name: "path" });
  });

  test("неизвестное ограничение и wildcard не в конце — ошибка старта", () => {
    expect(() => parseTemplate(":id(decimal)")).toThrow(HttpSetupError);
    expect(() => parseTemplate("*rest/users")).toThrow(HttpSetupError);
  });

  test("запрещённые имена параметров (prototype pollution)", () => {
    expect(() => parseTemplate(":__proto__")).toThrow(HttpSetupError);
    expect(() => parseTemplate("*constructor")).toThrow(HttpSetupError);
  });

  test("joinPaths нормализует слэши", () => {
    expect(joinPaths("api", "/v1.0/", "users", ":id")).toBe("api/v1.0/users/:id");
    expect(joinPaths(undefined, "users", "")).toBe("users");
  });
});

describe("парсер пути запроса", () => {
  test("декодирование и отбрасывание пустых сегментов", () => {
    expect(parseRequestPath("/a//b%20c/")).toEqual(["a", "b c"]);
  });

  test("обход каталогов и битые проценты -> undefined (400)", () => {
    expect(parseRequestPath("/a/../etc/passwd")).toBeUndefined();
    expect(parseRequestPath("/a/%zz")).toBeUndefined();
  });
});

describe("radix-роутер", () => {
  test("статический маршрут приоритетнее параметра", () => {
    const router = new Router();
    register(router, "users/me");
    register(router, "users/:id");
    const matched = router.match("GET", ["users", "me"]);
    expect(matched.kind).toBe("matched");
    expect((matched as { action: RouteAction }).action.name).toBe("users/me");
  });

  test("ограничение int конвертирует значение, нарушение — не матчится", () => {
    const router = new Router();
    register(router, "users/:id(int)");
    const matched = router.match("GET", ["users", "42"]);
    expect(matched.kind).toBe("matched");
    expect((matched as { params: Record<string, unknown> }).params.id).toBe(42);
    expect(router.match("GET", ["users", "abc"]).kind).toBe("not-found");
  });

  test("backtracking: статическая ветка без листа отступает к параметру", () => {
    const router = new Router();
    register(router, "files/special/meta");
    register(router, "files/:name/download");
    const matched = router.match("GET", ["files", "special", "download"]);
    expect(matched.kind).toBe("matched");
    expect((matched as { action: RouteAction }).action.name).toBe("files/:name/download");
  });

  test("wildcard захватывает остаток пути, включая пустой", () => {
    const router = new Router();
    register(router, "static/*path");
    const deep = router.match("GET", ["static", "css", "site.css"]);
    expect((deep as { params: Record<string, unknown> }).params.path).toBe("css/site.css");
    const empty = router.match("GET", ["static"]);
    expect((empty as { params: Record<string, unknown> }).params.path).toBe("");
  });

  test("405 со списком Allow; @All матчит любой метод", () => {
    const router = new Router();
    register(router, "items", "GET");
    register(router, "items", "POST");
    const blocked = router.match("DELETE", ["items"]);
    expect(blocked.kind).toBe("method-not-allowed");
    expect([...(blocked as { allow: readonly string[] }).allow].sort()).toEqual(["GET", "HEAD", "POST"]);

    register(router, "anything", "*");
    expect(router.match("PATCH", ["anything"]).kind).toBe("matched");
  });

  test("версии: точное совпадение, fallback на безверсионный, unsupported", () => {
    const router = new Router();
    register(router, "things", "GET", "1.0");
    register(router, "things", "GET", "2.0");
    const v2 = router.match("GET", ["things"], "2.0");
    expect((v2 as { action: RouteAction }).action.name).toBe("things");
    const unsupported = router.match("GET", ["things"], "9.9");
    expect(unsupported.kind).toBe("unsupported-version");
    expect([...(unsupported as { supported: readonly string[] }).supported].sort()).toEqual(["1.0", "2.0"]);
    // A request without a version, and there is no unversioned route.
    expect(router.match("GET", ["things"]).kind).toBe("unsupported-version");
  });

  test("дубликат маршрута — ошибка старта", () => {
    const router = new Router();
    register(router, "users/:id");
    expect(() => register(router, "users/:id")).toThrow(HttpSetupError);
  });

  test("логический дубликат с другим именем параметра — ошибка старта", () => {
    const router = new Router();
    register(router, "users/:id");
    expect(() => register(router, "users/:name")).toThrow(HttpSetupError);
  });

  test("логический wildcard-дубликат с другим именем — ошибка старта", () => {
    const router = new Router();
    register(router, "files/*path");
    expect(() => register(router, "files/*rest")).toThrow(HttpSetupError);
  });

  test("разные методы могут использовать разные имена одного параметра", () => {
    const router = new Router();
    register(router, "users/:id", "GET");
    register(router, "users/:name", "POST");
    const post = router.match("POST", ["users", "alice"]);
    expect(post.kind).toBe("matched");
    expect((post as { params: Record<string, unknown> }).params.name).toBe("alice");
    expect((post as { params: Record<string, unknown> }).params).toEqual({ name: "alice" });
  });

  test("имена параметров принадлежат только выбранному методу и версии", () => {
    const router = new Router();
    register(router, "orgs/:orgId/items/:id", "GET");
    register(router, "orgs/:id/items/:itemId", "PUT");
    register(router, "orgs/:tenant/items/:key", "GET", "2");
    const path = ["orgs", "ORG-A", "items", "ITEM-B"];
    for (const [method, version, expected] of [
      ["GET", undefined, { orgId: "ORG-A", id: "ITEM-B" }],
      ["PUT", undefined, { id: "ORG-A", itemId: "ITEM-B" }],
      ["HEAD", undefined, { orgId: "ORG-A", id: "ITEM-B" }],
      ["GET", "2", { tenant: "ORG-A", key: "ITEM-B" }],
      ["GET", "unknown", { orgId: "ORG-A", id: "ITEM-B" }],
    ] as const) {
      const match = router.match(method, path, version);
      expect(match.kind).toBe("matched");
      if (match.kind !== "matched") throw new Error("route did not match");
      expect(match.params).toEqual(expected);
      expect(Object.getPrototypeOf(match.params)).toBeNull();
    }
  });

  test("wildcard и отступление от неуспешной ветки не оставляют чужие параметры", () => {
    const router = new Router();
    register(router, "orgs/:orgId/files/*id", "GET");
    register(router, "orgs/:id/files/*path", "PUT");
    register(router, "orgs/:unused/files/:rejected/meta", "GET");
    for (const tail of [[], ["dir", "file.txt"]]) {
      const match = router.match("PUT", ["orgs", "ORG-A", "files", ...tail]);
      expect(match.kind).toBe("matched");
      if (match.kind !== "matched") throw new Error("route did not match");
      expect(match.params).toEqual({ id: "ORG-A", path: tail.join("/") });
    }
  });

  test("int имеет стабильный приоритет перед более широким number", () => {
    const router = new Router();
    register(router, "values/:value(number)");
    register(router, "values/:value(int)");
    const matched = router.match("GET", ["values", "7"]);
    expect((matched as { action: RouteAction }).action.name).toBe("values/:value(int)");
  });
});
