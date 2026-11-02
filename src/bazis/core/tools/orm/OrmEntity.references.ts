import type { ReferenceContext, ReferenceItem, ReferencePage } from "../../access";
import { References } from "../../access";
import { AgentRegistry } from "../../agent/AgentRegistry";
import type { ServiceProvider } from "../../di";
import { ormEntityToolInfo, type OrmEntityToolInfo } from "./ormEntityTools";

/** What `ormEntityTools` opened in this application: only that is referenced. */
function opened(services: ServiceProvider): readonly OrmEntityToolInfo[] {
  const entities = new Map<string, Set<string>>();
  for (const tool of AgentRegistry.fromContainer(services).listTools()) {
    const info = ormEntityToolInfo(tool.target);
    if (info === undefined) continue;
    const fields = entities.get(info.entity) ?? new Set<string>();
    for (const field of info.fields) fields.add(field);
    entities.set(info.entity, fields);
  }
  return [...entities].map(([entity, fields]) => ({ entity, fields: [...fields] }));
}

function page(ids: readonly string[], text: string, { limit, offset }: ReferencePage): readonly ReferenceItem[] {
  const found = text.trim().toLowerCase();
  return ids.filter((id) => id.toLowerCase().includes(found)).sort().slice(offset, offset + limit).map((id) => ({ id, title: id }));
}

/** Reference kind `orm.entity`: an entity open to processes, `Order`. */
export class OrmEntityReferences extends References {
  constructor(private readonly services: ServiceProvider) {
    super();
  }

  private ids(): readonly string[] {
    return opened(this.services).map((item) => item.entity);
  }

  async exists(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const known = new Set(this.ids());
    return new Set(ids.filter((id) => known.has(id)));
  }

  async describe(ids: readonly string[]): Promise<readonly ReferenceItem[]> {
    return [...await this.exists(ids)].map((id) => ({ id, title: id }));
  }

  async search(text: string, _context: ReferenceContext, range: ReferencePage): Promise<readonly ReferenceItem[]> {
    return page(this.ids(), text, range);
  }
}

/** Reference kind `orm.field`: a field open to processes, `Order.status`. */
export class OrmFieldReferences extends References {
  constructor(private readonly services: ServiceProvider) {
    super();
  }

  private ids(): readonly string[] {
    return opened(this.services).flatMap((item) => item.fields.map((field) => `${item.entity}.${field}`));
  }

  async exists(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const known = new Set(this.ids());
    return new Set(ids.filter((id) => known.has(id)));
  }

  async describe(ids: readonly string[]): Promise<readonly ReferenceItem[]> {
    return [...await this.exists(ids)].map((id) => ({ id, title: id }));
  }

  async search(text: string, _context: ReferenceContext, range: ReferencePage): Promise<readonly ReferenceItem[]> {
    return page(this.ids(), text, range);
  }
}
