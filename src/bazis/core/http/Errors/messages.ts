/** Placeholder values of a message template: `{name}` -> `params.name`. */
export type MessageParams = Readonly<Record<string, unknown>>;

/**
 * Turns a message key and its parameters into text in the application
 * language; `undefined` keeps the English text the error was created with.
 * `runApp` builds it from its `language` and `messages` options.
 */
export type Localize = (key: string, params: MessageParams) => string | undefined;

/** The response language of one request and its texts. */
export interface SelectedLanguage {
  readonly language: string;
  readonly localize: Localize;
}

/**
 * Picks the response language of a request. `negotiated`: several languages,
 * chosen by `Accept-Language`; responses whose text the framework wrote then
 * carry `Content-Language` and `Vary: Accept-Language`.
 */
export interface LanguageSelection {
  readonly negotiated: boolean;
  select(acceptLanguage: string | null | undefined): SelectedLanguage;
}

/** Headers of a framework-written response in a negotiated language. */
export function languageHeaders(selection: LanguageSelection | undefined, selected: SelectedLanguage | undefined): [string, string][] {
  return selection?.negotiated === true && selected !== undefined ? [["content-language", selected.language], ["vary", "Accept-Language"]] : [];
}

/** A message key and parameters carried by an error, rendered at the response. */
export interface LocalizedMessage {
  readonly key: string;
  readonly params?: MessageParams;
}

/** Keys of the texts the HTTP layer writes itself. */
export type HttpMessageKey =
  | "badRequest"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "methodNotAllowed"
  | "conflict"
  | "gone"
  | "preconditionFailed"
  | "payloadTooLarge"
  | "unsupportedMediaType"
  | "unprocessableContent"
  | "locked"
  | "tooManyRequests"
  | "clientError"
  | "internalServerError"
  | "badGateway"
  | "serviceUnavailable"
  | "gatewayTimeout"
  | "serverError"
  | "malformedPath"
  | "unsupportedApiVersion"
  | "malformedJson"
  | "malformedForm"
  | "bodyNotObject"
  | "bodyTooDeep"
  | "bodyTooComplex"
  | "bodyCyclic"
  | "invalidListQuery";

export const EN_HTTP_MESSAGES: Readonly<Record<HttpMessageKey, string>> = Object.freeze({
  badRequest: "Bad Request",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  notFound: "Not Found",
  methodNotAllowed: "Method Not Allowed",
  conflict: "Conflict",
  gone: "Gone",
  preconditionFailed: "Precondition Failed",
  payloadTooLarge: "Payload Too Large",
  unsupportedMediaType: "Unsupported Media Type: expected {expected}",
  unprocessableContent: "Unprocessable Content",
  locked: "Locked",
  tooManyRequests: "Too Many Requests",
  clientError: "Client Error",
  internalServerError: "Internal Server Error",
  badGateway: "Bad Gateway",
  serviceUnavailable: "Service Unavailable",
  gatewayTimeout: "Gateway Timeout",
  serverError: "Server Error",
  malformedPath: "Malformed request path",
  unsupportedApiVersion: "Unsupported API version",
  malformedJson: "Malformed JSON in request body",
  malformedForm: "Malformed form data in request body",
  bodyNotObject: "Request body must be a JSON object",
  bodyTooDeep: "Request body is too deeply nested",
  bodyTooComplex: "Request body is too complex",
  bodyCyclic: "Request body must be acyclic JSON",
  invalidListQuery: "Invalid list query",
});

export const RU_HTTP_MESSAGES: Readonly<Record<HttpMessageKey, string>> = Object.freeze({
  badRequest: "Некорректный запрос",
  unauthorized: "Требуется аутентификация",
  forbidden: "Доступ запрещён",
  notFound: "Не найдено",
  methodNotAllowed: "Метод не поддерживается",
  conflict: "Конфликт",
  gone: "Ресурс удалён",
  preconditionFailed: "Предусловие не выполнено",
  payloadTooLarge: "Слишком большой запрос",
  unsupportedMediaType: "Неподдерживаемый тип содержимого: ожидается {expected}",
  unprocessableContent: "Невозможно обработать данные",
  locked: "Ресурс заблокирован",
  tooManyRequests: "Слишком много запросов",
  clientError: "Ошибка в запросе",
  internalServerError: "Внутренняя ошибка сервера",
  badGateway: "Ошибка внешнего сервиса",
  serviceUnavailable: "Сервис недоступен",
  gatewayTimeout: "Внешний сервис не ответил вовремя",
  serverError: "Ошибка сервера",
  malformedPath: "Некорректный путь запроса",
  unsupportedApiVersion: "Неподдерживаемая версия API",
  malformedJson: "Тело запроса — некорректный JSON",
  malformedForm: "Некорректные данные формы в теле запроса",
  bodyNotObject: "Тело запроса должно быть JSON-объектом",
  bodyTooDeep: "Слишком глубокая вложенность в теле запроса",
  bodyTooComplex: "Тело запроса слишком сложное",
  bodyCyclic: "Тело запроса не должно содержать циклов",
  invalidListQuery: "Некорректные параметры списка",
});

/** Reason-phrase keys of the statuses the error handler writes for unexpected errors. */
export const STATUS_MESSAGE_KEYS: Readonly<Record<number, HttpMessageKey>> = Object.freeze({
  400: "badRequest", 401: "unauthorized", 403: "forbidden", 404: "notFound", 405: "methodNotAllowed",
  409: "conflict", 410: "gone", 412: "preconditionFailed", 413: "payloadTooLarge", 415: "unsupportedMediaType",
  422: "unprocessableContent", 423: "locked", 429: "tooManyRequests", 500: "internalServerError",
  502: "badGateway", 503: "serviceUnavailable", 504: "gatewayTimeout",
});

/** Parameters whose value is a type name, translated through `typeName.<name>` keys. */
const TYPE_PARAMS = new Set(["expected", "actual", "type"]);

/**
 * Substitutes `{name}` placeholders. Unknown placeholders stay as they are.
 * With `lookup`, a type name in `expected`/`actual`/`type` is replaced by the
 * `typeName.<name>` text when the catalog has one ("number" -> "число").
 */
export function formatMessage(template: string, params: MessageParams, lookup?: (key: string) => string | undefined): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name) || params[name] === undefined) return placeholder;
    const value = params[name];
    if (lookup !== undefined && TYPE_PARAMS.has(name) && typeof value === "string") {
      const typeName = lookup(`typeName.${value}`);
      if (typeName !== undefined) return typeName;
    }
    return stringifyParam(value);
  });
}

function stringifyParam(value: unknown): string {
  if (typeof value === "object" && value !== null && !(value instanceof RegExp)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** English text of a framework message, used when the app sets no language. */
export function englishHttpMessage(key: HttpMessageKey, params: MessageParams = {}): string {
  return formatMessage(EN_HTTP_MESSAGES[key], params);
}
