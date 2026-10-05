import type { PropertyModel } from "../Metadata/types";
import { EntityState } from "../Tracking/EntityState";
import type { TrackedEntry } from "../Tracking/ChangeTracker";

function isUnset(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function generateUuid(property: PropertyModel): string {
  if (property.uuidVersion === "v7") {
    return Bun.randomUUIDv7();
  }
  return crypto.randomUUID();
}

/**
 * Applies the `@UUID`, `@CreatedAt`, `@UpdatedAt` conventions before SQL is built.
 * Called after `detectChanges` so timestamp fields get into INSERT/UPDATE.
 */
export function applyConventions(pending: readonly TrackedEntry[]): void {
  const now = new Date();
  for (const entry of pending) {
    if (entry.state === EntityState.Deleted) {
      continue;
    }
    const entity = entry.entity as Record<string, unknown>;
    const isAdded = entry.state === EntityState.Added;
    const isModified = entry.state === EntityState.Modified;

    for (const property of entry.model.properties) {
      switch (property.convention) {
        case "uuid":
          // The database generates UUID keys (generation === "uuid"); only non-key
          // uuid fields are generated here.
          if (property.isKey) {
            break;
          }
          if (isAdded && isUnset(entity[property.propertyName])) {
            entity[property.propertyName] = generateUuid(property);
          }
          break;
        case "createdAt":
          if (isAdded) {
            entity[property.propertyName] = now;
          }
          break;
        case "updatedAt":
          if (isAdded || isModified) {
            entity[property.propertyName] = now;
            if (isModified) {
              entry.modifiedProperties.add(property.propertyName);
            }
          }
          break;
      }
    }
  }
}
