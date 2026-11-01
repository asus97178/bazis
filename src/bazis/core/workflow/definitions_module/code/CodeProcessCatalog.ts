import type { ServiceProvider } from "../../../di";
import { codeProcessesOf, type OwnedCodeProcess } from "./codeProcesses";

/** The processes declared in the application's modules, by key: which module owns a key. */
export class CodeProcessCatalog {
  private readonly byKey: ReadonlyMap<string, OwnedCodeProcess>;

  constructor(services: ServiceProvider) {
    this.byKey = new Map([...codeProcessesOf(services)].sort((a, b) => a.process.key.localeCompare(b.process.key)).map((entry) => [entry.process.key, entry]));
  }

  /** The module whose `processes` declare `key`; `undefined` for a process of the catalog. */
  moduleOf(key: string): string | undefined {
    return this.byKey.get(key)?.module;
  }

  list(): readonly OwnedCodeProcess[] {
    return [...this.byKey.values()];
  }
}
