import type { HttpMiddleware } from "../Middleware/types";
import { HttpSetupError } from "../Errors/HttpError";
import { ownActionMeta } from "./metadata";

type MethodDecorator = (value: (...args: never[]) => unknown, context: ClassMethodDecoratorContext) => void;

/**
 * Inline-опции действия — эквивалент отдельных атрибут-декораторов,
 * собранный в один объект (стиль `@Validator({...})`):
 *
 * ```ts
 * @Post(":id(int)", { code: 201, produces: "application/json" })
 * update(id: number) { ... }
 *
 * @Post({ code: 202 })          // путь пустой — опции первым аргументом
 * enqueue() { ... }
 * ```
 */
export interface RouteOptions {
  /** Статус успешного ответа (= `@HttpCode`). */
  readonly code?: number;
  /** Content-Type ответа для plain-результатов (= `@Produces`). */
  readonly produces?: string;
  /** Требуемый Content-Type запроса для body-привязок (= `@Consumes`). */
  readonly consumes?: string;
  /** Версия API действия (= `@ApiVersion` на методе). */
  readonly version?: string;
  /** Middleware маршрута (= `@Middleware` на методе). */
  readonly middleware?: readonly HttpMiddleware[];
  /** Максимальный размер body: целое число и binary unit слитно, например `4mb`. */
  readonly maxBodySize?: `${bigint}${"b" | "kb" | "mb" | "gb"}`;
}

function route(httpMethod: string, templateOrOptions?: string | RouteOptions, maybeOptions?: RouteOptions): MethodDecorator {
  const template = typeof templateOrOptions === "string" ? templateOrOptions : "";
  const options = typeof templateOrOptions === "object" ? templateOrOptions : maybeOptions;
  return (_value, context) => {
    if (context.static || context.private) {
      throw new Error(`HTTP route decorators support public instance methods only ("${String(context.name)}").`);
    }
    const action = ownActionMeta(context.metadata, context.name);
    action.routes.push({ httpMethod, template });
    if (options) {
      // Опции действуют на всё действие (как атрибут-декораторы); при
      // нескольких декораторах маршрута скалярные поля перезаписываются,
      // middleware накапливаются.
      if (options.code !== undefined) {
        action.httpCode = options.code;
      }
      if (options.produces !== undefined) {
        action.produces = options.produces;
      }
      if (options.consumes !== undefined) {
        action.consumes = options.consumes;
      }
      if (options.version !== undefined) {
        action.version = options.version;
      }
      if (options.middleware !== undefined) {
        action.middleware.push(...options.middleware);
      }
      if (options.maxBodySize !== undefined) {
        const maxBodyBytes = parseRouteMaxBodySize(options.maxBodySize);
        if (action.maxBodyBytes !== undefined && action.maxBodyBytes !== maxBodyBytes) {
          throw new HttpSetupError(
            "HTTP route decorators on one action must resolve maxBodySize to the same byte limit.",
          );
        }
        action.maxBodyBytes = maxBodyBytes;
      }
    }
  };
}

function parseRouteMaxBodySize(input: unknown): number {
  const formatError = () => new HttpSetupError(
    "HTTP route maxBodySize must match '<positive integer><b|kb|mb|gb>' (e.g. '4mb').",
  );
  if (typeof input !== "string" || input.length > 18) {
    throw formatError();
  }
  const match = /^([1-9][0-9]{0,15})(b|kb|mb|gb)$/.exec(input);
  if (match === null || match[0] !== input) {
    throw formatError();
  }
  const multiplier = match[2] === "gb"
    ? 1_073_741_824n
    : match[2] === "mb"
      ? 1_048_576n
      : match[2] === "kb"
        ? 1_024n
        : 1n;
  const bytes = BigInt(match[1]!) * multiplier;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpSetupError("HTTP route maxBodySize exceeds Number.MAX_SAFE_INTEGER bytes.");
  }
  return Number(bytes);
}

type RouteFactory = {
  (template?: string, options?: RouteOptions): MethodDecorator;
  (options: RouteOptions): MethodDecorator;
};

function createRouteFactory(httpMethod: string): RouteFactory {
  return ((templateOrOptions?: string | RouteOptions, maybeOptions?: RouteOptions) =>
    route(httpMethod, templateOrOptions, maybeOptions)) as RouteFactory;
}

/**
 * Декораторы маршрутов. Шаблон относителен префикса контроллера и
 * поддерживает параметры с ограничениями и wildcard в конце:
 *
 * - `":id"` — строковый параметр;
 * - `":id(int)"`, `":n(number)"`, `":f(bool)"`, `":u(uuid)"`, `":a(alpha)"` —
 *   параметр с ограничением и автоконверсией (несовпадение -> маршрут не матчится);
 * - `"*rest"` — catch-all, захватывает остаток пути (только последним сегментом).
 *
 * Вторым аргументом (или первым, если путь пустой) принимаются inline-опции
 * действия — см. {@link RouteOptions}. На методе может быть несколько
 * декораторов маршрута — действие доступно по всем.
 */
export const Get = createRouteFactory("GET");
export const Post = createRouteFactory("POST");
export const Put = createRouteFactory("PUT");
export const Patch = createRouteFactory("PATCH");
export const Delete = createRouteFactory("DELETE");
export const Options = createRouteFactory("OPTIONS");
export const Head = createRouteFactory("HEAD");
/** Матчит любой HTTP-метод (низший приоритет при выборе). */
export const All = createRouteFactory("*");
