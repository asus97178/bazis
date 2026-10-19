import { EN_HTTP_MESSAGES, RU_HTTP_MESSAGES, formatMessage, type HttpMessageKey, type LanguageSelection, type Localize, type SelectedLanguage } from "../http/Errors/messages";
import { KernelError } from "../kernel";
import { EN_VALIDATION_MESSAGES, MessageRegistry, RU_VALIDATION_MESSAGES, type ValidationCode } from "../../library/validation";

/** Language of the texts the framework writes into responses. */
export type AppLanguage = "en" | "ru";

/**
 * Several response languages: each request gets the best match of its
 * `Accept-Language` among `supported`, or `default`.
 */
export interface AppLanguageOptions {
  readonly default: AppLanguage;
  readonly supported: readonly AppLanguage[];
}

/**
 * Own texts for framework messages, by key: HTTP texts (`notFound`,
 * `malformedJson`, …), validation codes (`required`, `minLength`, …),
 * `validationFailed`, `unknownField` and type names (`typeName.number`).
 * Placeholders: `{property}`, `{min}`, `{name}`, … as in the built-in texts.
 */
export type AppMessages = Partial<Record<HttpMessageKey | ValidationCode | "validationFailed" | "unknownField" | "duplicate" | "tooManyValues" | `typeName.${string}`, string>>;

const CATALOGS: Readonly<Record<AppLanguage, Readonly<Record<string, string>>>> = {
  en: { ...EN_HTTP_MESSAGES, ...EN_VALIDATION_MESSAGES },
  ru: { ...RU_HTTP_MESSAGES, ...RU_VALIDATION_MESSAGES },
};

/**
 * The text of a framework message in the application language. Priority:
 * `messages` > `Validator.setDefaultMessages` > the language catalog >
 * English. Rendered per server at the response, so two apps in one process
 * keep their own languages.
 */
export function createLocalize(language: AppLanguage = "en", messages: AppMessages = {}): Localize {
  if (!Object.prototype.hasOwnProperty.call(CATALOGS, language)) {
    throw new KernelError(`runApp: language "${String(language)}" is not supported. Use one of: ${Object.keys(CATALOGS).join(", ")}.`);
  }
  const catalog = CATALOGS[language];
  const own = messages as Readonly<Record<string, string | undefined>>;
  const template = (key: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(own, key) && typeof own[key] === "string") return own[key];
    const override = MessageRegistry.override(key);
    if (override !== undefined) return override;
    if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
    return Object.prototype.hasOwnProperty.call(CATALOGS.en, key) ? CATALOGS.en[key] : undefined;
  };
  return (key, params) => {
    const text = template(key);
    return text === undefined ? undefined : formatMessage(text, params, template);
  };
}

/**
 * The response language of every request: one language, or the best match of
 * `Accept-Language` (`ru-RU,ru;q=0.9,en;q=0.8`) among `supported`.
 */
export function createLanguages(option: AppLanguage | AppLanguageOptions = "en", messages: AppMessages = {}): LanguageSelection {
  if (typeof option === "string") {
    const single: SelectedLanguage = { language: option, localize: createLocalize(option, messages) };
    return { negotiated: false, select: () => single };
  }
  const supported = [...new Set(option.supported)];
  if (supported.length === 0) throw new KernelError("runApp: language.supported needs at least one language.");
  if (!supported.includes(option.default)) {
    throw new KernelError(`runApp: language.default "${String(option.default)}" must be one of language.supported (${supported.join(", ")}).`);
  }
  const selected = new Map<string, SelectedLanguage>(supported.map((language) => [language, { language, localize: createLocalize(language, messages) }]));
  const fallback = selected.get(option.default)!;
  return {
    negotiated: supported.length > 1,
    select(acceptLanguage) {
      const language = negotiateLanguage(acceptLanguage, supported);
      return language === undefined ? fallback : selected.get(language)!;
    },
  };
}

/** The supported language with the highest `q` in `Accept-Language`; ties keep the header order. */
export function negotiateLanguage(header: string | null | undefined, supported: readonly string[]): string | undefined {
  if (header === null || header === undefined || header.length > 1024) return undefined;
  let best: { language: string; q: number } | undefined;
  for (const part of header.split(",").slice(0, 32)) {
    const [range = "", ...parameters] = part.trim().split(";");
    const tag = range.trim().toLowerCase();
    if (tag.length === 0) continue;
    let q = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.trim().split("=");
      if (name?.trim() === "q") q = Number(value);
    }
    if (!Number.isFinite(q) || q <= 0 || q > 1) continue;
    const primary = tag === "*" ? undefined : tag.split("-")[0];
    const language = primary === undefined ? undefined : supported.find((candidate) => candidate === primary);
    if (language !== undefined && (best === undefined || q > best.q)) best = { language, q };
  }
  return best?.language;
}
