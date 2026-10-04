import { InfraError } from "./InfraConnector";
import type { AppConfig } from "../kernel/config/defineConfig";
import type { ConfigRegistry } from "../kernel/config/ConfigRegistry";

/**
 * Минимальный динамический доступ к декларативному конфигу подсистемы.
 *
 * Коннекторы принимают типизированный конфиг (`AppConfig<...Shape>`): на месте
 * вызова это гарантирует, что нужные ключи объявлены с верными типами. Внутри же
 * коннектор читает их по имени — рантайм-форма известна из `Shape`, поэтому здесь
 * допустим узкий каст к этому ридеру.
 */
export interface ConfigReader {
  get(key: string): unknown;
  has(key: string): boolean;
}

/** Узкий каст конфига к динамическому ридеру (форма проверена типом на входе). */
export function reader(config: object, configs?: ConfigRegistry): ConfigReader {
  return (configs?.get(config as AppConfig<object>) ?? config) as ConfigReader;
}

/** Читает обязательное непустое строковое значение или падает с понятной ошибкой. */
export function requireValue(value: unknown, field: string, kind: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InfraError(`Infra connector "${kind}": "${field}" is required and must be a non-empty string.`);
  }
  return value;
}
