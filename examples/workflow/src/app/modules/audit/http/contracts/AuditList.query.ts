import { Filterable, ListOptions, ListRequest, Sortable } from "bazis/core/http";
import type { AuditEntry } from "../../model/AuditEntry.model";

@ListOptions({ defaultSize: 50, maxSize: 200, defaultSort: "-at" })
export class AuditListQuery extends ListRequest<AuditEntry> {
  @Filterable("eq", "startsWith")
  action!: string;

  @Filterable("eq")
  target!: string;

  @Sortable()
  at!: Date;
}
