import { can } from "bazis/core/access";
import { Authorize, Controller, Get, type HttpContext } from "bazis/core/http";
import { paginate } from "bazis/core/orm";
import { buildListDocument } from "bazis/library/jsonapi";
import type { AuditDbContext } from "../model/Audit.dbContext";
import { AuditListQuery } from "./contracts/AuditList.query";

@Controller("audit")
export class AuditController {
  constructor(private readonly db: AuditDbContext) {}

  @Get()
  @Authorize(can("audit.read"))
  async list(query: AuditListQuery, ctx: HttpContext) {
    const { items, total } = await paginate(this.db.entries.asNoTracking(), query);
    return buildListDocument(items, query, total, { basePath: ctx.path });
  }
}
