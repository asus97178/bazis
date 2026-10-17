import { EN_HTTP_MESSAGES, RU_HTTP_MESSAGES, formatMessage, type HttpMessageKey, type Localize } from "../http/Errors/messages";
import { KernelError } from "../kernel";
import { EN_VALIDATION_MESSAGES, MessageRegistry, RU_VALIDATION_MESSAGES, type ValidationCode } from "../../library/validation";

/** Language of the texts the framework writes into responses. */
export type AppLanguage = "en" | "ru";

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
