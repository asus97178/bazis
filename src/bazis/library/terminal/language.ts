import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Languages of the terminal output. */
export type Language = "en" | "ru";

export const LANGUAGES: readonly Language[] = Object.freeze(["en", "ru"]);

/** `ru`, `ru-RU`, `ru_RU.UTF-8` → `ru`; anything unknown → undefined. */
export function parseLanguage(value: string | undefined): Language | undefined {
  const code = value?.trim().toLowerCase().split(/[-_.@]/)[0];
  return LANGUAGES.find((language) => language === code);
}

export interface LanguageSources {
  /** `--lang` of the command line. */
  readonly flag?: string;
  /** `BAZIS_LANG`. */
  readonly env?: string;
  /** `"language"` of `bazis.config.json`. */
  readonly project?: string;
  /** The system locale: `LC_ALL`, `LC_MESSAGES` or `LANG`. */
  readonly system?: string;
}

/**
 * The first language that is set and known, in order: the `--lang` flag,
 * `BAZIS_LANG`, the project's `bazis.config.json`, the system locale. English
 * otherwise. An unknown value is skipped, not an error: output language must
 * never stop a command.
 */
export function resolveLanguage(sources: LanguageSources): Language {
  return parseLanguage(sources.flag) ?? parseLanguage(sources.env) ?? parseLanguage(sources.project) ?? parseLanguage(sources.system) ?? "en";
}

/** `"language"` of the nearest `bazis.config.json` from `cwd` up. */
export function projectLanguage(cwd = process.cwd()): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = join(dir, "bazis.config.json");
    if (existsSync(file)) {
      try {
        const value = (JSON.parse(readFileSync(file, "utf8")) as { language?: unknown }).language;
        return typeof value === "string" ? value : undefined;
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

export function systemLanguage(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LC_ALL || env.LC_MESSAGES || env.LANG || undefined;
}

/** The language of this process: `BAZIS_LANG`, then the project, then the system. */
export function detectLanguage(options: { flag?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Language {
  const env = options.env ?? process.env;
  return resolveLanguage({ flag: options.flag, env: env.BAZIS_LANG, project: projectLanguage(options.cwd), system: systemLanguage(env) });
}
