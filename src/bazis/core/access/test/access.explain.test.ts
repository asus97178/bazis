import { expect, test } from "bun:test";
import {
  AccessModule,
  AccessPolicy,
  AttributeLookup,
  IAccess,
  PermissionSource,
  defineRoles,
  definePermissions,
  grantsToWhere,
  type AccessObject,
  type AccessValue,
  type Condition,
  type Grant,
  type Grants,
  type PermissionDeclarations,
  type PermissionsOf,
} from "@/core/access";
import { StaticAccessPolicy } from "@/core/access/testing";
import { Module, singletonValue } from "@/core/di";
import { LOGGER, type Logger } from "@/core/kernel";
import { createTestContainer } from "@/core/testing";

// ACCESS-001 v1.5: `Grant.id`, `explain` (§5.1), the fields a list may be filtered by (§4.4),
// an attribute on the column of the partition (§3).

class FolderLookup extends AttributeLookup {
  toColumn(values: readonly AccessValue[]) { return { column: "folderId", in: values }; }
}

class EmptySource extends PermissionSource {
  version(): number { return 1; }
  load(): PermissionDeclarations { return {}; }
}

const docPermissions = definePermissions({
  "docs.read": {
    title: "See documents",
    scope: { column: "spaceId" },
    on: { spaceId: { type: "string" }, total: { type: "number" }, status: { type: "string" }, urgent: { type: "boolean" }, folder: { type: "string", lookup: FolderLookup } },
    owner: "authorId",
    fields: true,
  },
  "docs.export": { title: "Export documents", scope: "request", fields: true },
  "docs.print": { title: "Print documents" },
});
declare module "@/core/access" {
  interface BazisPermissions extends PermissionsOf<typeof docPermissions> {}
  interface BazisPermissionSources { ext: true }
}

const logged: Readonly<Record<string, unknown>>[] = [];
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (_message, fields) => void logged.push(fields ?? {}),
  error: () => undefined,
};

async function accessWith(grants: Readonly<Record<string, Grants>>) {
  @Module({
    imports: [AccessModule],
    permissions: docPermissions,
    permissionSources: { ext: EmptySource },
    providers: [singletonValue(LOGGER, logger), singletonValue(AccessPolicy, new StaticAccessPolicy({ grants: { "user:7": grants }, otherwise: "all" }))],
  })
  class DocsModule {}
  const container = await createTestContainer(DocsModule);
  const scope = container.createScope();
  return scope.resolve(IAccess).as({ sub: "user:7" }, scope);
}

const doc = (values: Readonly<Record<string, unknown>> = {}): AccessObject => ({ scope: "s1", spaceId: "s1", total: 500, status: "open", urgent: false, folder: "f1", authorId: "7", ...values });

test("explain gives the answer of can for every kind of condition", async () => {
  const conditions: readonly Condition[] = [
    { status: { eq: "open" } },
    { status: { in: ["open", "sent"] } },
    { status: { notIn: ["closed"] } },
    { status: { isNull: true } },
    { status: { isNull: false } },
    { urgent: { eq: true } },
    { total: { eq: "500.00" } },
    { total: { gt: 500 } },
    { total: { gte: 500 } },
    { total: { lt: 500 } },
    { total: { lte: 500 } },
    { folder: { eq: "f1" } },
    { folder: { notIn: ["f1"] } },
    { own: true },
    { not: { own: true } },
    { all: [{ status: { eq: "open" } }, { total: { lt: 1000 } }] },
    { any: [{ status: { eq: "closed" } }, { total: { gt: 1000 } }] },
    { not: { total: { gt: 1000 } } },
    { all: [{ own: true }, { any: [{ urgent: { eq: true } }, { not: { status: { in: ["closed"] } } }] }] },
  ];
  const objects: readonly AccessObject[] = [
    doc(),
    doc({ status: "closed", total: "1000.01", urgent: true, folder: "f2", authorId: "8" }),
    doc({ status: null, total: null, urgent: null, folder: null, authorId: null }),
    { scope: "s1" },
    { scope: "s2" },
    doc({ scope: "s2" }),
    doc({ scope: ["s2", "s1"] }),
  ];
  const seen = new Set<string>();
  for (const where of conditions) {
    const access = await accessWith({ "docs.read": [{ scopes: ["s1"], where }] });
    for (const object of objects) {
      const allowed = await access.can("docs.read", object);
      const why = await access.explain("docs.read", object);
      const at = `${JSON.stringify(where)} on ${JSON.stringify(object)}`;
      expect(why.allowed, at).toBe(allowed);
      if (why.kind !== "grants") throw new Error(`grants expected: ${at}`);
      expect(why.grants, at).toHaveLength(1);
      const grant = why.grants[0]!;
      expect(grant.applies, at).toBe(allowed);
      expect(grant.applies, at).toBe(grant.scope === true && grant.where === true);
      seen.add(`${grant.scope}/${grant.where}`);
    }
  }
  // The cases cover every answer: the partition fits or not, the condition is true, false or unknown.
  expect([...seen].sort()).toEqual(["false/false", "false/true", "false/unknown", "true/false", "true/true", "true/unknown"]);
});

test("explain: every grant of the rights system in its order, with its id, its partition, its condition and its fields", async () => {
  logged.length = 0;
  const access = await accessWith({
    "docs.read": [
      { id: "rule:elsewhere", scopes: ["s2"], where: { status: { eq: "open" } } },
      { id: "rule:closed", scopes: ["s1"], where: { status: { eq: "closed" } }, fields: { read: ["title"] } },
      { id: "rule:broken", scopes: "all", where: { color: { eq: "red" } } } as Grant,
      { scopes: ["s1", null], where: { total: { lt: 1000 } }, fields: { read: ["title", "total"], write: ["title"] } },
      { id: "rule:mine", scopes: "all", where: { own: true } },
    ],
  });

  const why = await access.explain("docs.read", doc({ authorId: null, total: "999.99" }));
  expect(why).toEqual({
    allowed: true,
    kind: "grants",
    grants: [
      { id: "rule:elsewhere", scope: false, where: true, applies: false },
      { id: "rule:closed", scope: true, where: false, applies: false },
      { id: "rule:broken", problem: 'unknown attribute "color"', applies: false },
      { scope: true, where: true, applies: true, fields: { read: ["title", "total"], write: ["title"] } },
      { id: "rule:mine", scope: true, where: false, applies: false },
    ],
  });
  // A grant without field lists gives every field.
  const mine = await access.explain("docs.read", doc({ total: 5000 }));
  expect(mine.kind === "grants" && mine.grants[4]).toEqual({ id: "rule:mine", scope: true, where: true, applies: true, fields: { read: "all", write: "all" } });
  // Nothing fits: the answer of can, and the reason of every grant.
  const nothing = await access.explain("docs.read", doc({ total: null, authorId: "8" }));
  expect(nothing.allowed).toBe(false);
  expect(nothing.kind === "grants" && nothing.grants.map((grant) => grant.where)).toEqual([true, false, undefined, "unknown", false]);
  expect(await access.can("docs.read", doc({ total: null, authorId: "8" }))).toBe(false);

  // The warning about the dropped grant names it; it is written once per request.
  expect(logged).toEqual([{ permission: "docs.read", subject: "user:7", problem: 'unknown attribute "color"', grant: "rule:broken" }]);
});

test("explain: a superuser, no grants, a permission of a source that does not exist, an object without its partition", async () => {
  const access = await accessWith({ "docs.read": [], "docs.print": [{ scopes: [null] }, { scopes: ["s1"] }] });
  // `otherwise: "all"` of the policy answers for docs.export.
  expect(await access.explain("docs.export", { scope: "s1" })).toEqual({ allowed: true, kind: "all" });
  expect(await access.explain("docs.read", doc())).toEqual({ allowed: false, kind: "grants", grants: [] });
  // A permission without a partition: the object is in `null`; no field lists — no `fields` in the answer.
  expect(await access.explain("docs.print", {})).toEqual({ allowed: true, kind: "grants", grants: [{ scope: true, where: true, applies: true }, { scope: false, where: true, applies: false }] });
  // The policy says "all", but the source does not give the key: nobody has it.
  expect(await access.explain("ext.orders.read", {})).toEqual({ allowed: false, kind: "absent" });
  expect(await access.can("ext.orders.read", {})).toBe(false);
  await expect(access.explain("docs.read", { status: "open" })).rejects.toThrow('can("docs.read") needs the object\'s partition: pass { scope }.');
});

test("the default rights system names the role in the id of a grant", async () => {
  @Module({
    imports: [AccessModule],
    permissions: docPermissions,
    permissionSources: { ext: EmptySource },
    roles: defineRoles({ reader: ["docs.read:own", { permission: "docs.read", scopes: ["s1"], where: { status: { eq: "open" } } }], printer: ["docs.print"] }),
  })
  class RolesModule {}
  const container = await createTestContainer(RolesModule);
  const scope = container.createScope();
  const access = scope.resolve(IAccess).as({ sub: "staff:7", id: "7", roles: ["printer", "reader", "ghost"] } as never, scope);
  expect(await access.explain("docs.read", doc({ authorId: "8" }))).toEqual({
    allowed: true,
    kind: "grants",
    grants: [
      { id: "role:reader", scope: true, where: false, applies: false },
      { id: "role:reader", scope: true, where: true, applies: true, fields: { read: "all", write: "all" } },
    ],
  });
  expect(await access.explain("docs.print", {})).toEqual({ allowed: true, kind: "grants", grants: [{ id: "role:printer", scope: true, where: true, applies: true }] });
});

test("filterableFields: the fields the subject reads by every grant", async () => {
  const fields = async (grants: Grants, permission: "docs.read" | "docs.print" = "docs.read") => await (await accessWith({ [permission]: grants })).filterableFields(permission);
  expect(await fields([{ scopes: "all", fields: { read: ["title", "total", "status"] } }, { scopes: ["s1"], fields: { read: ["status", "title", "note"] } }])).toEqual(["title", "status"]);
  // A grant without field lists, with `read: "all"` or with `write` only reads everything: it does not narrow.
  expect(await fields([{ scopes: "all" }, { scopes: "all", fields: { read: "all" } }, { scopes: "all", fields: { write: ["title"] } }])).toBe("all");
  expect(await fields([{ scopes: "all" }, { scopes: "all", fields: { read: ["title", "title"] } }])).toEqual(["title"]);
  // A field closed in one grant is closed for the list, whatever the other grants give.
  expect(await fields([{ scopes: "all", fields: { read: ["title"] } }, { scopes: "all", fields: { read: ["total"] } }])).toEqual([]);
  expect(await fields([{ scopes: "all", fields: { read: [] } }, { scopes: "all" }])).toEqual([]);
  expect(await fields([])).toEqual([]);
  expect(await fields("all")).toBe("all");
  // A dropped grant does not count.
  expect(await fields([{ scopes: "all", fields: { read: ["title"] } }, { scopes: "all", where: { color: { eq: "red" } }, fields: { read: ["total"] } } as Grant])).toEqual(["title"]);
  // A permission without field lists: every field, even without grants.
  expect(await fields([{ scopes: "all" }], "docs.print")).toBe("all");
  expect(await fields([], "docs.print")).toBe("all");

  const access = await accessWith({ "docs.export": [{ scopes: ["s1"], fields: { read: ["title", "total"] } }, { scopes: ["s2"], fields: { read: ["title"] } }, { scopes: "all", fields: { read: ["total", "title", "note"] } }] });
  // `scope: "request"`: only the grants of the partition of the request count.
  expect(await access.filterableFields("docs.export", { scope: "s1" })).toEqual(["title", "total"]);
  expect(await access.filterableFields("docs.export", { scope: "s2" })).toEqual(["title"]);
  expect(await access.filterableFields("docs.export", { scope: "s3" })).toEqual(["total", "title", "note"]);
  await expect(access.filterableFields("docs.export")).rejects.toThrow('The fields of the list of "docs.export" need the partition of the request: filterableFields(permission, { scope }).');
  expect(await (await accessWith({ "docs.export": [{ scopes: ["s1"] }] })).filterableFields("docs.export", { scope: "s2" })).toEqual([]);
  expect(await access.filterableFields("ext.orders.read")).toEqual([]);
});

test("an attribute on the column of the partition: the partition says where the grant acts, the condition narrows it", async () => {
  const access = await accessWith({ "docs.read": [{ scopes: ["s1", "s2"], where: { spaceId: { in: ["s2", "s3"] } } }] });
  expect(await access.can("docs.read", doc({ scope: "s2", spaceId: "s2" }))).toBe(true);
  expect(await access.can("docs.read", doc({ scope: "s1", spaceId: "s1" }))).toBe(false);
  expect(await access.can("docs.read", doc({ scope: "s3", spaceId: "s3" }))).toBe(false);
  // The object has values under the names of attributes: without `spaceId` the condition is unknown.
  expect(await access.explain("docs.read", { scope: "s2" })).toEqual({ allowed: false, kind: "grants", grants: [{ scope: true, where: "unknown", applies: false }] });
  const filter = await access.filter("docs.read");
  expect(filter).toEqual({ kind: "where", where: { all: [{ column: "spaceId", in: ["s1", "s2"] }, { column: "spaceId", in: ["s2", "s3"] }] } });
  expect(grantsToWhere(filter)).not.toBeString();
});
