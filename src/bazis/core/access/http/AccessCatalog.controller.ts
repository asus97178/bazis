import { contextOnlyController } from "../../http/Routing/contextOnlyControllers";
import { Authorize, BadRequestError, Controller, Get, NotFoundError, type HttpContext } from "../../http";
import { IAccessCatalog } from "../catalog/IAccessCatalog.service";
import { can } from "../check/can";
import type { Scope } from "../contracts/types";

/**
 * The catalog for the administrator's screens of the rights system
 * (ACCESS-001 §7): what can be allowed, and the values to pick in conditions.
 * Read only: roles live in the rights system.
 */
@Controller("access")
export class AccessCatalogController {
  @Get("catalog")
  @Authorize(can("access.catalog.read"))
  catalogList(ctx: HttpContext) {
    return {
      data: ctx.services.resolve(IAccessCatalog).permissions().map(({ key, spec, module }) => ({
        key,
        module,
        title: spec.title,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        scope: typeof spec.scope === "object" ? ("column" in spec.scope ? "column" : "lookup") : spec.scope ?? "none",
        attributes: Object.entries(spec.on ?? {}).map(([name, attribute]) => ({ name, ...(attribute.ref === undefined ? { type: attribute.type } : { ref: attribute.ref }) })),
        own: spec.owner !== undefined,
        fields: spec.fields === true,
      })),
    };
  }

  @Get("references/:kind")
  @Authorize(can("access.catalog.read"))
  async references(ctx: HttpContext) {
    const kind = ctx.services.resolve(IAccessCatalog).referenceKind(String(ctx.params.kind ?? ""));
    if (kind === undefined) throw new NotFoundError();
    const limit = integer(ctx.query("limit"), "limit", 50, 1, 200);
    const offset = integer(ctx.query("offset"), "offset", 0, 0, 1_000_000);
    const scope: Scope = ctx.query("scope") ?? null;
    const items = await ctx.services.resolve(kind.type).search(ctx.query("search") ?? "", { scope }, { limit, offset });
    return { data: items };
  }
}

contextOnlyController(AccessCatalogController);

function integer(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new BadRequestError(`${name} must be an integer ${min}–${max}`);
  return value;
}
