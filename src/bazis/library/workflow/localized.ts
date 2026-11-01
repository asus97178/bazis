/** A text in several languages: language → text. A plain string is in the default language. */
export type LocalizedText = string | Readonly<Record<string, string>>;

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The text for `language`: its exact entry, its base language (`ru` for `ru-RU`), then `fallback`, then the first one. */
export function textOf(text: LocalizedText | null | undefined, language: string, fallback = language): string {
  if (text === undefined || text === null) return "";
  if (typeof text === "string") return text;
  const own = (key: string) => (Object.hasOwn(text, key) ? text[key] : undefined);
  return own(language) ?? own(language.split("-")[0]!) ?? own(fallback) ?? Object.values(text)[0] ?? "";
}

/** Every text of a value, the default language first: what a search looks through and a list sorts by. */
export function allTexts(text: LocalizedText | null | undefined, language: string): string {
  if (text === undefined || text === null) return "";
  if (typeof text === "string") return text;
  const first = textOf(text, language);
  return [first, ...Object.values(text).filter((item) => item !== first)].join("\n");
}

/** What is wrong with a value as a localized text, or `null`. `min` — 1 for a required text. */
export function checkLocalizedText(value: unknown, max: number, min = 1): string | null {
  const fits = (text: unknown) => typeof text === "string" && text.trim().length >= min && text.length <= max;
  const size = min === 0 ? `up to ${max}` : `${min}–${max}`;
  if (typeof value === "string") return fits(value) ? null : `must be ${size} characters`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be a string or an object of language → text";
  const entries = Object.entries(value);
  if (entries.length === 0) return "needs at least one language";
  for (const [language, text] of entries) {
    if (!LANGUAGE.test(language)) return `has an invalid language ${JSON.stringify(language)}`;
    if (!fits(text)) return `${language} must be ${size} characters`;
  }
  return null;
}
