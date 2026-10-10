import { EntityState } from "../Tracking/EntityState";
import type { TrackedEntry } from "../Tracking/ChangeTracker";

type Values = Record<string, unknown>;

/**
 * Foreign keys from navigations, as EF Core's relationship fix-up does:
 * `article.author = bob` (a `@ManyToOne`) or `bob.articles.push(article)`
 * (a `@OneToMany`) set `article.authorId` from `bob`'s key. Only navigations to
 * entities tracked by the same context are followed; the navigation wins over
 * a different value in the foreign key property.
 */
export class NavigationFixup {
  /** child entity -> the parents whose collection holds it. */
  private readonly parents = new Map<object, { readonly parent: TrackedEntry; readonly foreignKey: readonly string[] }[]>();

  constructor(private readonly entries: ReadonlyMap<object, TrackedEntry>) {
    for (const entry of entries.values()) {
      for (const relation of entry.model.relations) {
        if (relation.kind !== "collection") continue;
        const children = (entry.entity as Values)[relation.navigationName];
        if (!Array.isArray(children)) continue;
        for (const child of children) {
          if (child === null || typeof child !== "object" || !entries.has(child)) continue;
          const list = this.parents.get(child) ?? [];
          list.push({ parent: entry, foreignKey: toArray(relation.foreignKey) });
          this.parents.set(child, list);
        }
      }
    }
  }

  /** Applies the fix-up to every tracked entry (before change detection). */
  applyAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.state !== EntityState.Deleted) this.apply(entry);
    }
  }

  /**
   * Applies the fix-up to one entry and returns the foreign key properties it
   * changed. Called again right before the entry's SQL, when the keys the
   * database generated for its parents are known.
   */
  apply(entry: TrackedEntry): readonly string[] {
    const changed: string[] = [];
    const entity = entry.entity as Values;
    for (const relation of entry.model.relations) {
      if (relation.kind !== "reference") continue;
      const target = entity[relation.navigationName];
      if (target === null || typeof target !== "object") continue;
      const targetEntry = this.entries.get(target);
      if (targetEntry === undefined) continue;
      this.copyKey(entity, toArray(relation.foreignKey), targetEntry, changed);
    }
    for (const { parent, foreignKey } of this.parents.get(entry.entity) ?? []) {
      if (parent.state === EntityState.Deleted) continue;
      this.copyKey(entity, foreignKey, parent, changed);
    }
    return changed;
  }

  private copyKey(entity: Values, foreignKey: readonly string[], target: TrackedEntry, changed: string[]): void {
    const key = target.model.key;
    if (key.length !== foreignKey.length) return;
    const source = target.entity as Values;
    key.forEach((property, index) => {
      const name = foreignKey[index]!;
      const value = source[property.propertyName];
      if (entity[name] !== value) {
        entity[name] = value;
        changed.push(name);
      }
    });
  }
}

function toArray(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}
