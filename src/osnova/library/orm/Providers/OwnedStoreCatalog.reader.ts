import { types } from "node:util";
import type { Row, SqlParam } from "./types";
import { failure } from "./ormOwnedStoreRuntime";
import { canonicalPostgresType, canonicalPostgresDefault, canonicalPostgresCheck, exactPostgresType } from "./PostgresSchema.decoder";
import type { OrmCatalogScopeV1 } from "../Schema/OrmOwnedStore";
import type { OwnedCatalogArrayTypeV1, OwnedCatalogClassV1, OwnedCatalogColumnV1, OwnedCatalogConstraintV1, OwnedCatalogDependencyV1, OwnedCatalogIndexV1, OwnedCatalogInheritanceV1, OwnedCatalogPolicyV1, OwnedCatalogRelationV1, OwnedCatalogRowTypeV1, OwnedCatalogRuleV1, OwnedCatalogSequenceV1, OwnedCatalogTriggerV1, OwnedStoreCatalogSnapshotV1, OwnedStoreRegistryRowV1, OwnedStoreRegistryShapeV1, OwnedStoreRegistrySnapshotV1 } from "../Schema/OwnedStoreCatalog";

interface OwnedStoreConstraintParentV1 { readonly value: OwnedCatalogConstraintV1; readonly widths: readonly [number, number, number, number, number, number]; }

/** Read-only capability: the provider retains the reservation and admission state. */
export interface OwnedStoreCatalogSource {
  query(sql: string, params: readonly SqlParam[], operation: "registry-read" | "catalog-read"): Promise<unknown>;
  assertActive(): void;
  unavailable(): never;
  drift(): never;
}

/** Builds bounded catalog snapshots; it never owns a connection or a transaction. */
export class OwnedStoreCatalogReader {
  public constructor(private readonly source: OwnedStoreCatalogSource) {}

  public async readRegistry(): Promise<OwnedStoreRegistrySnapshotV1> {
    const publicResult = await this.source.query("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace AS n WHERE n.nspname = 'public') AS public_schema_exists", [], "registry-read");
    this.source.assertActive();
    const publicRows = selectOwnedStoreRows(publicResult, ["public_schema_exists"], 1);
    const publicSchemaExists = publicRows?.[0]?.public_schema_exists;
    if (!publicRows || typeof publicSchemaExists !== "boolean" || publicRows.length !== 1) { this.source.unavailable(); }
    const rootResult = await this.source.query("SELECT c.oid::pg_catalog.text AS relation_oid FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = '__osnova_orm_owned_stores_v1'", [], "registry-read");
    this.source.assertActive();
    const roots = selectOwnedStoreRows(rootResult, ["relation_oid"], 1);
    if (!roots || (roots.length === 1 && typeof roots[0]!.relation_oid !== "string")) { this.source.unavailable(); }
    if (roots.length === 0) return Object.freeze({ contract: "osnova.orm-owned-store-registry-snapshot/v1", publicSchemaExists, state: Object.freeze({ kind: "absent" as const }) });
    const rootOid = roots[0]!.relation_oid;
    if (!this.oid(rootOid) || !publicSchemaExists) { this.source.drift(); }
    const budget = { remaining: 65536 };
    const rootsGraph = await this.readRelations([rootOid], "registry-read", budget);
    const root = rootsGraph[0];
    if (!root || root.schema !== "public" || root.name !== "__osnova_orm_owned_stores_v1" || root.kind !== "ordinaryTable" || root.rawKind !== "r" || root.rowTypeOid === null) { this.source.drift(); }
    const graph = await this.readRelationGraph(rootsGraph, "registry-read", budget);
    const knownClasses = await this.readCatalogClasses("registry-read");
    const ledger = await this.readDependencyLedger(graph, knownClasses, "registry-read", budget);
    const shape = this.registryShape(root, graph, ledger);
    const rows = await this.readRegistryRows();
    return Object.freeze({ contract: "osnova.orm-owned-store-registry-snapshot/v1", publicSchemaExists, state: Object.freeze({ kind: "present" as const, shape, rows }) });
  }

  private async readRegistryRows(): Promise<readonly OwnedStoreRegistryRowV1[]> {
    const aliases = ["store_key", "contract", "format_version", "owned_schema", "table_prefix", "owned_scope_hash", "model_hash", "created_at_epoch_microseconds"] as const;
    const result = await this.source.query("SELECT store_key,contract,format_version::pg_catalog.text AS format_version,owned_schema,table_prefix,owned_scope_hash,model_hash,pg_catalog.floor(EXTRACT(epoch FROM created_at)*1000000)::pg_catalog.numeric(19,0)::pg_catalog.text AS created_at_epoch_microseconds FROM \"public\".\"__osnova_orm_owned_stores_v1\" ORDER BY pg_catalog.convert_to(store_key,'UTF8') LIMIT 4097", [], "registry-read");
    const rows = selectOwnedStoreRows(result, aliases, 4097);
    if (!rows) { this.source.unavailable(); }
    this.wireRows(rows as readonly Row[], aliases);
    if (rows.length === 4097) { this.source.drift(); }
    const output: OwnedStoreRegistryRowV1[] = [];
    for (const row of rows) {
      if (!aliases.every(alias => typeof row[alias] === "string")) { this.source.unavailable(); }
      const formatVersion = row.format_version as string, epoch = row.created_at_epoch_microseconds as string;
      if (!/^[1-9][0-9]*$/u.test(formatVersion) || BigInt(formatVersion) > BigInt(Number.MAX_SAFE_INTEGER) || !/^(?:0|[1-9][0-9]*)$/u.test(epoch) || BigInt(epoch) > 8640000000000000000n) { this.source.drift(); }
      const contract = row.contract as string;
      if (contract !== "osnova.orm-owned-store/v1") { this.source.drift(); }
      output.push(Object.freeze({ storeKey: row.store_key as string, contract, formatVersion, ownedSchema: row.owned_schema as string, tablePrefix: row.table_prefix as string, ownedScopeHash: row.owned_scope_hash as OwnedStoreRegistryRowV1["ownedScopeHash"], modelHash: row.model_hash as OwnedStoreRegistryRowV1["modelHash"], createdAtEpochMicroseconds: epoch }));
    }
    output.sort((left, right) => Buffer.compare(Buffer.from(left.storeKey, "utf8"), Buffer.from(right.storeKey, "utf8")));
    return Object.freeze(output);
  }

  private registryShape(root: OwnedCatalogRelationV1, graph: Readonly<Omit<OwnedStoreCatalogSnapshotV1, "contract" | "requestedScopes" | "existingSchemas" | "catalogClasses" | "dependencies">>, ledger: Readonly<Pick<OwnedStoreCatalogSnapshotV1, "catalogClasses" | "dependencies">>): OwnedStoreRegistryShapeV1 {
    const drift = (): never => { this.source.drift(); };
    if (root.kind !== "ordinaryTable" || graph.rowTypes.length !== 1 || graph.arrayTypes.length !== 1) drift();
    const rowType = graph.rowTypes[0]!, arrayType = graph.arrayTypes[0]!;
    if (root.rowTypeOid !== rowType.oid || rowType.relationOid !== root.oid || rowType.arrayTypeOid !== arrayType.oid || arrayType.elementTypeOid !== rowType.oid) drift();
    const byOid = new Map(graph.relations.map(value => [value.oid, value]));
    const relationFor = (oid: string): OwnedCatalogRelationV1 => byOid.get(oid) ?? drift();
    const sort = (values: readonly OwnedCatalogRelationV1[]) => Object.freeze([...values].sort((left, right) => BigInt(left.oid) < BigInt(right.oid) ? -1 : BigInt(left.oid) > BigInt(right.oid) ? 1 : 0));
    const toast = root.toastRelationOid === null ? null : relationFor(root.toastRelationOid);
    if (toast !== null && toast.kind !== "toastTable") drift();
    const rootIndexes = graph.indexes.filter(value => value.tableRelationOid === root.oid);
    const toastIndexes = toast === null ? [] : graph.indexes.filter(value => value.tableRelationOid === toast.oid);
    if (graph.indexes.length !== rootIndexes.length + toastIndexes.length || graph.columns.some(value => value.relationOid !== root.oid && value.relationOid !== toast?.oid)) drift();
    const rootIndexRelations = sort(rootIndexes.map(value => relationFor(value.indexRelationOid)));
    const toastIndexRelations = sort(toastIndexes.map(value => relationFor(value.indexRelationOid)));
    const represented = new Set<string>([root.oid, ...rootIndexRelations.map(value => value.oid), ...(toast === null ? [] : [toast.oid, ...toastIndexRelations.map(value => value.oid)])]);
    if (graph.relations.length !== represented.size || graph.relations.some(value => !represented.has(value.oid))) drift();
    const pgClass = ledger.catalogClasses.find(value => value.kind === "pg_class")?.oid ?? drift();
    const toastIds = new Set(toast === null ? [] : [toast.oid, ...toastIndexRelations.map(value => value.oid)]);
    const nested: OwnedCatalogDependencyV1[] = [], outer: OwnedCatalogDependencyV1[] = [];
    for (const value of ledger.dependencies) (value.dependentClassOid === pgClass && toastIds.has(value.dependentOid) ? nested : outer).push(value);
    const columns = Object.freeze(graph.columns.filter(value => value.relationOid === root.oid));
    const shape: OwnedStoreRegistryShapeV1 = Object.freeze({ catalogClasses: ledger.catalogClasses, relation: root, rowType, arrayType, columns, indexes: Object.freeze(rootIndexes), indexRelations: rootIndexRelations, constraints: graph.constraints, triggers: graph.triggers, rules: graph.rules, policies: graph.policies, inheritance: graph.inheritance, dependencies: Object.freeze(outer), sequences: graph.sequences, toast: toast === null ? null : Object.freeze({ ownerTableOid: root.oid, relation: toast, columns: Object.freeze(graph.columns.filter(value => value.relationOid === toast.oid)), indexes: Object.freeze(toastIndexes), indexRelations: toastIndexRelations, dependencies: Object.freeze(nested) }) });
    return shape;
  }

  public async readCatalog(scopes: readonly OrmCatalogScopeV1[]): Promise<OwnedStoreCatalogSnapshotV1> {
    const requestedScopes = this.catalogScopes(scopes);
    const existingSchemas: string[] = [];
    for (let offset = 0; offset < requestedScopes.length; offset += 512) {
      const batch = requestedScopes.slice(offset, offset + 512), values: string[] = [];
      const rows = batch.map((scope, index) => { values.push(scope.schema, scope.tablePrefix); const first = index * 2 + 1; return `($${first}::pg_catalog.text,$${first + 1}::pg_catalog.text)`; }).join(",");
      const result = await this.source.query(`WITH requested(schema_name, table_prefix) AS (VALUES ${rows}) SELECT n.nspname AS schema_name FROM pg_catalog.pg_namespace AS n WHERE EXISTS (SELECT 1 FROM requested AS r WHERE r.schema_name = n.nspname) ORDER BY pg_catalog.convert_to(n.nspname, 'UTF8') LIMIT 513`, values, "catalog-read");
      const selected = selectOwnedStoreRows(result, ["schema_name"], 513);
      if (!selected) { this.source.unavailable(); }
      this.wireRows(selected as readonly Row[], ["schema_name"]);
      if (selected.length === 513) { this.source.drift(); }
      const batchSchemas = new Set<string>();
      for (const row of selected) {
        if (typeof row.schema_name !== "string") { this.source.unavailable(); }
        if (!batch.some(scope => scope.schema === row.schema_name) || batchSchemas.has(row.schema_name)) { this.source.drift(); }
        batchSchemas.add(row.schema_name);
        if (!existingSchemas.includes(row.schema_name)) existingSchemas.push(row.schema_name);
      }
    }
    existingSchemas.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    const budget = { remaining: 65536 };
    const roots = await this.readCatalogueRoots(requestedScopes, budget);
    const graph = await this.readRelationGraph(roots, "catalog-read", budget);
    const knownClasses = await this.readCatalogClasses("catalog-read");
    const ledger = await this.readDependencyLedger(graph, knownClasses, "catalog-read", budget);
    return Object.freeze({ contract: "osnova.orm-owned-store-catalog-snapshot/v1", requestedScopes, existingSchemas: Object.freeze(existingSchemas), ...graph, ...ledger });
  }

  private chargeRecords(budget: { remaining: number }, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > budget.remaining) { this.source.drift(); }
    budget.remaining -= count;
  }

  private async readRelationGraph(roots: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<Readonly<Omit<OwnedStoreCatalogSnapshotV1, "contract" | "requestedScopes" | "existingSchemas" | "catalogClasses" | "dependencies">>> {
    const drift = (): never => { this.source.drift(); };
    const compareOid = (left: string, right: string): number => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
    const compareText = (left: string, right: string): number => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
    const relationsByOid = new Map(roots.map(relation => [relation.oid, relation]));
    const toastOwners = new Map<string, string>();
    for (const relation of roots) if (relation.toastRelationOid !== null) {
      if (toastOwners.has(relation.toastRelationOid)) drift();
      toastOwners.set(relation.toastRelationOid, relation.oid);
    }
    const declaredToasts = await this.readRelations([...toastOwners.keys()].filter(oid => !relationsByOid.has(oid)), operation, budget);
    for (const relation of declaredToasts) relationsByOid.set(relation.oid, relation);
    for (const oid of toastOwners.keys()) if (relationsByOid.get(oid)?.kind !== "toastTable") drift();
    const attachmentRelations = Object.freeze([...roots, ...declaredToasts]);
    const eligibleToastOids = new Set(roots.filter(relation => relation.kind === "ordinaryTable").flatMap(relation => relation.toastRelationOid === null ? [] : [relation.toastRelationOid]));
    const columns = await this.readColumns(attachmentRelations.filter(relation => relation.kind === "ordinaryTable" || eligibleToastOids.has(relation.oid)), operation, budget);
    const indexes = await this.readIndexes(attachmentRelations, operation, budget);
    const discoveredIndexes = await this.readRelations(indexes.map(index => index.indexRelationOid).filter(oid => !relationsByOid.has(oid)), operation, budget);
    for (const relation of discoveredIndexes) relationsByOid.set(relation.oid, relation);
    for (const index of indexes) {
      const relation = relationsByOid.get(index.indexRelationOid);
      if ((relation?.kind !== "index" && relation?.kind !== "partitionedIndex") || relation.name !== index.name) drift();
    }
    let relations = Object.freeze([...attachmentRelations, ...discoveredIndexes]);
    if (columns.some(column => column.identityCode !== "")) {
      const pgClassOid = await this.readPgClassOid(operation);
      const identitySequenceOids = await this.readIdentitySequenceOids(columns, pgClassOid, operation);
      const discoveredSequences = await this.readRelations(identitySequenceOids.filter(oid => !relationsByOid.has(oid)), operation, budget);
      for (const relation of discoveredSequences) relationsByOid.set(relation.oid, relation);
      for (const oid of identitySequenceOids) if (relationsByOid.get(oid)?.kind !== "sequence") drift();
      relations = Object.freeze([...relations, ...discoveredSequences]);
    }
    const [rowTypes, arrayTypes] = await this.readRelationTypes(relations, operation, budget);
    const constraintParents = await this.readConstraintParents(relations, operation, budget);
    const constraintVectors = await this.readConstraintVectors(constraintParents, operation);
    const constraints = await this.readForeignKeyDefaultEquality(constraintVectors, operation);
    const triggers = await this.readTriggers(relations, constraints, operation, budget);
    const rules = await this.readRules(relations, operation, budget);
    const policies = await this.readPolicies(relations, operation, budget);
    const inheritance = await this.readInheritance(relations, operation, budget);
    const sequences = await this.readSequences(relations, operation, budget);
    return Object.freeze({
      relations: Object.freeze([...relations].sort((left, right) => compareText(left.schema, right.schema) || compareText(left.name, right.name) || compareOid(left.oid, right.oid))),
      rowTypes: Object.freeze([...rowTypes].sort((left, right) => compareOid(left.oid, right.oid))),
      arrayTypes: Object.freeze([...arrayTypes].sort((left, right) => compareOid(left.oid, right.oid))),
      columns: Object.freeze([...columns].sort((left, right) => compareOid(left.relationOid, right.relationOid) || compareOid(left.attnum, right.attnum))),
      indexes: Object.freeze([...indexes].sort((left, right) => compareOid(left.tableRelationOid, right.tableRelationOid) || compareOid(left.indexRelationOid, right.indexRelationOid))),
      constraints: Object.freeze([...constraints].sort((left, right) => compareOid(left.relationOid, right.relationOid) || compareText(left.name, right.name) || compareOid(left.oid, right.oid))),
      triggers: Object.freeze([...triggers].sort((left, right) => compareOid(left.relationOid, right.relationOid) || compareText(left.name, right.name) || compareOid(left.oid, right.oid))),
      rules: Object.freeze([...rules].sort((left, right) => compareOid(left.relationOid, right.relationOid) || compareText(left.name, right.name) || compareOid(left.oid, right.oid))),
      policies: Object.freeze([...policies].sort((left, right) => compareOid(left.relationOid, right.relationOid) || compareText(left.name, right.name) || compareOid(left.oid, right.oid))),
      inheritance: Object.freeze([...inheritance].sort((left, right) => compareOid(left.childRelationOid, right.childRelationOid) || compareOid(left.parentRelationOid, right.parentRelationOid) || compareOid(left.sequence, right.sequence))),
      sequences: Object.freeze([...sequences].sort((left, right) => compareOid(left.relationOid, right.relationOid))),
    });
  }

  private async readCatalogClasses(operation: "registry-read" | "catalog-read", optionalOids?: readonly string[]): Promise<readonly OwnedCatalogClassV1[]> {
    const aliases = ["class_oid", "class_schema", "class_name"] as const;
    const drift = (): never => { this.source.drift(); };
    const map = (rows: readonly Row[], issued?: ReadonlySet<string>): readonly OwnedCatalogClassV1[] => {
      this.wireRows(rows, aliases);
      const output: OwnedCatalogClassV1[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const oid = row.class_oid as string;
        const schema = row.class_schema as string;
        const name = row.class_name as string;
        if (!this.oid(oid) || seen.has(oid) || (issued !== undefined && !issued.has(oid))) drift();
        seen.add(oid);
        const kind = schema === "pg_catalog"
          ? new Map<string, OwnedCatalogClassV1["kind"]>([["pg_class", "pg_class"], ["pg_type", "pg_type"], ["pg_constraint", "pg_constraint"], ["pg_proc", "pg_proc"], ["pg_rewrite", "pg_rewrite"], ["pg_namespace", "pg_namespace"], ["pg_attrdef", "pg_attrdef"], ["pg_trigger", "pg_trigger"]]).get(name) ?? "other"
          : "other";
        output.push(Object.freeze({ oid, schema: schema === "pg_catalog" ? "pg_catalog" : "other", name, kind }));
      }
      if (issued !== undefined && seen.size !== issued.size) drift();
      return Object.freeze(output.sort((left, right) => BigInt(left.oid) < BigInt(right.oid) ? -1 : BigInt(left.oid) > BigInt(right.oid) ? 1 : 0));
    };
    if (optionalOids !== undefined) {
      if (!optionalOids.length) return Object.freeze([]);
      const output: OwnedCatalogClassV1[] = [];
      for (let offset = 0; offset < optionalOids.length; offset += 1024) {
        const batch = optionalOids.slice(offset, offset + 1024);
        const result = await this.source.query("SELECT c.oid::pg_catalog.text AS class_oid,n.nspname AS class_schema,c.relname AS class_name FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace WHERE c.oid=ANY($1::pg_catalog.oid[]) ORDER BY c.oid LIMIT " + (batch.length + 1), [this.encodePgOidArrayParameter(batch)], operation);
        const rows = selectOwnedStoreRows(result, aliases, batch.length + 1);
        if (!rows) { this.source.unavailable(); }
        const captured = map(rows as readonly Row[], new Set(batch));
        if (rows.length === batch.length + 1) drift();
        output.push(...captured);
      }
      if (output.length !== optionalOids.length || new Set(output.map(value => value.oid)).size !== output.length) drift();
      return Object.freeze(output.sort((left, right) => BigInt(left.oid) < BigInt(right.oid) ? -1 : BigInt(left.oid) > BigInt(right.oid) ? 1 : 0));
    }
    const names = ["pg_class", "pg_type", "pg_constraint", "pg_proc", "pg_rewrite", "pg_namespace", "pg_attrdef", "pg_trigger", "pg_policy"] as const;
    const result = await this.source.query("WITH requested(class_name) AS (VALUES ('pg_class'::pg_catalog.text),('pg_type'::pg_catalog.text),('pg_constraint'::pg_catalog.text),('pg_proc'::pg_catalog.text),('pg_rewrite'::pg_catalog.text),('pg_namespace'::pg_catalog.text),('pg_attrdef'::pg_catalog.text),('pg_trigger'::pg_catalog.text),('pg_policy'::pg_catalog.text)) SELECT c.oid::pg_catalog.text AS class_oid,n.nspname AS class_schema,c.relname AS class_name FROM requested AS r JOIN pg_catalog.pg_class AS c ON c.relname=r.class_name JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace WHERE n.nspname='pg_catalog'::pg_catalog.name ORDER BY c.relname,c.oid LIMIT 10", [], operation);
    const rows = selectOwnedStoreRows(result, aliases, 10);
    if (!rows) { this.source.unavailable(); }
    const captured = map(rows as readonly Row[]);
    if (rows.length !== names.length) drift();
    if (new Set(captured.map(value => value.name)).size !== names.length || names.some(name => !captured.some(value => value.schema === "pg_catalog" && value.name === name))) drift();
    return captured;
  }

  private async readDependencyLedger(graph: Readonly<Omit<OwnedStoreCatalogSnapshotV1, "contract" | "requestedScopes" | "existingSchemas" | "catalogClasses" | "dependencies">>, knownClasses: readonly OwnedCatalogClassV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<Readonly<Pick<OwnedStoreCatalogSnapshotV1, "dependencies" | "catalogClasses">>> {
    const drift = (): never => { this.source.drift(); };
    const lock = (): never => { this.source.unavailable(); };
    if (!Number.isSafeInteger(budget.remaining) || budget.remaining < 0 || budget.remaining > 65536) drift();
    const knownByName = new Map<string, OwnedCatalogClassV1>();
    const knownByOid = new Map<string, OwnedCatalogClassV1>();
    for (const entry of knownClasses) {
      if (knownByName.has(entry.name) || knownByOid.has(entry.oid)) drift();
      knownByName.set(entry.name, entry);
      knownByOid.set(entry.oid, entry);
    }
    const classOid = (name: string): string => {
      const entry = knownByName.get(name) ?? drift();
      if (entry.schema !== "pg_catalog") drift();
      return entry.oid;
    };
    const pgClass = classOid("pg_class"), pgType = classOid("pg_type"), pgConstraint = classOid("pg_constraint"), pgAttrdef = classOid("pg_attrdef"), pgTrigger = classOid("pg_trigger"), pgRewrite = classOid("pg_rewrite"), pgPolicy = classOid("pg_policy");
    const seeds = new Map<string, readonly [string, string]>();
    const seed = (classOid: string, objectOid: string): void => {
      if (!this.oid(classOid) || !this.oid(objectOid)) drift();
      seeds.set(`${classOid}:${objectOid}`, Object.freeze([classOid, objectOid]));
    };
    for (const relation of graph.relations) seed(pgClass, relation.oid);
    for (const type of graph.rowTypes) seed(pgType, type.oid);
    for (const type of graph.arrayTypes) seed(pgType, type.oid);
    for (const column of graph.columns) if (column.defaultObjectOid !== null) seed(pgAttrdef, column.defaultObjectOid);
    for (const constraint of graph.constraints) seed(pgConstraint, constraint.oid);
    for (const trigger of graph.triggers) seed(pgTrigger, trigger.oid);
    for (const rule of graph.rules) seed(pgRewrite, rule.oid);
    for (const policy of graph.policies) seed(pgPolicy, policy.oid);
    const seedPairs = [...seeds.values()].sort((left, right) => BigInt(left[0]) < BigInt(right[0]) ? -1 : BigInt(left[0]) > BigInt(right[0]) ? 1 : BigInt(left[1]) < BigInt(right[1]) ? -1 : BigInt(left[1]) > BigInt(right[1]) ? 1 : 0);
    if (seedPairs.length > 65536) drift();
    const baseClassOids = new Set<string>();
    for (const name of operation === "catalog-read" ? ["pg_class", "pg_type", "pg_constraint", "pg_namespace", "pg_attrdef"] : ["pg_class", "pg_type", "pg_constraint", "pg_namespace"]) baseClassOids.add(classOid(name));
    if (graph.constraints.some(constraint => constraint.kind === "foreignKey") || graph.triggers.length) { baseClassOids.add(classOid("pg_proc")); baseClassOids.add(classOid("pg_trigger")); }
    for (const pair of seedPairs) baseClassOids.add(pair[0]);
    this.chargeRecords(budget, baseClassOids.size);
    const aliases = ["dependent_class_oid", "dependent_oid", "dependent_sub_id", "referenced_class_oid", "referenced_oid", "referenced_sub_id", "dependency_type"] as const;
    const rows: Row[] = [];
    if (seedPairs.length) {
      const parameters: string[] = [], branches: string[] = [];
      for (let offset = 0; offset < seedPairs.length; offset += 1024) {
        const batch = seedPairs.slice(offset, offset + 1024);
        const classIds = batch.map(pair => pair[0]), objectIds = batch.map(pair => pair[1]);
        parameters.push(this.encodePgOidArrayParameter(classIds), this.encodePgOidArrayParameter(objectIds));
        const position = parameters.length - 1;
        branches.push(`SELECT pair.classid,pair.objid FROM ROWS FROM (pg_catalog.unnest($${position}::pg_catalog.oid[]),pg_catalog.unnest($${position + 1}::pg_catalog.oid[])) WITH ORDINALITY AS pair(classid,objid,ordinality)`);
      }
      if (branches.length > 64) drift();
      const issuedLimit = budget.remaining + 1;
      const result = await this.source.query(`WITH seeds(classid,objid) AS (${branches.join(" UNION ALL ")}) SELECT d.classid::pg_catalog.text AS dependent_class_oid,d.objid::pg_catalog.text AS dependent_oid,d.objsubid::pg_catalog.text AS dependent_sub_id,d.refclassid::pg_catalog.text AS referenced_class_oid,d.refobjid::pg_catalog.text AS referenced_oid,d.refobjsubid::pg_catalog.text AS referenced_sub_id,d.deptype::pg_catalog.text AS dependency_type FROM pg_catalog.pg_depend AS d WHERE EXISTS (SELECT 1 FROM seeds AS s WHERE s.classid=d.classid AND s.objid=d.objid) OR EXISTS (SELECT 1 FROM seeds AS s WHERE s.classid=d.refclassid AND s.objid=d.refobjid) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype LIMIT ${issuedLimit}`, parameters, operation);
      const selected = selectOwnedStoreRows(result, aliases, issuedLimit);
      const selectedRows = selected ?? lock();
      this.wireRows(selectedRows as readonly Row[], aliases);
      this.chargeRecords(budget, selectedRows.length);
      rows.push(...selectedRows as Row[]);
    }
    const decimalSubId = (value: string): boolean => /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 2147483647n;
    const endpoints = new Set<string>();
    const dependencies: OwnedCatalogDependencyV1[] = [];
    for (const row of rows) {
      const dependentClassOid = row.dependent_class_oid as string, dependentOid = row.dependent_oid as string, dependentSubId = row.dependent_sub_id as string, referencedClassOid = row.referenced_class_oid as string, referencedOid = row.referenced_oid as string, referencedSubId = row.referenced_sub_id as string, dependencyType = row.dependency_type as string;
      if (![dependentClassOid, dependentOid, referencedClassOid, referencedOid].every(value => this.oid(value)) || !decimalSubId(dependentSubId) || !decimalSubId(referencedSubId)) drift();
      endpoints.add(dependentClassOid); endpoints.add(referencedClassOid);
      const kind = new Map<string, OwnedCatalogDependencyV1["kind"]>([["n", "normal"], ["a", "automatic"], ["i", "internal"], ["e", "extension"], ["P", "partitionPrimary"], ["S", "partitionSecondary"]]).get(dependencyType) ?? "other";
      dependencies.push(Object.freeze({ dependentClassOid, dependentOid, dependentSubId, referencedClassOid, referencedOid, referencedSubId, kind }));
    }
    const seededClassOids = new Set(seedPairs.map(pair => pair[0]));
    const unresolved = [...endpoints].filter(oid => !knownByOid.has(oid)).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
    const resolved = await this.readCatalogClasses(operation, unresolved);
    const emitted = new Map<string, OwnedCatalogClassV1>();
    for (const oid of baseClassOids) emitted.set(oid, knownByOid.get(oid) ?? drift());
    if (graph.constraints.some(constraint => constraint.kind === "foreignKey") || graph.triggers.length) for (const name of ["pg_proc", "pg_trigger"]) {
      const entry = knownByName.get(name) ?? drift();
      emitted.set(entry.oid, entry);
    }
    for (const oid of seededClassOids) {
      const entry = knownByOid.get(oid) ?? drift();
      emitted.set(oid, entry);
    }
    for (const oid of endpoints) {
      const entry = knownByOid.get(oid) ?? resolved.find(candidate => candidate.oid === oid) ?? drift();
      emitted.set(oid, entry);
    }
    for (const entry of resolved) emitted.set(entry.oid, entry);
    this.chargeRecords(budget, [...emitted.keys()].filter(oid => !baseClassOids.has(oid)).length);
    const compareOid = (left: string, right: string): number => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
    return Object.freeze({
      dependencies: Object.freeze([...dependencies].sort((left, right) => compareOid(left.dependentClassOid, right.dependentClassOid) || compareOid(left.dependentOid, right.dependentOid) || compareOid(left.dependentSubId, right.dependentSubId) || compareOid(left.referencedClassOid, right.referencedClassOid) || compareOid(left.referencedOid, right.referencedOid) || compareOid(left.referencedSubId, right.referencedSubId) || left.kind.localeCompare(right.kind))),
      catalogClasses: Object.freeze([...emitted.values()].sort((left, right) => compareOid(left.oid, right.oid))),
    });
  }

  private encodePgOidArrayParameter(values: readonly string[]): string {
    try {
      if (!Array.isArray(values) || types.isProxy(values) || values.length < 1 || values.length > 1024) throw new Error();
      const output: string[] = [];
      for (let index = 0; index < values.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !/^[1-9][0-9]*$/u.test(descriptor.value) || BigInt(descriptor.value) > 4294967295n) throw new Error();
        output.push(descriptor.value);
      }
      return `{${output.join(",")}}`;
    } catch { throw failure("ORM_OWNED_STORE_DRIFT"); }
  }

  private async readCatalogueRoots(scopes: readonly OrmCatalogScopeV1[], budget: { remaining: number }): Promise<readonly OwnedCatalogRelationV1[]> {
    const identities = new Set<string>();
    for (let offset = 0; offset < scopes.length; offset += 512) {
      const batch = scopes.slice(offset, offset + 512), params: string[] = [];
      const values = batch.map((scope, index) => { params.push(scope.schema, scope.tablePrefix); const first = index * 2 + 1; return `($${first}::pg_catalog.text,$${first + 1}::pg_catalog.text)`; }).join(",");
      const issuedLimit = budget.remaining + 1;
      const result = await this.source.query(`WITH requested(schema_name, table_prefix) AS (VALUES ${values}) SELECT c.oid::pg_catalog.text AS relation_oid FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace WHERE EXISTS (SELECT 1 FROM requested AS r WHERE r.schema_name=n.nspname AND pg_catalog.left(c.relname,pg_catalog.char_length(r.table_prefix))=r.table_prefix) ORDER BY c.oid LIMIT ${issuedLimit}`, params, "catalog-read");
      const rows = selectOwnedStoreRows(result, ["relation_oid"], issuedLimit);
      if (!rows) { this.source.unavailable(); }
      for (const row of rows) if (typeof row.relation_oid !== "string") { this.source.unavailable(); }
      if (rows.length === issuedLimit) { this.source.drift(); }
      for (const row of rows) { const oid = row.relation_oid as string; if (!this.oid(oid)) { this.source.drift(); } identities.add(oid); }
    }
    if (identities.size > budget.remaining) { this.source.drift(); }
    return this.readRelations([...identities], "catalog-read", budget);
  }

  private oid(value: unknown): value is string { return typeof value === "string" && /^[1-9][0-9]*$/u.test(value) && BigInt(value) <= 4294967295n; }

  private async readRelations(oids: readonly string[], operation: "registry-read" | "catalog-read" = "catalog-read", budget?: { remaining: number }): Promise<readonly OwnedCatalogRelationV1[]> {
    if (!oids.length) return Object.freeze([]);
    const out: OwnedCatalogRelationV1[] = [];
    for (let offset = 0; offset < oids.length; offset += 1024) {
      const batch = oids.slice(offset, offset + 1024), parameter = this.encodePgOidArrayParameter(batch), issuedLimit = budget ? Math.min(batch.length + 1, budget.remaining + 1) : 1025;
      const result = await this.source.query(`SELECT c.oid::pg_catalog.text AS oid,n.oid::pg_catalog.text AS namespace_oid,n.nspname AS schema_name,c.relname AS relation_name,c.relkind AS relkind,c.relpersistence AS relpersistence,c.relispartition AS relispartition,c.relrowsecurity AS relrowsecurity,c.relforcerowsecurity AS relforcerowsecurity,c.relreplident AS relreplident,c.reltablespace::pg_catalog.text AS tablespace_oid,am.amname AS access_method,c.reltype::pg_catalog.text AS row_type_oid,c.reltoastrelid::pg_catalog.text AS toast_relation_oid FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_am AS am ON am.oid=c.relam WHERE c.oid=ANY($1::pg_catalog.oid[]) ORDER BY c.oid LIMIT ${issuedLimit}`, [parameter], operation);
      const rows = selectOwnedStoreRows(result, ["oid","namespace_oid","schema_name","relation_name","relkind","relpersistence","relispartition","relrowsecurity","relforcerowsecurity","relreplident","tablespace_oid","access_method","row_type_oid","toast_relation_oid"], issuedLimit);
      if (!rows) { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], ["oid","namespace_oid","schema_name","relation_name","relkind","relpersistence","relispartition","relrowsecurity","relforcerowsecurity","relreplident","tablespace_oid","access_method","row_type_oid","toast_relation_oid"], ["relispartition","relrowsecurity","relforcerowsecurity"], ["access_method"]);
      if (budget) this.chargeRecords(budget, rows.length);
      if (rows.length > oids.slice(offset, offset + 1024).length) { this.source.drift(); }
      const issued = new Set(oids.slice(offset, offset + 1024));
      for (const row of rows) { const relation = this.relationRow(row); if (!issued.has(relation.oid)) { this.source.drift(); } out.push(relation); }
    }
    if (out.length !== oids.length || new Set(out.map(value => value.oid)).size !== out.length) { this.source.drift(); }
    return this.readRelationOptions(Object.freeze(out), operation);
  }

  private async readRelationOptions(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read"): Promise<readonly OwnedCatalogRelationV1[]> {
    if (!relations.length) return relations;
    const lengths = new Map<string, number>();
    for (let offset = 0; offset < relations.length; offset += 1024) {
      const batch = relations.slice(offset, offset + 1024), parameter = this.encodePgOidArrayParameter(batch.map(relation => relation.oid));
      const result = await this.source.query(`SELECT c.oid::pg_catalog.text AS relation_oid,COALESCE(pg_catalog.cardinality(c.reloptions),0)::pg_catalog.text AS option_count FROM pg_catalog.pg_class AS c WHERE c.oid=ANY($1::pg_catalog.oid[]) ORDER BY c.oid LIMIT 1025`, [parameter], operation);
      const rows = selectOwnedStoreRows(result, ["relation_oid","option_count"], 1025);
      if (!rows) { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], ["relation_oid","option_count"]);
      if (rows.length !== batch.length) { this.source.drift(); }
      const issued = new Set(batch.map(relation => relation.oid));
      for (const row of rows) {
        if (typeof row.relation_oid !== "string" || typeof row.option_count !== "string") { this.source.unavailable(); }
        if (!issued.has(row.relation_oid) || !/^(0|[1-9][0-9]*)$/u.test(row.option_count) || BigInt(row.option_count) > 65536n || lengths.has(row.relation_oid)) { this.source.drift(); }
        lengths.set(row.relation_oid, Number(row.option_count));
      }
    }
    const values = new Map<string, string[]>();
    const pending = relations.filter(relation => (lengths.get(relation.oid) ?? 0) !== 0);
    for (let offset = 0; offset < pending.length;) {
      const batch: OwnedCatalogRelationV1[] = []; let expected = 0;
      while (offset < pending.length && batch.length < 1024 && expected + (lengths.get(pending[offset]!.oid) ?? 0) <= 65536) { const relation = pending[offset++]!; batch.push(relation); expected += lengths.get(relation.oid)!; }
      if (!batch.length) { this.source.drift(); }
      const parameter = this.encodePgOidArrayParameter(batch.map(relation => relation.oid));
      const result = await this.source.query(`SELECT c.oid::pg_catalog.text AS relation_oid,u.ordinality::pg_catalog.text AS ordinality,u.option_value AS option_value FROM pg_catalog.pg_class AS c CROSS JOIN LATERAL pg_catalog.unnest(c.reloptions) WITH ORDINALITY AS u(option_value,ordinality) WHERE c.oid=ANY($1::pg_catalog.oid[]) ORDER BY c.oid,u.ordinality LIMIT ${expected + 1}`, [parameter], operation);
      const rows = selectOwnedStoreRows(result, ["relation_oid","ordinality","option_value"], expected + 1);
      if (!rows) { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], ["relation_oid","ordinality","option_value"]);
      if (rows.length === expected + 1) { this.source.drift(); }
      for (const row of rows) {
        if (typeof row.relation_oid !== "string" || typeof row.ordinality !== "string" || typeof row.option_value !== "string") { this.source.unavailable(); }
        const count = lengths.get(row.relation_oid), ordinal = /^(0|[1-9][0-9]*)$/u.test(row.ordinality) ? Number(row.ordinality) : NaN;
        if (count === undefined || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > count) { this.source.drift(); }
        const list = values.get(row.relation_oid) ?? []; if (list.length !== ordinal - 1) { this.source.drift(); }
        list.push(row.option_value); values.set(row.relation_oid, list);
      }
    }
    const result = relations.map(relation => {
      const options = values.get(relation.oid) ?? [];
      if (options.length !== lengths.get(relation.oid)) { this.source.drift(); }
      return Object.freeze({ ...relation, options: Object.freeze([...options]) });
    });
    return Object.freeze(result);
  }

  private relationRow(row: Row): OwnedCatalogRelationV1 {
    const text = (value: unknown): string => { if (typeof value !== "string") { this.source.unavailable(); } return value; };
    const oid = (value: unknown): string => { const result = text(value); if (!this.oid(result) && result !== "0") { this.source.drift(); } return result; };
    const rawKind = text(row.relkind), rawPersistence = text(row.relpersistence), rawIdentity = text(row.relreplident);
    if (typeof row.relispartition !== "boolean" || typeof row.relrowsecurity !== "boolean" || typeof row.relforcerowsecurity !== "boolean" || (row.access_method !== null && typeof row.access_method !== "string")) { this.source.unavailable(); }
    if (rawKind.length !== 1 || rawPersistence.length !== 1 || rawIdentity.length !== 1) { this.source.drift(); }
    const kind: OwnedCatalogRelationV1["kind"] = ({ r:"ordinaryTable",p:"partitionedTable",f:"foreignTable",v:"view",m:"materializedView",S:"sequence",i:"index",I:"partitionedIndex",t:"toastTable" } as Record<string, OwnedCatalogRelationV1["kind"]>)[rawKind] ?? "other";
    const persistence: OwnedCatalogRelationV1["persistence"] = ({ p:"permanent",u:"unlogged",t:"temporary" } as Record<string, OwnedCatalogRelationV1["persistence"]>)[rawPersistence] ?? "other";
    const replicaIdentity: OwnedCatalogRelationV1["replicaIdentity"] = ({ d:"default",n:"nothing",f:"full",i:"index" } as Record<string, OwnedCatalogRelationV1["replicaIdentity"]>)[rawIdentity] ?? "other";
    return Object.freeze({ oid: oid(row.oid), namespaceOid: oid(row.namespace_oid), schema: text(row.schema_name), name: text(row.relation_name), kind, rawKind, persistence, isPartition: row.relispartition, rowSecurity: row.relrowsecurity, forceRowSecurity: row.relforcerowsecurity, replicaIdentity, tablespaceOid: oid(row.tablespace_oid), accessMethod: row.access_method, options: Object.freeze([]), rowTypeOid: oid(row.row_type_oid) === "0" ? null : oid(row.row_type_oid), toastRelationOid: oid(row.toast_relation_oid) === "0" ? null : oid(row.toast_relation_oid) });
  }

  private async readRelationTypes(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly [readonly OwnedCatalogRowTypeV1[], readonly OwnedCatalogArrayTypeV1[]]> {
    const relationOids = relations.filter(relation => relation.rowTypeOid !== null).map(relation => relation.oid);
    if (!relationOids.length) return Object.freeze([Object.freeze([]), Object.freeze([])]);
    const rowTypes: OwnedCatalogRowTypeV1[] = [], arrayTypes: OwnedCatalogArrayTypeV1[] = [];
    for (let offset = 0; offset < relationOids.length; offset += 1024) {
    const batch = relationOids.slice(offset, offset + 1024), parameter = this.encodePgOidArrayParameter(batch), issuedLimit = Math.min(batch.length + 1, budget.remaining + 1);
    const result = await this.source.query(`SELECT t.oid::pg_catalog.text AS row_type_oid,t.typrelid::pg_catalog.text AS relation_oid,n.nspname AS schema_name,t.typname AS type_name,t.typtype AS typtype,a.oid::pg_catalog.text AS array_type_oid,a.typrelid::pg_catalog.text AS array_relation_oid,an.nspname AS array_schema_name,a.typname AS array_type_name,a.typtype AS array_typtype,a.typcategory AS array_typcategory,a.typelem::pg_catalog.text AS array_element_oid,a.typarray::pg_catalog.text AS array_array_oid FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid=t.typnamespace JOIN pg_catalog.pg_type AS a ON a.oid=t.typarray JOIN pg_catalog.pg_namespace AS an ON an.oid=a.typnamespace WHERE t.typrelid=ANY($1::pg_catalog.oid[]) ORDER BY t.typrelid LIMIT ${issuedLimit}`, [parameter], operation);
    const rows = selectOwnedStoreRows(result, ["row_type_oid","relation_oid","schema_name","type_name","typtype","array_type_oid","array_relation_oid","array_schema_name","array_type_name","array_typtype","array_typcategory","array_element_oid","array_array_oid"], issuedLimit);
    if (!rows) { this.source.unavailable(); }
    this.wireRows(rows as readonly Row[], ["row_type_oid","relation_oid","schema_name","type_name","typtype","array_type_oid","array_relation_oid","array_schema_name","array_type_name","array_typtype","array_typcategory","array_element_oid","array_array_oid"]);
    this.chargeRecords(budget, rows.length * 2);
    if (rows.length !== batch.length) { this.source.drift(); }
    const expected = new Map(batch.map(oid => [oid, relations.find(relation => relation.oid === oid)!]));
    for (const row of rows) {
      if (typeof row.row_type_oid !== "string" || typeof row.relation_oid !== "string" || typeof row.array_type_oid !== "string" || typeof row.array_relation_oid !== "string" || typeof row.array_array_oid !== "string" || typeof row.array_element_oid !== "string" || typeof row.schema_name !== "string" || typeof row.type_name !== "string" || typeof row.array_schema_name !== "string" || typeof row.array_type_name !== "string" || typeof row.typtype !== "string" || typeof row.array_typtype !== "string" || typeof row.array_typcategory !== "string") { this.source.unavailable(); }
      const relation = expected.get(row.relation_oid);
      if (!relation || relation.rowTypeOid !== row.row_type_oid || !this.oid(row.row_type_oid) || !this.oid(row.relation_oid) || !this.oid(row.array_type_oid) || row.array_relation_oid !== "0" || row.array_array_oid !== "0" || row.array_element_oid !== row.row_type_oid) { this.source.drift(); }
      expected.delete(row.relation_oid);
      rowTypes.push(Object.freeze({ oid: row.row_type_oid, relationOid: row.relation_oid, schema: row.schema_name, name: row.type_name, kind: row.typtype === "c" ? "composite" : "other", arrayTypeOid: row.array_type_oid }));
      arrayTypes.push(Object.freeze({ oid: row.array_type_oid, elementTypeOid: row.row_type_oid, relationOid: "0", arrayTypeOid: "0", schema: row.array_schema_name, name: row.array_type_name, kind: row.array_typtype === "b" ? "base" : "other", category: row.array_typcategory === "A" ? "array" : "other" }));
    }
    if (expected.size) { this.source.drift(); }
    }
    return Object.freeze([Object.freeze(rowTypes), Object.freeze(arrayTypes)]);
  }

  private async readColumns(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly OwnedCatalogColumnV1[]> {
    const relationOids = relations.filter(relation => relation.kind === "ordinaryTable" || relation.kind === "toastTable").map(relation => relation.oid);
    if (!relationOids.length) return Object.freeze([]);
    const output: OwnedCatalogColumnV1[] = [], relationKinds = new Map(relations.map(relation => [relation.oid, relation.kind]));
    for (let offset = 0; offset < relationOids.length; offset += 1024) {
      const batch = relationOids.slice(offset, offset + 1024), parameter = this.encodePgOidArrayParameter(batch), issuedLimit = budget.remaining + 1;
      const result = await this.source.query(`SELECT a.attrelid::pg_catalog.text AS relation_oid,a.attnum::pg_catalog.text AS attnum,a.attname AS column_name,a.attisdropped AS dropped,a.attislocal AS local,a.attinhcount::pg_catalog.text AS inheritance_count,pg_catalog.format_type(a.atttypid,a.atttypmod) AS physical_type,a.atttypid::pg_catalog.text AS type_oid,a.attnotnull AS not_null,d.oid::pg_catalog.text AS default_object_oid,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression,a.attidentity AS identity_code,a.attgenerated AS generated_code,a.attcollation::pg_catalog.text AS collation_oid,t.typcollation::pg_catalog.text AS type_default_collation_oid,a.attstorage AS storage_code,t.typstorage AS type_default_storage_code,a.attcompression AS compression_code,a.atthasdef AS has_default FROM pg_catalog.pg_attribute AS a LEFT JOIN pg_catalog.pg_type AS t ON t.oid=a.atttypid LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=ANY($1::pg_catalog.oid[]) AND a.attnum>0 ORDER BY a.attrelid,a.attnum LIMIT ${issuedLimit}`, [parameter], operation);
      const rows = selectOwnedStoreRows(result, ["relation_oid","attnum","column_name","dropped","local","inheritance_count","physical_type","type_oid","not_null","default_object_oid","default_expression","identity_code","generated_code","collation_oid","type_default_collation_oid","storage_code","type_default_storage_code","compression_code","has_default"], issuedLimit);
      if (!rows) { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], ["relation_oid","attnum","column_name","dropped","local","inheritance_count","physical_type","type_oid","not_null","default_object_oid","default_expression","identity_code","generated_code","collation_oid","type_default_collation_oid","storage_code","type_default_storage_code","compression_code","has_default"], ["dropped","local","not_null","has_default"], ["type_default_collation_oid","type_default_storage_code","default_object_oid","default_expression"]);
      this.chargeRecords(budget, rows.length);
      const issued = new Set(batch);
      for (const row of rows) output.push(this.columnRow(row, issued, relationKinds));
    }
    return Object.freeze(output);
  }

  private async readIndexVectors(indexes: readonly OwnedCatalogIndexV1[], operation: "registry-read" | "catalog-read", parentMethods: ReadonlyMap<string, string>): Promise<readonly OwnedCatalogIndexV1[]> {
    if (!indexes.length)
        return indexes;
    const values = new Map<string, {
        attnums: string[];
        names: (string | null)[];
        collations: string[];
        opclasses: string[];
        options: string[];
    }>();
    for (let offset = 0; offset < indexes.length;) {
        const batch: OwnedCatalogIndexV1[] = [];
        let total = 0;
        while (offset < indexes.length && batch.length < 1024) {
            const index = indexes[offset]!;
            const width = Number(index.totalAttributeCount);
            if (total + width > 65536)
                break;
            batch.push(index);
            total += width;
            offset++;
        }
        if (!batch.length) {
            this.source.drift();
        }
        const parameter = this.encodePgOidArrayParameter(batch.map(index => index.indexRelationOid));
        const read = async (kind: "key" | "collation" | "opclass" | "option") => {
            const expected = batch.reduce((sum, index) => sum + Number(kind === "key" ? index.totalAttributeCount : index.keyAttributeCount), 0);
            if (expected > 65536) {
                this.source.drift();
            }
            const select = kind === "key"
                ? `element.attnum::pg_catalog.text AS value,a.attnum::pg_catalog.text AS resolved_attnum,a.attname AS column_name`
                : `element.value::pg_catalog.text AS value`;
            const source = kind === "key" ? "i.indkey" : kind === "collation" ? "i.indcollation" : kind === "opclass" ? "i.indclass" : "i.indoption";
            const join = kind === "key" ? "LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid=i.indrelid AND a.attnum=element.attnum" : "";
            const result = await this.source.query(`SELECT i.indexrelid::pg_catalog.text AS index_relation_oid,element.element_ordinality::pg_catalog.text AS element_ordinality,${select} FROM pg_catalog.pg_index AS i CROSS JOIN LATERAL pg_catalog.unnest(${source}) WITH ORDINALITY AS element(${kind === "key" ? "attnum" : "value"},element_ordinality) ${join} WHERE i.indexrelid=ANY($1::pg_catalog.oid[]) ORDER BY i.indexrelid,element.element_ordinality LIMIT ${expected + 1}`, [parameter], operation);
            const aliases = kind === "key" ? ["index_relation_oid", "element_ordinality", "value", "resolved_attnum", "column_name"] : ["index_relation_oid", "element_ordinality", "value"];
            const rows = selectOwnedStoreRows(result, aliases, expected + 1);
            if (!rows) {
                this.source.unavailable();
            }
            this.wireRows(rows as readonly Row[], aliases, [], kind === "key" ? ["resolved_attnum", "column_name"] : []);
            if (rows.length === expected + 1) {
                this.source.drift();
            }
            for (const row of rows) {
                if (typeof row.index_relation_oid !== "string" || typeof row.element_ordinality !== "string" || typeof row.value !== "string" || (kind === "key" && row.column_name !== null && typeof row.column_name !== "string") || (kind === "key" && row.resolved_attnum !== null && typeof row.resolved_attnum !== "string")) {
                    this.source.unavailable();
                }
                const index = batch.find(item => item.indexRelationOid === row.index_relation_oid), ordinal = Number(row.element_ordinality);
                if (!index || !/^[1-9][0-9]*$/u.test(row.element_ordinality) || !Number.isSafeInteger(ordinal) || ordinal > Number(kind === "key" ? index.totalAttributeCount : index.keyAttributeCount)) {
                    this.source.drift();
                }
                const target = values.get(index.indexRelationOid) ?? { attnums: [], names: [], collations: [], opclasses: [], options: [] };
                const list = kind === "key" ? target.attnums : kind === "collation" ? target.collations : kind === "opclass" ? target.opclasses : target.options;
                if (list.length !== ordinal - 1) {
                    this.source.drift();
                }
                if (kind === "key") {
                    const signed = this.signedInt2(row.value);
                    if (!signed || (row.value === "0" ? row.resolved_attnum !== null || row.column_name !== null : row.resolved_attnum !== row.value || row.column_name === null)) {
                        this.source.drift();
                    }
                    target.attnums.push(row.value);
                    target.names.push(row.value === "0" ? null : row.column_name as string);
                }
                else {
                    if (kind === "option" ? !this.signedInt2(row.value) : !this.oid(row.value) && !(kind !== "opclass" && row.value === "0")) {
                        this.source.drift();
                    }
                    list.push(row.value);
                }
                values.set(index.indexRelationOid, target);
            }
        };
        await read("key");
        await read("collation");
        await read("opclass");
        await read("option");
    }
    return this.readIndexOpclasses(Object.freeze(indexes.map(index => { const value = values.get(index.indexRelationOid); if (!value || value.attnums.length !== Number(index.totalAttributeCount) || value.collations.length !== Number(index.keyAttributeCount) || value.opclasses.length !== Number(index.keyAttributeCount) || value.options.length !== Number(index.keyAttributeCount)) {
        this.source.drift();
    } return Object.freeze({ ...index, attributeNumbers: Object.freeze(value.attnums), columnNames: Object.freeze(value.names), collationOids: Object.freeze(value.collations), opclassOids: Object.freeze(value.opclasses), options: Object.freeze(value.options) }); })), operation, parentMethods);
}

  private async readIndexOpclasses(indexes: readonly OwnedCatalogIndexV1[], operation: "registry-read" | "catalog-read", parentMethods: ReadonlyMap<string, string>): Promise<readonly OwnedCatalogIndexV1[]> {
    const actual = [...new Set(indexes.flatMap(index => index.opclassOids))];
    const defaults = new Map<string, string>();
    const methods = new Map<string, string>();
    for (let offset = 0; offset < actual.length; offset += 1024) {
      const batch = actual.slice(offset, offset + 1024), parameter = this.encodePgOidArrayParameter(batch);
      const result = await this.source.query(`SELECT actual.oid::pg_catalog.text AS actual_opclass_oid,actual.opcmethod::pg_catalog.text AS actual_method_oid,actual.opcintype::pg_catalog.text AS actual_input_type_oid,actual.opcfamily::pg_catalog.text AS actual_opfamily_oid,family.opfmethod::pg_catalog.text AS actual_family_method_oid,candidate.default_opclass_oid::pg_catalog.text AS default_opclass_oid,candidate.default_method_oid::pg_catalog.text AS default_method_oid,candidate.default_input_type_oid::pg_catalog.text AS default_input_type_oid,candidate.default_is_default AS default_is_default FROM pg_catalog.pg_opclass AS actual JOIN pg_catalog.pg_opfamily AS family ON family.oid=actual.opcfamily LEFT JOIN LATERAL (SELECT d.oid AS default_opclass_oid,d.opcmethod AS default_method_oid,d.opcintype AS default_input_type_oid,d.opcdefault AS default_is_default FROM pg_catalog.pg_opclass AS d WHERE d.opcmethod=actual.opcmethod AND d.opcintype=actual.opcintype AND d.opcdefault=true ORDER BY d.oid LIMIT 2) AS candidate ON true WHERE actual.oid=ANY($1::pg_catalog.oid[]) ORDER BY actual.oid,candidate.default_opclass_oid NULLS FIRST LIMIT 2049`, [parameter], operation);
      const rows = selectOwnedStoreRows(result, ["actual_opclass_oid","actual_method_oid","actual_input_type_oid","actual_opfamily_oid","actual_family_method_oid","default_opclass_oid","default_method_oid","default_input_type_oid","default_is_default"], 2049);
      if (!rows) { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], ["actual_opclass_oid","actual_method_oid","actual_input_type_oid","actual_opfamily_oid","actual_family_method_oid","default_opclass_oid","default_method_oid","default_input_type_oid","default_is_default"], ["default_is_default"], ["default_opclass_oid","default_method_oid","default_input_type_oid","default_is_default"]);
      if (rows.length === 2049) { this.source.drift(); }
      const grouped = new Map<string, Row[]>(); for (const row of rows) { if (typeof row.actual_opclass_oid !== "string") { this.source.unavailable(); } const group = grouped.get(row.actual_opclass_oid) ?? []; group.push(row); grouped.set(row.actual_opclass_oid, group); }
      if (grouped.size !== batch.length || [...grouped.keys()].some(oid => !batch.includes(oid))) { this.source.drift(); }
      for (const oid of batch) { const group = grouped.get(oid); if (!group || group.length !== 1) { this.source.drift(); } const row = group[0]!; if (![row.actual_method_oid,row.actual_input_type_oid,row.actual_opfamily_oid,row.actual_family_method_oid].every(value => typeof value === "string") || (row.default_opclass_oid !== null && typeof row.default_opclass_oid !== "string") || (row.default_method_oid !== null && typeof row.default_method_oid !== "string") || (row.default_input_type_oid !== null && typeof row.default_input_type_oid !== "string") || (row.default_is_default !== null && typeof row.default_is_default !== "boolean")) { this.source.unavailable(); } if (row.default_opclass_oid === null || row.default_method_oid === null || row.default_input_type_oid === null || row.default_is_default !== true || row.actual_method_oid !== row.actual_family_method_oid || row.actual_method_oid !== row.default_method_oid || row.actual_input_type_oid !== row.default_input_type_oid || ![row.actual_method_oid,row.actual_input_type_oid,row.actual_opfamily_oid,row.actual_family_method_oid,row.default_opclass_oid,row.default_method_oid,row.default_input_type_oid].every(value => this.oid(value))) { this.source.drift(); } methods.set(oid, row.actual_method_oid); defaults.set(oid, row.default_opclass_oid); }
    }
    for (const index of indexes) for (const opclass of index.opclassOids) if (parentMethods.get(index.indexRelationOid) !== methods.get(opclass)) { this.source.drift(); }
    return Object.freeze(indexes.map(index => { const defaultOpclassOids = index.opclassOids.map(oid => defaults.get(oid)); if (defaultOpclassOids.some(oid => oid === undefined)) { this.source.drift(); } return Object.freeze({ ...index, defaultOpclassOids: Object.freeze(defaultOpclassOids as string[]) }); }));
  }

  private async readConstraintParents(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly OwnedStoreConstraintParentV1[]> {
    const owned = relations.filter(relation => relation.kind === "ordinaryTable" || relation.kind === "toastTable").map(relation => relation.oid);
    if (!owned.length)
        return Object.freeze([]);
    const parameters: string[] = [], branches: string[] = [];
    for (let offset = 0; offset < owned.length; offset += 1024) {
        parameters.push(this.encodePgOidArrayParameter(owned.slice(offset, offset + 1024)));
        branches.push(`SELECT x.oid FROM pg_catalog.unnest($${parameters.length}::pg_catalog.oid[]) AS x(oid)`);
    }
    const issuedLimit = budget.remaining + 1;
    const result = await this.source.query(`WITH owned(oid) AS (${branches.join(" UNION ALL ")}) SELECT c.oid::pg_catalog.text AS constraint_oid,c.conrelid::pg_catalog.text AS relation_oid,c.confrelid::pg_catalog.text AS referenced_relation_oid,c.conname AS constraint_name,c.contype::pg_catalog.text AS constraint_type_code,c.conindid::pg_catalog.text AS backing_index_oid,c.confdeltype::pg_catalog.text AS delete_action_code,c.confupdtype::pg_catalog.text AS update_action_code,c.confmatchtype::pg_catalog.text AS match_type_code,c.condeferrable AS is_deferrable,c.condeferred AS is_initially_deferred,c.convalidated AS is_validated,c.conparentid::pg_catalog.text AS parent_constraint_oid,c.coninhcount::pg_catalog.text AS inheritance_count,c.connoinherit AS is_no_inherit,COALESCE(pg_catalog.cardinality(c.conkey),0)::pg_catalog.text AS conkey_count,COALESCE(pg_catalog.cardinality(c.confkey),0)::pg_catalog.text AS confkey_count,COALESCE(pg_catalog.cardinality(c.confdelsetcols),0)::pg_catalog.text AS confdelsetcols_count,COALESCE(pg_catalog.cardinality(c.conpfeqop),0)::pg_catalog.text AS conpfeqop_count,COALESCE(pg_catalog.cardinality(c.conppeqop),0)::pg_catalog.text AS conppeqop_count,COALESCE(pg_catalog.cardinality(c.conffeqop),0)::pg_catalog.text AS conffeqop_count,CASE WHEN c.contype='c'::pg_catalog."char" THEN pg_catalog.pg_get_constraintdef(c.oid,false) ELSE NULL::pg_catalog.text END AS check_definition FROM pg_catalog.pg_constraint AS c WHERE c.conrelid IN (SELECT oid FROM owned) OR (c.contype='f'::pg_catalog."char" AND c.confrelid IN (SELECT oid FROM owned)) ORDER BY c.conrelid,pg_catalog.convert_to(c.conname,'UTF8'),c.oid LIMIT ${issuedLimit}`, parameters, operation);
    const rows = selectOwnedStoreRows(result, ["constraint_oid", "relation_oid", "referenced_relation_oid", "constraint_name", "constraint_type_code", "backing_index_oid", "delete_action_code", "update_action_code", "match_type_code", "is_deferrable", "is_initially_deferred", "is_validated", "parent_constraint_oid", "inheritance_count", "is_no_inherit", "conkey_count", "confkey_count", "confdelsetcols_count", "conpfeqop_count", "conppeqop_count", "conffeqop_count", "check_definition"], issuedLimit);
    if (!rows) {
        this.source.unavailable();
    }
    this.wireRows(rows as readonly Row[], ["constraint_oid", "relation_oid", "referenced_relation_oid", "constraint_name", "constraint_type_code", "backing_index_oid", "delete_action_code", "update_action_code", "match_type_code", "is_deferrable", "is_initially_deferred", "is_validated", "parent_constraint_oid", "inheritance_count", "is_no_inherit", "conkey_count", "confkey_count", "confdelsetcols_count", "conpfeqop_count", "conppeqop_count", "conffeqop_count", "check_definition"], ["is_deferrable", "is_initially_deferred", "is_validated", "is_no_inherit"], ["check_definition"]);
    this.chargeRecords(budget, rows.length);
    const out: OwnedStoreConstraintParentV1[] = [];
    for (const row of rows) {
        const str = (v: unknown) => { if (typeof v !== "string") {
            this.source.unavailable();
        } return v; };
        const oid = (v: unknown, nullable = false) => { const x = str(v); if ((nullable && x !== "0" || !nullable) && !this.oid(x)) {
            this.source.drift();
        } return nullable && x === "0" ? null : x; };
        const count = (v: unknown) => { const x = str(v); if (!/^(0|[1-9][0-9]*)$/u.test(x) || BigInt(x) > 65536n) {
            this.source.drift();
        } return Number(x); };
        if (typeof row.is_deferrable !== "boolean" || typeof row.is_initially_deferred !== "boolean" || typeof row.is_validated !== "boolean" || typeof row.is_no_inherit !== "boolean" || (row.check_definition !== null && typeof row.check_definition !== "string")) {
            this.source.unavailable();
        }
        const code = str(row.constraint_type_code), kind = ({ p: "primaryKey", u: "unique", f: "foreignKey", c: "check", x: "exclusion" } as Record<string, OwnedCatalogConstraintV1["kind"]>)[code] ?? "other";
        const widths = [count(row.conkey_count), count(row.confkey_count), count(row.confdelsetcols_count), count(row.conpfeqop_count), count(row.conppeqop_count), count(row.conffeqop_count)] as const;
        const inheritance = str(row.inheritance_count);
        if (!/^(0|[1-9][0-9]*)$/u.test(inheritance) || BigInt(inheritance) > 32767n || (kind === "check" && row.check_definition === null) || (kind !== "foreignKey" && widths.slice(1).some(x => x !== 0)) || (kind === "foreignKey" && (widths[0] === 0 || widths[0] !== widths[1] || widths[0] !== widths[3] || widths[0] !== widths[4] || widths[0] !== widths[5] || widths[2] > widths[0]))) {
            this.source.drift();
        }
        const checked = kind === "check" ? canonicalPostgresCheck(str(row.constraint_name), row.check_definition as string) : undefined;
        if (checked?.unsupported) {
            this.source.drift();
        }
        const expression = this.freezeCheck(checked?.expression ?? null) as NonNullable<OwnedCatalogConstraintV1["checkExpression"]> | null;
        const action = (v: unknown) => ({ a: "noAction", r: "restrict", c: "cascade", n: "setNull", d: "setDefault" } as Record<string, string>)[str(v)] ?? `other:${str(v)}`;
        const match = (v: unknown) => ({ s: "simple", f: "full", p: "partial" } as Record<string, string>)[str(v)] ?? `other:${str(v)}`;
        out.push(Object.freeze({ value: Object.freeze({ oid: oid(row.constraint_oid)!, relationOid: oid(row.relation_oid)!, referencedRelationOid: oid(row.referenced_relation_oid, true), name: str(row.constraint_name), kind, columns: Object.freeze([]), referencedColumns: Object.freeze([]), backingIndexOid: oid(row.backing_index_oid, true), onDelete: kind === "foreignKey" ? action(row.delete_action_code) : null, onUpdate: kind === "foreignKey" ? action(row.update_action_code) : null, match: kind === "foreignKey" ? match(row.match_type_code) : null, deferrable: row.is_deferrable, initiallyDeferred: row.is_initially_deferred, validated: row.is_validated, parentConstraintOid: oid(row.parent_constraint_oid, true), inheritanceCount: inheritance, noInherit: row.is_no_inherit, deleteSetColumns: Object.freeze([]), primaryForeignEqualityOperatorOids: Object.freeze([]), primaryPrimaryEqualityOperatorOids: Object.freeze([]), foreignForeignEqualityOperatorOids: Object.freeze([]), defaultEqualityOperatorOids: Object.freeze([]), checkExpression: expression }), widths }));
    }
    return Object.freeze(out);
}

  /** Captures every pg_constraint vector independently; FK default equality is resolved separately. */
  private async readConstraintVectors(parents: readonly OwnedStoreConstraintParentV1[], operation: "registry-read" | "catalog-read"): Promise<readonly OwnedCatalogConstraintV1[]> {
    if (!parents.length) return Object.freeze([]);
    const ids = new Set<string>();
    for (const parent of parents) if (ids.has(parent.value.oid)) { this.source.drift(); } else ids.add(parent.value.oid);
    type VectorKind = "columns" | "referencedColumns" | "deleteSetColumns" | "primaryForeignEqualityOperatorOids" | "primaryPrimaryEqualityOperatorOids" | "foreignForeignEqualityOperatorOids";
    const vectors = new Map<string, Record<VectorKind, string[]>>();
    for (const parent of parents) vectors.set(parent.value.oid, { columns: [], referencedColumns: [], deleteSetColumns: [], primaryForeignEqualityOperatorOids: [], primaryPrimaryEqualityOperatorOids: [], foreignForeignEqualityOperatorOids: [] });
    const width = (parent: OwnedStoreConstraintParentV1, kind: VectorKind): number => kind === "columns" ? parent.widths[0] : kind === "referencedColumns" ? parent.widths[1] : kind === "deleteSetColumns" ? parent.widths[2] : kind === "primaryForeignEqualityOperatorOids" ? parent.widths[3] : kind === "primaryPrimaryEqualityOperatorOids" ? parent.widths[4] : parent.widths[5];
    const kinds: readonly VectorKind[] = ["columns", "referencedColumns", "deleteSetColumns", "primaryForeignEqualityOperatorOids", "primaryPrimaryEqualityOperatorOids", "foreignForeignEqualityOperatorOids"];
    for (const kind of kinds) {
      for (let offset = 0; offset < parents.length;) {
        const batch: OwnedStoreConstraintParentV1[] = []; let expected = 0;
        while (offset < parents.length && batch.length < 1024) {
          const parent = parents[offset]!, next = width(parent, kind);
          if (expected + next > 65536) break;
          batch.push(parent); expected += next; offset++;
        }
        if (!batch.length) { this.source.drift(); }
        const parameter = this.encodePgOidArrayParameter(batch.map(parent => parent.value.oid));
        const names = kind === "columns" || kind === "referencedColumns" || kind === "deleteSetColumns";
        const native = kind === "columns" ? "c.conkey" : kind === "referencedColumns" ? "c.confkey" : kind === "deleteSetColumns" ? "c.confdelsetcols" : kind === "primaryForeignEqualityOperatorOids" ? "c.conpfeqop" : kind === "primaryPrimaryEqualityOperatorOids" ? "c.conppeqop" : "c.conffeqop";
        const select = names
          ? "element.attnum::pg_catalog.text AS attribute_number,a.attnum::pg_catalog.text AS resolved_attribute_number,a.attname AS column_name"
          : "element.operator_oid::pg_catalog.text AS operator_oid";
        const join = names ? ` LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid=requested.${kind === "referencedColumns" ? "referenced_relation_oid" : "relation_oid"} AND a.attnum=element.attnum` : "";
        const result = await this.source.query(`WITH requested(constraint_oid,request_ordinality,relation_oid,referenced_relation_oid) AS (SELECT input.constraint_oid,input.request_ordinality,c.conrelid,c.confrelid FROM pg_catalog.unnest($1::pg_catalog.oid[]) WITH ORDINALITY AS input(constraint_oid,request_ordinality) JOIN pg_catalog.pg_constraint AS c ON c.oid=input.constraint_oid) SELECT requested.request_ordinality::pg_catalog.text AS request_ordinality,c.oid::pg_catalog.text AS constraint_oid,element.element_ordinality::pg_catalog.text AS element_ordinality,${select} FROM requested JOIN pg_catalog.pg_constraint AS c ON c.oid=requested.constraint_oid CROSS JOIN LATERAL pg_catalog.unnest(${native}) WITH ORDINALITY AS element(${names ? "attnum" : "operator_oid"},element_ordinality)${join} ORDER BY requested.request_ordinality,element.element_ordinality LIMIT ${expected + 1}`, [parameter], operation);
        const aliases = names ? ["request_ordinality", "constraint_oid", "element_ordinality", "attribute_number", "resolved_attribute_number", "column_name"] : ["request_ordinality", "constraint_oid", "element_ordinality", "operator_oid"];
        const rows = selectOwnedStoreRows(result, aliases, expected + 1);
        if (!rows) { this.source.unavailable(); }
        this.wireRows(rows as readonly Row[], aliases, [], names ? ["resolved_attribute_number","column_name"] : []);
        if (rows.length === expected + 1) { this.source.drift(); }
        for (const row of rows) {
          const required = (value: unknown): string => { if (typeof value !== "string") { this.source.unavailable(); } return value; };
          const nullable = (value: unknown): string | null => { if (value === null) return null; return required(value); };
          const ordinal = required(row.request_ordinality), constraintOid = required(row.constraint_oid), element = required(row.element_ordinality);
          if (!/^[1-9][0-9]*$/u.test(ordinal) || !/^[1-9][0-9]*$/u.test(element)) { this.source.drift(); }
          const request = Number(ordinal), position = Number(element), parent = Number.isSafeInteger(request) ? batch[request - 1] : undefined;
          if (!parent || parent.value.oid !== constraintOid || position > width(parent, kind)) { this.source.drift(); }
          const vector = vectors.get(constraintOid) ?? { columns: [], referencedColumns: [], deleteSetColumns: [], primaryForeignEqualityOperatorOids: [], primaryPrimaryEqualityOperatorOids: [], foreignForeignEqualityOperatorOids: [] };
          const target = vector[kind];
          if (target.length !== position - 1) { this.source.drift(); }
          if (names) {
            const attnum = required(row.attribute_number), resolved = nullable(row.resolved_attribute_number), name = nullable(row.column_name);
            if (resolved === null || name === null || !/^[1-9][0-9]*$/u.test(attnum) || BigInt(attnum) > 32767n || attnum !== resolved) { this.source.drift(); }
            target.push(name);
          } else {
            const operator = required(row.operator_oid);
            if (!this.oid(operator)) { this.source.drift(); }
            target.push(operator);
          }
          vectors.set(constraintOid, vector);
        }
        for (const parent of batch) {
          const vector = vectors.get(parent.value.oid);
          if ((vector?.[kind].length ?? 0) !== width(parent, kind)) { this.source.drift(); }
        }
      }
    }
    return Object.freeze(parents.map(parent => {
      const vector = vectors.get(parent.value.oid);
      if (!vector) { this.source.drift(); }
      return Object.freeze({ ...parent.value, columns: Object.freeze([...vector.columns]), referencedColumns: Object.freeze([...vector.referencedColumns]), deleteSetColumns: Object.freeze([...vector.deleteSetColumns]), primaryForeignEqualityOperatorOids: Object.freeze([...vector.primaryForeignEqualityOperatorOids]), primaryPrimaryEqualityOperatorOids: Object.freeze([...vector.primaryPrimaryEqualityOperatorOids]), foreignForeignEqualityOperatorOids: Object.freeze([...vector.foreignForeignEqualityOperatorOids]), defaultEqualityOperatorOids: Object.freeze([]) });
    }));
  }

  /** Resolves FK default equality from the exact referenced PK/index/opfamily path. */
  private async readForeignKeyDefaultEquality(constraints: readonly OwnedCatalogConstraintV1[], operation: "registry-read" | "catalog-read"): Promise<readonly OwnedCatalogConstraintV1[]> {
    const foreignKeys = constraints.filter(constraint => constraint.kind === "foreignKey");
    if (!foreignKeys.length) return constraints;
    const targetPks = new Map<string, string>();
    for (let offset = 0; offset < foreignKeys.length; offset += 1024) {
      const batch = foreignKeys.slice(offset, offset + 1024), parameter = this.encodePgOidArrayParameter(batch.map(value => value.oid));
      const result = await this.source.query(`WITH requested AS (SELECT input.fk_oid,input.request_ordinality FROM pg_catalog.unnest($1::pg_catalog.oid[]) WITH ORDINALITY AS input(fk_oid,request_ordinality)) SELECT requested.request_ordinality::pg_catalog.text AS request_ordinality,fk.oid::pg_catalog.text AS fk_oid,fk.confrelid::pg_catalog.text AS referenced_relation_oid,fk.conindid::pg_catalog.text AS referenced_supporting_index_oid,target.pk_constraint_oid::pg_catalog.text AS target_pk_constraint_oid,target.pk_backing_index_oid::pg_catalog.text AS target_pk_backing_index_oid FROM requested JOIN pg_catalog.pg_constraint AS fk ON fk.oid OPERATOR(pg_catalog.=) requested.fk_oid AND fk.contype OPERATOR(pg_catalog.=) 'f'::pg_catalog."char" LEFT JOIN LATERAL (SELECT pk.oid AS pk_constraint_oid,pk.conindid AS pk_backing_index_oid FROM pg_catalog.pg_constraint AS pk WHERE pk.contype OPERATOR(pg_catalog.=) 'p'::pg_catalog."char" AND pk.conrelid OPERATOR(pg_catalog.=) fk.confrelid AND pk.conindid OPERATOR(pg_catalog.=) fk.conindid ORDER BY pk.oid LIMIT 2) AS target ON true ORDER BY requested.request_ordinality,target.pk_constraint_oid NULLS FIRST LIMIT 2049`, [parameter], operation);
      const rows = selectOwnedStoreRows(result, ["request_ordinality", "fk_oid", "referenced_relation_oid", "referenced_supporting_index_oid", "target_pk_constraint_oid", "target_pk_backing_index_oid"], 2049);
      if (!rows) { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], ["request_ordinality", "fk_oid", "referenced_relation_oid", "referenced_supporting_index_oid", "target_pk_constraint_oid", "target_pk_backing_index_oid"], [], ["target_pk_constraint_oid","target_pk_backing_index_oid"]);
      if (rows.length === 2049) { this.source.drift(); }
      const grouped = new Map<string, Row[]>();
      for (const row of rows) {
        if (typeof row.request_ordinality !== "string" || typeof row.fk_oid !== "string" || typeof row.referenced_relation_oid !== "string" || typeof row.referenced_supporting_index_oid !== "string" || (row.target_pk_constraint_oid !== null && typeof row.target_pk_constraint_oid !== "string") || (row.target_pk_backing_index_oid !== null && typeof row.target_pk_backing_index_oid !== "string")) { this.source.unavailable(); }
        const group = grouped.get(row.fk_oid) ?? []; group.push(row); grouped.set(row.fk_oid, group);
      }
      if ([...grouped.keys()].some(oid => !batch.some(fk => fk.oid === oid))) { this.source.drift(); }
      for (let index = 0; index < batch.length; index++) {
        const fk = batch[index]!, group = grouped.get(fk.oid);
        if (!group || group.length !== 1) { this.source.drift(); }
        const row = group[0]!;
        if (row.target_pk_constraint_oid === null || row.target_pk_backing_index_oid === null || row.request_ordinality !== String(index + 1) || row.fk_oid !== fk.oid || row.referenced_relation_oid !== fk.referencedRelationOid || row.referenced_supporting_index_oid !== fk.backingIndexOid || row.target_pk_backing_index_oid !== fk.backingIndexOid || !this.oid(row.referenced_relation_oid) || !this.oid(row.referenced_supporting_index_oid) || !this.oid(row.target_pk_constraint_oid) || !this.oid(row.target_pk_backing_index_oid)) { this.source.drift(); }
        targetPks.set(fk.oid, row.target_pk_constraint_oid);
      }
    }
    const positions = new Map<string, { readonly family: string; readonly method: string; readonly type: string }>();
    for (let offset = 0; offset < foreignKeys.length;) {
      const batch: OwnedCatalogConstraintV1[] = []; let expected = 0;
      while (offset < foreignKeys.length && batch.length < 1024 && expected + foreignKeys[offset]!.columns.length <= 65536) { const fk = foreignKeys[offset++]!; batch.push(fk); expected += fk.columns.length; }
      if (!batch.length) { this.source.drift(); }
      const fks = this.encodePgOidArrayParameter(batch.map(value => value.oid)), pks = this.encodePgOidArrayParameter(batch.map(value => targetPks.get(value.oid) ?? "0"));
      const result = await this.source.query(`WITH fk_input AS (SELECT x.fk_oid,x.request_ordinality FROM pg_catalog.unnest($1::pg_catalog.oid[]) WITH ORDINALITY AS x(fk_oid,request_ordinality)),pk_input AS (SELECT x.pk_oid,x.request_ordinality FROM pg_catalog.unnest($2::pg_catalog.oid[]) WITH ORDINALITY AS x(pk_oid,request_ordinality)),requested AS (SELECT f.request_ordinality,f.fk_oid,p.pk_oid FROM fk_input AS f JOIN pk_input AS p ON p.request_ordinality OPERATOR(pg_catalog.=) f.request_ordinality) SELECT requested.request_ordinality::pg_catalog.text AS request_ordinality,fk.oid::pg_catalog.text AS fk_oid,src.fk_position::pg_catalog.text AS fk_position,src.source_attnum::pg_catalog.text AS source_attnum,ref.referenced_attnum::pg_catalog.text AS referenced_attnum,pk.oid::pg_catalog.text AS target_pk_constraint_oid,pg_catalog.cardinality(pk.conkey)::pg_catalog.text AS target_pk_key_count,pk_key.pk_position::pg_catalog.text AS target_pk_position,ix.indexrelid::pg_catalog.text AS target_index_oid,ix.indnkeyatts::pg_catalog.text AS target_index_key_count,ix_key.index_position::pg_catalog.text AS target_index_position,ix_op.opclass_oid::pg_catalog.text AS actual_opclass_oid,opc.opcfamily::pg_catalog.text AS opfamily_oid,opc.opcmethod::pg_catalog.text AS opclass_method_oid,family.opfmethod::pg_catalog.text AS opfamily_method_oid,ix_rel.relam::pg_catalog.text AS index_method_oid,attr.atttypid::pg_catalog.text AS referenced_type_oid FROM requested JOIN pg_catalog.pg_constraint AS fk ON fk.oid OPERATOR(pg_catalog.=) requested.fk_oid AND fk.contype OPERATOR(pg_catalog.=) 'f'::pg_catalog."char" JOIN pg_catalog.pg_constraint AS pk ON pk.oid OPERATOR(pg_catalog.=) requested.pk_oid AND pk.conrelid OPERATOR(pg_catalog.=) fk.confrelid AND pk.conindid OPERATOR(pg_catalog.=) fk.conindid JOIN pg_catalog.pg_index AS ix ON ix.indexrelid OPERATOR(pg_catalog.=) pk.conindid AND ix.indrelid OPERATOR(pg_catalog.=) pk.conrelid JOIN pg_catalog.pg_class AS ix_rel ON ix_rel.oid OPERATOR(pg_catalog.=) ix.indexrelid CROSS JOIN LATERAL pg_catalog.unnest(fk.conkey) WITH ORDINALITY AS src(source_attnum,fk_position) JOIN LATERAL pg_catalog.unnest(fk.confkey) WITH ORDINALITY AS ref(referenced_attnum,fk_position) ON ref.fk_position OPERATOR(pg_catalog.=) src.fk_position JOIN LATERAL pg_catalog.unnest(pk.conkey) WITH ORDINALITY AS pk_key(pk_attnum,pk_position) ON pk_key.pk_attnum OPERATOR(pg_catalog.=) ref.referenced_attnum JOIN LATERAL pg_catalog.unnest(ix.indkey) WITH ORDINALITY AS ix_key(index_attnum,index_position) ON ix_key.index_position OPERATOR(pg_catalog.=) pk_key.pk_position AND ix_key.index_attnum OPERATOR(pg_catalog.=) pk_key.pk_attnum AND ix_key.index_position OPERATOR(pg_catalog.<=) ix.indnkeyatts JOIN LATERAL pg_catalog.unnest(ix.indclass) WITH ORDINALITY AS ix_op(opclass_oid,index_position) ON ix_op.index_position OPERATOR(pg_catalog.=) ix_key.index_position JOIN pg_catalog.pg_attribute AS attr ON attr.attrelid OPERATOR(pg_catalog.=) fk.confrelid AND attr.attnum OPERATOR(pg_catalog.=) ref.referenced_attnum JOIN pg_catalog.pg_opclass AS opc ON opc.oid OPERATOR(pg_catalog.=) ix_op.opclass_oid JOIN pg_catalog.pg_opfamily AS family ON family.oid OPERATOR(pg_catalog.=) opc.opcfamily ORDER BY requested.request_ordinality,src.fk_position LIMIT $3::pg_catalog.int8`, [fks, pks, String(expected + 1)], operation);
      const aliases = ["request_ordinality", "fk_oid", "fk_position", "source_attnum", "referenced_attnum", "target_pk_constraint_oid", "target_pk_key_count", "target_pk_position", "target_index_oid", "target_index_key_count", "target_index_position", "actual_opclass_oid", "opfamily_oid", "opclass_method_oid", "opfamily_method_oid", "index_method_oid", "referenced_type_oid"];
      const rows = selectOwnedStoreRows(result, aliases, expected + 1);
      if (!rows) { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], aliases);
      if (rows.length === expected + 1) { this.source.drift(); }
      for (const row of rows) {
        if (!aliases.every(alias => typeof row[alias] === "string")) { this.source.unavailable(); }
        const requestOrdinality = row.request_ordinality as string, fkPosition = row.fk_position as string, sourceAttnum = row.source_attnum as string, referencedAttnum = row.referenced_attnum as string, targetPkPosition = row.target_pk_position as string, targetIndexPosition = row.target_index_position as string, targetPkWidth = row.target_pk_key_count as string, targetIndexWidth = row.target_index_key_count as string;
        const request = Number(requestOrdinality), position = Number(fkPosition), fk = Number.isSafeInteger(request) ? batch[request - 1] : undefined;
        const pkPosition = Number(targetPkPosition), indexPosition = Number(targetIndexPosition), pkWidth = Number(targetPkWidth), indexWidth = Number(targetIndexWidth);
        if (!/^[1-9][0-9]*$/u.test(requestOrdinality) || !/^[1-9][0-9]*$/u.test(fkPosition) || !/^[1-9][0-9]*$/u.test(sourceAttnum) || !/^[1-9][0-9]*$/u.test(referencedAttnum) || !/^[1-9][0-9]*$/u.test(targetPkPosition) || !/^[1-9][0-9]*$/u.test(targetIndexPosition) || !/^[1-9][0-9]*$/u.test(targetPkWidth) || !/^[1-9][0-9]*$/u.test(targetIndexWidth) || !fk || !Number.isSafeInteger(position) || position < 1 || position > fk.columns.length || !Number.isSafeInteger(pkPosition) || !Number.isSafeInteger(indexPosition) || !Number.isSafeInteger(pkWidth) || !Number.isSafeInteger(indexWidth) || pkWidth !== fk.columns.length || indexWidth !== fk.columns.length || pkPosition < 1 || pkPosition > pkWidth || indexPosition !== pkPosition || row.fk_oid !== fk.oid || row.target_pk_constraint_oid !== targetPks.get(fk.oid) || row.target_index_oid !== fk.backingIndexOid || row.opclass_method_oid !== row.opfamily_method_oid || row.opclass_method_oid !== row.index_method_oid || ![sourceAttnum, referencedAttnum, row.target_index_oid, row.actual_opclass_oid, row.opfamily_oid, row.opclass_method_oid, row.referenced_type_oid].every(value => this.oid(value)) || BigInt(sourceAttnum) > 32767n || BigInt(referencedAttnum) > 32767n || positions.has(`${fk.oid}:${position}`)) { this.source.drift(); }
        positions.set(`${fk.oid}:${position}`, Object.freeze({ family: row.opfamily_oid as string, method: row.opclass_method_oid as string, type: row.referenced_type_oid as string }));
      }
      if (batch.some(fk => fk.columns.some((_, index) => !positions.has(`${fk.oid}:${index + 1}`)))) { this.source.drift(); }
    }
    const tuples = [...new Map([...positions.values()].map(value => [`${value.family}:${value.method}:${value.type}`, value])).values()];
    const operators = new Map<string, string>();
    for (let offset = 0; offset < tuples.length; offset += 1024) {
      const batch = tuples.slice(offset, offset + 1024), families = this.encodePgOidArrayParameter(batch.map(value => value.family)), methods = this.encodePgOidArrayParameter(batch.map(value => value.method)), types = this.encodePgOidArrayParameter(batch.map(value => value.type));
      const result = await this.source.query(`WITH family_input AS (SELECT x.family_oid,x.request_ordinality FROM pg_catalog.unnest($1::pg_catalog.oid[]) WITH ORDINALITY AS x(family_oid,request_ordinality)),method_input AS (SELECT x.method_oid,x.request_ordinality FROM pg_catalog.unnest($2::pg_catalog.oid[]) WITH ORDINALITY AS x(method_oid,request_ordinality)),type_input AS (SELECT x.type_oid,x.request_ordinality FROM pg_catalog.unnest($3::pg_catalog.oid[]) WITH ORDINALITY AS x(type_oid,request_ordinality)),requested AS (SELECT f.request_ordinality,f.family_oid,m.method_oid,t.type_oid FROM family_input AS f JOIN method_input AS m ON m.request_ordinality OPERATOR(pg_catalog.=) f.request_ordinality JOIN type_input AS t ON t.request_ordinality OPERATOR(pg_catalog.=) f.request_ordinality) SELECT requested.request_ordinality::pg_catalog.text AS request_ordinality,requested.family_oid::pg_catalog.text AS requested_family_oid,requested.method_oid::pg_catalog.text AS requested_method_oid,requested.type_oid::pg_catalog.text AS requested_type_oid,candidate.amop_oid::pg_catalog.text AS amop_oid,candidate.amop_family_oid::pg_catalog.text AS amop_family_oid,candidate.amop_method_oid::pg_catalog.text AS amop_method_oid,candidate.amop_left_type_oid::pg_catalog.text AS amop_left_type_oid,candidate.amop_right_type_oid::pg_catalog.text AS amop_right_type_oid,candidate.amop_purpose::pg_catalog.text AS amop_purpose,candidate.amop_strategy::pg_catalog.text AS amop_strategy,candidate.operator_oid::pg_catalog.text AS operator_oid,candidate.operator_left_type_oid::pg_catalog.text AS operator_left_type_oid,candidate.operator_right_type_oid::pg_catalog.text AS operator_right_type_oid FROM requested LEFT JOIN LATERAL (SELECT amop.oid AS amop_oid,amop.amopfamily AS amop_family_oid,amop.amopmethod AS amop_method_oid,amop.amoplefttype AS amop_left_type_oid,amop.amoprighttype AS amop_right_type_oid,amop.amoppurpose AS amop_purpose,amop.amopstrategy AS amop_strategy,amop.amopopr AS operator_oid,op.oprleft AS operator_left_type_oid,op.oprright AS operator_right_type_oid FROM pg_catalog.pg_amop AS amop LEFT JOIN pg_catalog.pg_operator AS op ON op.oid OPERATOR(pg_catalog.=) amop.amopopr WHERE amop.amopfamily OPERATOR(pg_catalog.=) requested.family_oid AND amop.amopmethod OPERATOR(pg_catalog.=) requested.method_oid AND amop.amoppurpose OPERATOR(pg_catalog.=) 's'::pg_catalog."char" AND amop.amopstrategy OPERATOR(pg_catalog.=) 3::pg_catalog.int2 AND amop.amoplefttype OPERATOR(pg_catalog.=) requested.type_oid AND amop.amoprighttype OPERATOR(pg_catalog.=) requested.type_oid ORDER BY amop.oid,amop.amopopr LIMIT 2) AS candidate ON true ORDER BY requested.request_ordinality,candidate.amop_oid NULLS FIRST LIMIT 2049`, [families, methods, types], operation);
      const aliases = ["request_ordinality", "requested_family_oid", "requested_method_oid", "requested_type_oid", "amop_oid", "amop_family_oid", "amop_method_oid", "amop_left_type_oid", "amop_right_type_oid", "amop_purpose", "amop_strategy", "operator_oid", "operator_left_type_oid", "operator_right_type_oid"];
      const rows = selectOwnedStoreRows(result, aliases, 2049);
      if (!rows) { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], aliases, [], aliases.slice(4));
      if (rows.length === 2049) { this.source.drift(); }
      const requestedAliases = aliases.slice(0, 4), candidateAliases = aliases.slice(4), grouped = new Map<string, Row[]>();
      for (const row of rows) { if (!requestedAliases.every(alias => typeof row[alias] === "string") || !candidateAliases.every(alias => row[alias] === null || typeof row[alias] === "string")) { this.source.unavailable(); } const group = grouped.get(row.request_ordinality as string) ?? []; group.push(row); grouped.set(row.request_ordinality as string, group); }
      if ([...grouped.keys()].some(ordinal => !/^[1-9][0-9]*$/u.test(ordinal) || Number(ordinal) > batch.length)) { this.source.drift(); }
      for (let index = 0; index < batch.length; index++) { const tuple = batch[index]!, group = grouped.get(String(index + 1)); if (!group || group.length !== 1) { this.source.drift(); } const row = group[0]!; if (!candidateAliases.every(alias => typeof row[alias] === "string") || row.requested_family_oid !== tuple.family || row.requested_method_oid !== tuple.method || row.requested_type_oid !== tuple.type || row.amop_family_oid !== tuple.family || row.amop_method_oid !== tuple.method || row.amop_left_type_oid !== tuple.type || row.amop_right_type_oid !== tuple.type || row.amop_purpose !== "s" || row.amop_strategy !== "3" || row.operator_left_type_oid !== tuple.type || row.operator_right_type_oid !== tuple.type || ![row.amop_oid, row.operator_oid].every(value => this.oid(value))) { this.source.drift(); } operators.set(`${tuple.family}:${tuple.method}:${tuple.type}`, row.operator_oid as string); }
    }
    return Object.freeze(constraints.map(constraint => constraint.kind !== "foreignKey" ? constraint : Object.freeze({ ...constraint, defaultEqualityOperatorOids: Object.freeze(constraint.columns.map((_, index) => { const tuple = positions.get(`${constraint.oid}:${index + 1}`), operator = tuple ? operators.get(`${tuple.family}:${tuple.method}:${tuple.type}`) : undefined; if (!operator) { this.source.drift(); } return operator; })) })));
  }

  private async readTriggers(relations: readonly OwnedCatalogRelationV1[], constraints: readonly OwnedCatalogConstraintV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly OwnedCatalogTriggerV1[]> {
    const relationOids = relations.map(value => value.oid), constraintOids = constraints.map(value => value.oid);
    if (!relationOids.length) return Object.freeze([]);
    const parameters: string[] = [], branches = (oids: readonly string[], name: string): string => { const out: string[] = []; for (let offset = 0; offset < oids.length; offset += 1024) { parameters.push(this.encodePgOidArrayParameter(oids.slice(offset, offset + 1024))); out.push(`SELECT input.oid FROM pg_catalog.unnest($${parameters.length}::pg_catalog.oid[]) AS input(oid)`); } return `WITH ${name}(oid) AS (${out.join(" UNION ALL ")})`; };
    const relationCte = branches(relationOids, "requested_relation"), constraintCte = constraintOids.length ? `,requested_constraint(oid) AS (${(() => { const out: string[] = []; for (let offset = 0; offset < constraintOids.length; offset += 1024) { parameters.push(this.encodePgOidArrayParameter(constraintOids.slice(offset, offset + 1024))); out.push(`SELECT input.oid FROM pg_catalog.unnest($${parameters.length}::pg_catalog.oid[]) AS input(oid)`); } return out.join(" UNION ALL "); })()})` : "";
    const issuedLimit = budget.remaining + 1;
    const result = await this.source.query(`${relationCte}${constraintCte} SELECT t.oid::pg_catalog.text AS trigger_oid,t.tgrelid::pg_catalog.text AS relation_oid,t.tgname AS trigger_name,t.tgisinternal AS is_internal,t.tgconstraint::pg_catalog.text AS constraint_oid,t.tgparentid::pg_catalog.text AS parent_trigger_oid,t.tgenabled::pg_catalog.text AS enabled_code,t.tgfoid::pg_catalog.text AS function_oid,n.nspname AS function_schema,p.proname AS function_name,t.tgtype::pg_catalog.text AS type_bits FROM pg_catalog.pg_trigger AS t LEFT JOIN pg_catalog.pg_proc AS p ON p.oid=t.tgfoid LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace WHERE EXISTS (SELECT 1 FROM requested_relation AS r WHERE r.oid=t.tgrelid) OR ${constraintOids.length ? "EXISTS (SELECT 1 FROM requested_constraint AS c WHERE c.oid=t.tgconstraint)" : "false"} ORDER BY t.tgrelid,pg_catalog.convert_to(t.tgname,'UTF8'),t.oid LIMIT ${issuedLimit}`, parameters, operation);
    const aliases = ["trigger_oid", "relation_oid", "trigger_name", "is_internal", "constraint_oid", "parent_trigger_oid", "enabled_code", "function_oid", "function_schema", "function_name", "type_bits"];
    const rows = selectOwnedStoreRows(result, aliases, issuedLimit);
    if (!rows) { this.source.unavailable(); }
    this.wireRows(rows as readonly Row[], aliases, ["is_internal"], ["function_schema","function_name"]);
    this.chargeRecords(budget, rows.length);
    const out: OwnedCatalogTriggerV1[] = [];
    for (const row of rows) {
      if (![row.trigger_oid, row.relation_oid, row.trigger_name, row.enabled_code, row.function_oid, row.type_bits].every(value => typeof value === "string") || typeof row.is_internal !== "boolean" || (row.constraint_oid !== "0" && typeof row.constraint_oid !== "string") || (row.parent_trigger_oid !== "0" && typeof row.parent_trigger_oid !== "string") || (row.function_schema !== null && typeof row.function_schema !== "string") || (row.function_name !== null && typeof row.function_name !== "string")) { this.source.unavailable(); }
      const constraint = row.constraint_oid === "0" ? null : row.constraint_oid as string, parent = row.parent_trigger_oid === "0" ? null : row.parent_trigger_oid as string, enabled: OwnedCatalogTriggerV1["enabled"] = row.enabled_code === "O" ? "origin" : row.enabled_code === "A" ? "always" : row.enabled_code === "R" ? "replica" : row.enabled_code === "D" ? "disabled" : "other";
      if (row.function_schema === null || row.function_name === null || ![row.trigger_oid, row.relation_oid, row.function_oid].every(value => typeof value === "string" && this.oid(value)) || (constraint !== null && !this.oid(constraint)) || (parent !== null && !this.oid(parent)) || (!relationOids.includes(row.relation_oid as string) && (constraint === null || !constraintOids.includes(constraint))) || !/^[1-9][0-9]*$/u.test(row.type_bits as string) || BigInt(row.type_bits as string) > 32767n) { this.source.drift(); }
      out.push(Object.freeze({ oid: row.trigger_oid as string, relationOid: row.relation_oid as string, name: row.trigger_name as string, internal: row.is_internal, constraintOid: constraint, parentTriggerOid: parent, enabled, functionOid: row.function_oid as string, functionSchema: row.function_schema as string, functionName: row.function_name as string, typeBits: row.type_bits as string }));
    }
    return Object.freeze(out);
  }

  private async readRules(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly OwnedCatalogRuleV1[]> {
    const ids = relations.map(value => value.oid); if (!ids.length) return Object.freeze([]);
    const out: OwnedCatalogRuleV1[] = [];
    for (let offset = 0; offset < ids.length; offset += 1024) {
      const parameter = this.encodePgOidArrayParameter(ids.slice(offset, offset + 1024)), issuedLimit = budget.remaining + 1;
      const result = await this.source.query(`SELECT r.oid::pg_catalog.text AS rule_oid,r.ev_class::pg_catalog.text AS relation_oid,r.rulename AS rule_name,r.ev_type::pg_catalog.text AS event_code,r.ev_enabled::pg_catalog.text AS enabled_code,r.is_instead AS is_instead FROM pg_catalog.pg_rewrite AS r WHERE r.ev_class=ANY($1::pg_catalog.oid[]) ORDER BY r.ev_class,pg_catalog.convert_to(r.rulename,'UTF8'),r.oid LIMIT ${issuedLimit}`, [parameter], operation);
      const aliases = ["rule_oid","relation_oid","rule_name","event_code","enabled_code","is_instead"];
      const rows=selectOwnedStoreRows(result,aliases,issuedLimit); if(!rows){this.source.unavailable();}
      this.wireRows(rows as readonly Row[],aliases,["is_instead"]);
      this.chargeRecords(budget,rows.length);
      for(const row of rows){const oid=row.rule_oid as string,relation=row.relation_oid as string;if(!this.oid(oid)||!ids.includes(relation)||!this.oid(relation)){this.source.drift();} out.push(Object.freeze({oid,relationOid:relation,name:row.rule_name as string,event:row.event_code as string,enabled:row.enabled_code as string,instead:row.is_instead as boolean}));}
    }
    return Object.freeze(out);
  }

  private async readPolicies(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly OwnedCatalogPolicyV1[]> {
    const ids = relations.map(value => value.oid);
    if (!ids.length)
        return Object.freeze([]);
    const parents: {
        readonly oid: string;
        readonly relation: string;
        readonly width: number;
        readonly name: string;
        readonly permissive: boolean;
        readonly command: string;
        readonly using: string | null;
        readonly check: string | null;
    }[] = [];
    for (let offset = 0; offset < ids.length; offset += 1024) {
        const batchIds = ids.slice(offset, offset + 1024), parameter = this.encodePgOidArrayParameter(batchIds), issuedLimit = budget.remaining + 1;
        const result = await this.source.query(`SELECT p.oid::pg_catalog.text AS policy_oid,p.polrelid::pg_catalog.text AS relation_oid,p.polname AS policy_name,p.polpermissive AS permissive,p.polcmd::pg_catalog.text AS command_code,pg_catalog.pg_get_expr(p.polqual,p.polrelid,false) AS using_expression,pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,false) AS check_expression,COALESCE(pg_catalog.cardinality(p.polroles),0)::pg_catalog.text AS role_count FROM pg_catalog.pg_policy AS p WHERE p.polrelid=ANY($1::pg_catalog.oid[]) ORDER BY p.polrelid,pg_catalog.convert_to(p.polname,'UTF8'),p.oid LIMIT ${issuedLimit}`, [parameter], operation);
        const rows = selectOwnedStoreRows(result, ["policy_oid", "relation_oid", "policy_name", "permissive", "command_code", "using_expression", "check_expression", "role_count"], issuedLimit);
        if (!rows) {
            this.source.unavailable();
        }
        this.wireRows(rows as readonly Row[], ["policy_oid", "relation_oid", "policy_name", "permissive", "command_code", "using_expression", "check_expression", "role_count"], ["permissive"], ["using_expression", "check_expression"]);
        this.chargeRecords(budget, rows.length);
        for (const row of rows) {
            if (![row.policy_oid, row.relation_oid, row.policy_name, row.command_code, row.role_count].every(value => typeof value === "string") || typeof row.permissive !== "boolean" || (row.using_expression !== null && typeof row.using_expression !== "string") || (row.check_expression !== null && typeof row.check_expression !== "string")) {
                this.source.unavailable();
            }
            const oid = row.policy_oid as string, relation = row.relation_oid as string, count = row.role_count as string;
            if (!this.oid(oid) || !this.oid(relation) || !batchIds.includes(relation) || !/^(0|[1-9][0-9]*)$/u.test(count) || BigInt(count) > 65536n) {
                this.source.drift();
            }
            parents.push(Object.freeze({ oid, relation, width: Number(count), name: row.policy_name as string, permissive: row.permissive, command: row.command_code as string, using: row.using_expression as string | null, check: row.check_expression as string | null }));
        }
    }
    const roles = new Map<string, string[]>();
    for (let offset = 0; offset < parents.length;) {
        const batch: typeof parents = [];
        let expected = 0;
        while (offset < parents.length && batch.length < 1024 && expected + parents[offset]!.width <= 65536) {
            const parent = parents[offset++]!;
            batch.push(parent);
            expected += parent.width;
        }
        if (!batch.length) {
            this.source.drift();
        }
        const parameter = this.encodePgOidArrayParameter(batch.map(value => value.oid));
        const result = await this.source.query(`WITH requested(policy_oid,request_ordinality) AS (SELECT input.policy_oid,input.request_ordinality FROM pg_catalog.unnest($1::pg_catalog.oid[]) WITH ORDINALITY AS input(policy_oid,request_ordinality)) SELECT requested.request_ordinality::pg_catalog.text AS request_ordinality,p.oid::pg_catalog.text AS policy_oid,element.element_ordinality::pg_catalog.text AS element_ordinality,element.role_oid::pg_catalog.text AS role_oid FROM requested JOIN pg_catalog.pg_policy AS p ON p.oid=requested.policy_oid CROSS JOIN LATERAL pg_catalog.unnest(p.polroles) WITH ORDINALITY AS element(role_oid,element_ordinality) ORDER BY requested.request_ordinality,element.element_ordinality LIMIT ${expected + 1}`, [parameter], operation);
        const rows = selectOwnedStoreRows(result, ["request_ordinality", "policy_oid", "element_ordinality", "role_oid"], expected + 1);
        if (!rows) {
            this.source.unavailable();
        }
        this.wireRows(rows as readonly Row[], ["request_ordinality", "policy_oid", "element_ordinality", "role_oid"]);
        if (rows.length === expected + 1) {
            this.source.drift();
        }
        for (const row of rows) {
            if (![row.request_ordinality, row.policy_oid, row.element_ordinality, row.role_oid].every(value => typeof value === "string")) {
                this.source.unavailable();
            }
            const ordinal = row.request_ordinality as string, policy = row.policy_oid as string, element = row.element_ordinality as string, role = row.role_oid as string, request = Number(ordinal), position = Number(element), parent = Number.isSafeInteger(request) ? batch[request - 1] : undefined;
            if (!/^[1-9][0-9]*$/u.test(ordinal) || !/^[1-9][0-9]*$/u.test(element) || !parent || parent.oid !== policy || !Number.isSafeInteger(position) || position < 1 || position > parent.width || !/^(0|[1-9][0-9]*)$/u.test(role) || (role !== "0" && !this.oid(role))) {
                this.source.drift();
            }
            const list = roles.get(parent.oid) ?? [];
            if (list.length !== position - 1) {
                this.source.drift();
            }
            list.push(role);
            roles.set(parent.oid, list);
        }
        for (const parent of batch)
            if ((roles.get(parent.oid)?.length ?? 0) !== parent.width) {
                this.source.drift();
            }
    }
    return Object.freeze(parents.map(parent => Object.freeze({ oid: parent.oid, relationOid: parent.relation, name: parent.name, permissive: parent.permissive, command: parent.command, roles: Object.freeze([...(roles.get(parent.oid) ?? [])]), usingExpression: parent.using, checkExpression: parent.check })));
}

  private async readInheritance(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly OwnedCatalogInheritanceV1[]> {
    const ids=relations.map(value=>value.oid);if(!ids.length)return Object.freeze([]);const parameters:string[]=[];const branches:string[]=[];
    for(let offset=0;offset<ids.length;offset+=1024){parameters.push(this.encodePgOidArrayParameter(ids.slice(offset,offset+1024)));branches.push(`SELECT input.oid FROM pg_catalog.unnest($${parameters.length}::pg_catalog.oid[]) AS input(oid)`);}
    const issuedLimit=budget.remaining+1,result=await this.source.query(`WITH requested(oid) AS (${branches.join(" UNION ALL ")}) SELECT i.inhrelid::pg_catalog.text AS child_relation_oid,i.inhparent::pg_catalog.text AS parent_relation_oid,i.inhseqno::pg_catalog.text AS sequence FROM pg_catalog.pg_inherits AS i WHERE EXISTS (SELECT 1 FROM requested AS r WHERE r.oid=i.inhrelid) OR EXISTS (SELECT 1 FROM requested AS r WHERE r.oid=i.inhparent) ORDER BY i.inhrelid,i.inhparent,i.inhseqno LIMIT ${issuedLimit}`,parameters,operation);
    const aliases=["child_relation_oid","parent_relation_oid","sequence"],rows=selectOwnedStoreRows(result,aliases,issuedLimit);if(!rows){this.source.unavailable();}
    this.wireRows(rows as readonly Row[],aliases);
    this.chargeRecords(budget,rows.length);const out:OwnedCatalogInheritanceV1[]=[];
    for(const row of rows){const childRelationOid=row.child_relation_oid as string,parentRelationOid=row.parent_relation_oid as string,sequence=row.sequence as string;if(!this.oid(childRelationOid)||!this.oid(parentRelationOid)||(!ids.includes(childRelationOid)&&!ids.includes(parentRelationOid))||!/^[1-9][0-9]*$/u.test(sequence)||BigInt(sequence)>2147483647n){this.source.drift();}out.push(Object.freeze({childRelationOid,parentRelationOid,sequence}));}return Object.freeze(out);
  }

  private async readPgClassOid(operation: "registry-read" | "catalog-read"): Promise<string> {
    const result = await this.source.query("SELECT c.oid::pg_catalog.text AS catalog_class_oid FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace WHERE n.nspname='pg_catalog' AND c.relname='pg_class' LIMIT 2", [], operation);
    const rows = selectOwnedStoreRows(result, ["catalog_class_oid"], 2);
    if (!rows) { this.source.unavailable(); }
    for (const row of rows) if (typeof row.catalog_class_oid !== "string") { this.source.unavailable(); }
    if (rows.length !== 1 || !this.oid(rows[0]!.catalog_class_oid)) { this.source.drift(); }
    return rows[0]!.catalog_class_oid;
  }

  private async readIdentitySequenceOids(columns: readonly OwnedCatalogColumnV1[], pgClassOid: string, operation: "registry-read" | "catalog-read"): Promise<readonly string[]> {
    const drift=():never=>{this.source.drift();},lock=():never=>{this.source.unavailable();},owners=new Map<string,Set<string>>();
    for(const column of columns){if(column.identityCode==="")continue;if(!this.oid(column.relationOid)||!/^[1-9][0-9]*$/u.test(column.attnum)||BigInt(column.attnum)>32767n)drift();const attributes=owners.get(column.relationOid)??new Set<string>();if(attributes.has(column.attnum))drift();attributes.add(column.attnum);owners.set(column.relationOid,attributes);}if(!owners.size)return Object.freeze([]);if(!this.oid(pgClassOid))drift();const ids=[...owners.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0),seen=new Set<string>(),sequences=new Map<string,string>(),aliases=["dependent_class_oid","sequence_oid","dependent_sub_id","referenced_class_oid","owner_relation_oid","owner_attnum","dependency_type"];
    for(let offset=0;offset<ids.length;){const batch:string[]=[];let expected=0;while(offset<ids.length&&batch.length<1024){const id=ids[offset]!,width=owners.get(id)!.size;if(expected+width>65536)break;batch.push(id);expected+=width;offset++;}if(!batch.length)drift();const result=await this.source.query(`SELECT d.classid::pg_catalog.text AS dependent_class_oid,d.objid::pg_catalog.text AS sequence_oid,d.objsubid::pg_catalog.text AS dependent_sub_id,d.refclassid::pg_catalog.text AS referenced_class_oid,d.refobjid::pg_catalog.text AS owner_relation_oid,d.refobjsubid::pg_catalog.text AS owner_attnum,d.deptype::pg_catalog.text AS dependency_type FROM pg_catalog.pg_depend AS d JOIN pg_catalog.pg_attribute AS a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid WHERE d.classid=$2::pg_catalog.oid AND d.refclassid=$2::pg_catalog.oid AND d.objsubid=0 AND d.deptype='i'::pg_catalog."char" AND d.refobjid=ANY($1::pg_catalog.oid[]) AND a.attidentity<>''::pg_catalog."char" ORDER BY d.refobjid,d.refobjsubid,d.objid LIMIT ${expected+1}`,[this.encodePgOidArrayParameter(batch),pgClassOid],operation),maybeRows=selectOwnedStoreRows(result,aliases,expected+1);if(!maybeRows)lock();const rows=maybeRows as readonly Row[];for(const row of rows)for(const alias of aliases)if(typeof row[alias]!=="string")lock();if(rows.length===expected+1)drift();const issued=new Set(batch);for(const row of rows){const owner=row.owner_relation_oid as string,attnum=row.owner_attnum as string,sequence=row.sequence_oid as string,key=`${owner}:${attnum}`;if(row.dependent_class_oid!==pgClassOid||row.referenced_class_oid!==pgClassOid||row.dependent_sub_id!=="0"||row.dependency_type!=="i"||!issued.has(owner)||!owners.get(owner)?.has(attnum)||!this.oid(sequence)||seen.has(key)||sequences.has(sequence))drift();seen.add(key);sequences.set(sequence,key);}for(const owner of batch)for(const attnum of owners.get(owner)!)if(!seen.has(`${owner}:${attnum}`))drift();}
    return Object.freeze([...sequences.keys()].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0));
  }

  private async readSequences(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly OwnedCatalogSequenceV1[]> {
    const ids=relations.filter(relation=>relation.kind==="sequence").map(relation=>relation.oid);if(!ids.length)return Object.freeze([]);const out:OwnedCatalogSequenceV1[]=[];
    for(let offset=0;offset<ids.length;offset+=1024){const batch=ids.slice(offset,offset+1024),parameter=this.encodePgOidArrayParameter(batch),issuedLimit=Math.min(batch.length+1,budget.remaining+1),result=await this.source.query(`SELECT s.seqrelid::pg_catalog.text AS relation_oid,s.seqtypid::pg_catalog.text AS sequence_type_oid,t.oid::pg_catalog.text AS resolved_type_oid,n.nspname AS type_schema,t.typname AS type_name,s.seqstart::pg_catalog.text AS start_value,s.seqincrement::pg_catalog.text AS increment_value,s.seqmin::pg_catalog.text AS minimum_value,s.seqmax::pg_catalog.text AS maximum_value,s.seqcache::pg_catalog.text AS cache_value,s.seqcycle AS cycle FROM pg_catalog.pg_sequence AS s LEFT JOIN pg_catalog.pg_type AS t ON t.oid=s.seqtypid LEFT JOIN pg_catalog.pg_namespace AS n ON n.oid=t.typnamespace WHERE s.seqrelid=ANY($1::pg_catalog.oid[]) ORDER BY s.seqrelid LIMIT ${issuedLimit}`,[parameter],operation),aliases=["relation_oid","sequence_type_oid","resolved_type_oid","type_schema","type_name","start_value","increment_value","minimum_value","maximum_value","cache_value","cycle"],rows=selectOwnedStoreRows(result,aliases,issuedLimit);if(!rows){this.source.unavailable();}this.wireRows(rows as readonly Row[],aliases,["cycle"],["resolved_type_oid","type_schema","type_name"]);this.chargeRecords(budget,rows.length);if(rows.length===issuedLimit){this.source.drift();}const seen=new Set<string>();for(const row of rows){const relationOid=row.relation_oid as string,sequenceTypeOid=row.sequence_type_oid as string,resolvedTypeOid=row.resolved_type_oid as string|null,typeSchema=row.type_schema as string|null,typeName=row.type_name as string|null,start=row.start_value as string,increment=row.increment_value as string,minimum=row.minimum_value as string,maximum=row.maximum_value as string,cache=row.cache_value as string,cycle=row.cycle as boolean;if(!batch.includes(relationOid)||seen.has(relationOid)||!this.oid(relationOid)||!this.oid(sequenceTypeOid)||resolvedTypeOid===null||typeSchema===null||typeName===null||resolvedTypeOid!==sequenceTypeOid||!this.oid(resolvedTypeOid)||![start,increment,minimum,maximum].every(value=>/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u.test(value)&&BigInt(value)>=-9223372036854775808n&&BigInt(value)<=9223372036854775807n)||!/^[1-9][0-9]*$/u.test(cache)||BigInt(cache)>9223372036854775807n){this.source.drift();}const type=typeSchema==="pg_catalog"&&typeName==="int8"?"bigint":typeSchema==="pg_catalog"&&typeName==="int4"?"integer":typeSchema==="pg_catalog"&&typeName==="int2"?"smallint":"other";out.push(Object.freeze({relationOid,type,start,increment,minimum,maximum,cache,cycle}));seen.add(relationOid);}if(seen.size!==batch.length){this.source.drift();}}
    return Object.freeze(out);
  }

  private async readIndexes(relations: readonly OwnedCatalogRelationV1[], operation: "registry-read" | "catalog-read", budget: { remaining: number }): Promise<readonly OwnedCatalogIndexV1[]> {
    const issued = relations.map(relation => relation.oid);
    if (!issued.length) return Object.freeze([]);
    const indexOids = new Set<string>();
    for (let offset = 0; offset < issued.length; offset += 1024) {
      const batch = issued.slice(offset, offset + 1024), issuedLimit = budget.remaining + 1, result = await this.source.query(`SELECT i.indexrelid::pg_catalog.text AS index_relation_oid FROM pg_catalog.pg_index AS i WHERE i.indrelid=ANY($1::pg_catalog.oid[]) OR i.indexrelid=ANY($1::pg_catalog.oid[]) ORDER BY i.indexrelid LIMIT ${issuedLimit}`, [this.encodePgOidArrayParameter(batch)], operation), rows = selectOwnedStoreRows(result, ["index_relation_oid"], issuedLimit);
      if (!rows) { this.source.unavailable(); }
      for (const row of rows) if (typeof row.index_relation_oid !== "string") { this.source.unavailable(); }
      this.wireRows(rows as readonly Row[], ["index_relation_oid"]);
      if (rows.length === issuedLimit) { this.source.drift(); }
      for (const row of rows) { const oid = row.index_relation_oid as string; if (!this.oid(oid)) { this.source.drift(); } indexOids.add(oid); }
    }
    if (indexOids.size > budget.remaining) { this.source.drift(); }
    const output: OwnedCatalogIndexV1[] = [], parentMethods = new Map<string, string>(), issuedSet = new Set(issued), rootIndexOids = new Set(relations.filter(relation => relation.kind === "index" || relation.kind === "partitionedIndex").map(relation => relation.oid)), discovered = [...indexOids].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
    for (let offset = 0; offset < discovered.length; offset += 1024) {
      const batch = discovered.slice(offset, offset + 1024), bound = batch.length * 2 + 1, result = await this.source.query(`SELECT i.indexrelid::pg_catalog.text AS index_relation_oid,i.indrelid::pg_catalog.text AS table_relation_oid,c.relname AS index_name,c.relam::pg_catalog.text AS method_oid,am.amname AS method_name,i.indisunique AS is_unique,i.indisprimary AS is_primary,i.indisexclusion AS is_exclusion,i.indimmediate AS is_immediate,i.indisvalid AS is_valid,i.indisready AS is_ready,i.indislive AS is_live,i.indisreplident AS is_replica_identity,i.indnullsnotdistinct AS nulls_not_distinct,i.indnkeyatts::pg_catalog.text AS key_attribute_count,i.indnatts::pg_catalog.text AS total_attribute_count,pg_catalog.pg_get_expr(i.indexprs,i.indrelid,false) AS index_expression,pg_catalog.pg_get_expr(i.indpred,i.indrelid,false) AS index_predicate,owner_constraint.constraint_oid::pg_catalog.text AS backing_constraint_oid FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am AS am ON am.oid=c.relam LEFT JOIN LATERAL (SELECT con.oid AS constraint_oid FROM pg_catalog.pg_constraint AS con WHERE con.conindid=i.indexrelid AND (con.contype='p'::pg_catalog."char" OR con.contype='u'::pg_catalog."char" OR con.contype='x'::pg_catalog."char") ORDER BY con.oid LIMIT 2) AS owner_constraint ON true WHERE i.indexrelid=ANY($1::pg_catalog.oid[]) ORDER BY i.indexrelid,owner_constraint.constraint_oid NULLS FIRST LIMIT ${bound}`, [this.encodePgOidArrayParameter(batch)], operation), aliases = ["index_relation_oid","table_relation_oid","index_name","method_oid","method_name","is_unique","is_primary","is_exclusion","is_immediate","is_valid","is_ready","is_live","is_replica_identity","nulls_not_distinct","key_attribute_count","total_attribute_count","index_expression","index_predicate","backing_constraint_oid"], rows = selectOwnedStoreRows(result, aliases, bound);
      if (!rows) { this.source.unavailable(); }
      for (const row of rows) if (typeof row.index_relation_oid !== "string" || typeof row.table_relation_oid !== "string" || typeof row.index_name !== "string" || typeof row.method_oid !== "string" || typeof row.method_name !== "string" || typeof row.key_attribute_count !== "string" || typeof row.total_attribute_count !== "string" || typeof row.is_unique !== "boolean" || typeof row.is_primary !== "boolean" || typeof row.is_exclusion !== "boolean" || typeof row.is_immediate !== "boolean" || typeof row.is_valid !== "boolean" || typeof row.is_ready !== "boolean" || typeof row.is_live !== "boolean" || typeof row.is_replica_identity !== "boolean" || typeof row.nulls_not_distinct !== "boolean" || (row.index_expression !== null && typeof row.index_expression !== "string") || (row.index_predicate !== null && typeof row.index_predicate !== "string") || (row.backing_constraint_oid !== null && typeof row.backing_constraint_oid !== "string")) { this.source.unavailable(); }
      if (rows.length === bound) { this.source.drift(); }
      const parents = new Map<string, Row[]>();
      for (const row of rows) { const oid = row.index_relation_oid as string; if (!batch.includes(oid)) { this.source.drift(); } const entries = parents.get(oid) ?? []; entries.push(row); parents.set(oid, entries); }
      if (parents.size !== batch.length) { this.source.drift(); }
      for (const oid of batch) { const entries = parents.get(oid); if (!entries) { this.source.drift(); } const method = entries[0]?.method_oid as string; if (!this.oid(method) || parentMethods.has(oid)) { this.source.drift(); } parentMethods.set(oid, method); output.push(this.indexParent(oid, entries, issuedSet, rootIndexOids)); }
    }
    this.chargeRecords(budget, output.length);
    return this.readIndexVectors(Object.freeze(output), operation, parentMethods);
  }

  private indexParent(indexOid: string, rows: readonly Row[], relations: ReadonlySet<string>, rootIndexes: ReadonlySet<string>): OwnedCatalogIndexV1 {
    const first = rows[0];
    if (!first) { this.source.drift(); }
    const text = (value: unknown): string => { if (typeof value !== "string") { this.source.unavailable(); } return value; };
    const bool = (value: unknown): boolean => { if (typeof value !== "boolean") { this.source.unavailable(); } return value; };
    const oid = (value: unknown): string => { const result = text(value); if (!this.oid(result)) { this.source.drift(); } return result; };
    const table = oid(first.table_relation_oid), keyCount = text(first.key_attribute_count), totalCount = text(first.total_attribute_count);
    if ((!relations.has(table) && !rootIndexes.has(indexOid)) || !/^[1-9][0-9]*$/u.test(keyCount) || !/^[1-9][0-9]*$/u.test(totalCount) || BigInt(keyCount) > 32767n || BigInt(totalCount) > 32767n || BigInt(keyCount) > BigInt(totalCount)) { this.source.drift(); }
    const constraint = rows.map(row => row.backing_constraint_oid).filter(value => value !== null);
    if (rows.length !== 1 || constraint.length > 1 || (constraint[0] !== undefined && !this.oid(constraint[0]))) { this.source.drift(); }
    return Object.freeze({ indexRelationOid: oid(indexOid), tableRelationOid: table, name: text(first.index_name), method: text(first.method_name), unique: bool(first.is_unique), primary: bool(first.is_primary), exclusion: bool(first.is_exclusion), immediate: bool(first.is_immediate), valid: bool(first.is_valid), ready: bool(first.is_ready), live: bool(first.is_live), replicaIdentity: bool(first.is_replica_identity), nullsNotDistinct: bool(first.nulls_not_distinct), keyAttributeCount: keyCount, totalAttributeCount: totalCount, attributeNumbers: Object.freeze([]), columnNames: Object.freeze([]), collationOids: Object.freeze([]), opclassOids: Object.freeze([]), defaultOpclassOids: Object.freeze([]), options: Object.freeze([]), expression: first.index_expression === null ? null : text(first.index_expression), predicate: first.index_predicate === null ? null : text(first.index_predicate), backingConstraintOid: constraint.length ? constraint[0]! : null });
  }

  private columnRow(row: Row, issued: ReadonlySet<string>, relationKinds: ReadonlyMap<string, OwnedCatalogRelationV1["kind"]>): OwnedCatalogColumnV1 {
    const string = (value: unknown): string => { if (typeof value !== "string") { this.source.unavailable(); } return value; };
    const boolean = (value: unknown): boolean => { if (typeof value !== "boolean") { this.source.unavailable(); } return value; };
    const oid = (value: unknown, zero = false): string => { const result = string(value); if ((!zero && !this.oid(result)) || (zero && result !== "0" && !this.oid(result))) { this.source.drift(); } return result; };
    const relationOid = oid(row.relation_oid);
    const attnum = string(row.attnum), inheritanceCount = string(row.inheritance_count);
    if (!issued.has(relationOid) || !/^[1-9][0-9]*$/u.test(attnum) || !/^(0|[1-9][0-9]*)$/u.test(inheritanceCount)) { this.source.drift(); }
    if ((row.type_default_collation_oid !== null && typeof row.type_default_collation_oid !== "string") || (row.type_default_storage_code !== null && typeof row.type_default_storage_code !== "string")) { this.source.unavailable(); }
    if (row.type_default_collation_oid === null || row.type_default_storage_code === null) { this.source.drift(); }
    const hasDefault = boolean(row.has_default), defaultOid = row.default_object_oid === null ? null : oid(row.default_object_oid), defaultExpression = row.default_expression === null ? null : string(row.default_expression);
    if ((defaultOid === null) !== (defaultExpression === null) || hasDefault !== (defaultOid !== null)) { this.source.drift(); }
    const rawType = string(row.physical_type), relationKind = relationKinds.get(relationOid);
    if (!relationKind) { this.source.drift(); }
    const canonical: string = relationKind === "toastTable" ? rawType : rawType === rawType.trim().toLowerCase() ? (exactPostgresType(rawType, canonicalPostgresType(rawType)) ?? "unknown") : rawType;
    const defaultValue = canonicalPostgresDefault(defaultExpression, canonical);
    if (defaultValue.unsupported || defaultValue.value === undefined) { this.source.drift(); }
    const identityRaw = string(row.identity_code), generatedRaw = string(row.generated_code);
    if (identityRaw.length > 1 || generatedRaw.length > 1) { this.source.drift(); }
    const identityCode: OwnedCatalogColumnV1["identityCode"] = identityRaw === "" || identityRaw === "a" || identityRaw === "d" ? identityRaw : "other";
    const generatedCode: OwnedCatalogColumnV1["generatedCode"] = generatedRaw === "" || generatedRaw === "s" || generatedRaw === "v" ? generatedRaw : "other";
    let generation: OwnedCatalogColumnV1["generation"] = "other";
    if (identityCode === "d" && generatedCode === "" && !hasDefault) generation = "identityByDefault";
    else if (identityCode === "" && generatedCode === "" && defaultValue.kind === "uuidV4") generation = "uuidDefault";
    else if (identityCode === "" && generatedCode === "" && !hasDefault) generation = "none";
    else if (identityCode === "" && generatedCode === "" && hasDefault) generation = "none";
    return Object.freeze({ relationOid, attnum, name: string(row.column_name), dropped: boolean(row.dropped), local: boolean(row.local), inheritanceCount, physicalType: canonical, typeOid: oid(row.type_oid, true), notNull: boolean(row.not_null), default: Object.freeze(defaultValue.value), defaultObjectOid: defaultOid, generation, identityCode, generatedCode, collationOid: oid(row.collation_oid, true), typeDefaultCollationOid: oid(row.type_default_collation_oid, true), storageCode: string(row.storage_code), typeDefaultStorageCode: string(row.type_default_storage_code), compressionCode: row.compression_code === "" || row.compression_code === "p" || row.compression_code === "l" ? row.compression_code : typeof row.compression_code === "string" ? "other" : (() => { this.source.unavailable(); })() });
  }

  private catalogScopes(value: readonly OrmCatalogScopeV1[]): readonly OrmCatalogScopeV1[] {
    try {
      if (!Array.isArray(value) || types.isProxy(value) || Object.getOwnPropertySymbols(value).length || value.length > 8320) throw new Error();
      const own = Object.getOwnPropertyDescriptors(value);
      if (Object.keys(own).length !== value.length + 1 || Object.keys(own).some(key => key !== "length" && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) throw new Error();
      const output: OrmCatalogScopeV1[] = [];
      let previous: OrmCatalogScopeV1 | undefined;
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || descriptor.value === null || typeof descriptor.value !== "object" || Array.isArray(descriptor.value) || types.isProxy(descriptor.value) || Object.getOwnPropertySymbols(descriptor.value).length) throw new Error();
        const candidate = descriptor.value;
        const candidateKeys = Object.keys(Object.getOwnPropertyDescriptors(candidate));
        if (candidateKeys.length !== 2 || !candidateKeys.includes("schema") || !candidateKeys.includes("tablePrefix")) throw new Error();
        const schema = Object.getOwnPropertyDescriptor(candidate, "schema"), tablePrefix = Object.getOwnPropertyDescriptor(candidate, "tablePrefix");
        if (!schema || !("value" in schema) || !tablePrefix || !("value" in tablePrefix) || typeof schema.value !== "string" || typeof tablePrefix.value !== "string") throw new Error();
        const scope = Object.freeze({ schema: schema.value, tablePrefix: tablePrefix.value });
        if (Buffer.byteLength(scope.schema, "utf8") < 1 || Buffer.byteLength(scope.schema, "utf8") > 63 || Buffer.byteLength(scope.tablePrefix, "utf8") < 1 || Buffer.byteLength(scope.tablePrefix, "utf8") > 63 || /[\x00-\x1f\x7f-\x9f]|[\ud800-\udfff]/u.test(scope.schema) || /[\x00-\x1f\x7f-\x9f]|[\ud800-\udfff]/u.test(scope.tablePrefix)) throw new Error();
        if (previous && Buffer.compare(Buffer.from(previous.schema, "utf8"), Buffer.from(scope.schema, "utf8")) >= 0 && (previous.schema !== scope.schema || Buffer.compare(Buffer.from(previous.tablePrefix, "utf8"), Buffer.from(scope.tablePrefix, "utf8")) >= 0)) throw new Error();
        output.push(scope); previous = scope;
      }
      return Object.freeze(output);
    } catch { throw failure("ORM_OWNED_STORE_DRIFT"); }
  }

  private wireRows(rows: readonly Row[], aliases: readonly string[], booleanAliases: readonly string[] = [], nullableAliases: readonly string[] = []): void {
    const booleans = new Set(booleanAliases), nullable = new Set(nullableAliases);
    for (const row of rows) for (const alias of aliases) {
      const value = row[alias];
      if (value === null && nullable.has(alias)) continue;
      if ((booleans.has(alias) ? typeof value !== "boolean" : typeof value !== "string")) { this.source.unavailable(); }
    }
  }

  private signedInt2(value: string): boolean {
    return /^(?:0|-?[1-9][0-9]*)$/u.test(value) && BigInt(value) >= -32768n && BigInt(value) <= 32767n;
  }

  private freezeCheck(value: unknown): unknown {
    if (Array.isArray(value)) { for (const item of value) this.freezeCheck(item); return Object.freeze(value); }
    if (value !== null && typeof value === "object") { for (const item of Object.values(value as Record<string, unknown>)) this.freezeCheck(item); return Object.freeze(value); }
    return value;
  }

}

/** Snapshot native SELECT rows without invoking getters or accepting driver shape drift. */
export function selectOwnedStoreRows(value: unknown, aliases: readonly string[], maximum: number): readonly Readonly<Record<string, unknown>>[] | undefined {
  try {
    if (!Array.isArray(value) || types.isProxy(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") return undefined;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return undefined;
    const allowed = new Set(["length", "count", "affectedRows", "command", "lastInsertRowid"]);
    for (let index = 0; index < length; index++) allowed.add(String(index));
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.has(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    const rows: Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < length; index++) {
      const row = Object.getOwnPropertyDescriptor(value, String(index))?.value;
      if (row === null || typeof row !== "object" || Array.isArray(row) || types.isProxy(row)) return undefined;
      const keys = Reflect.ownKeys(row);
      if (keys.length !== aliases.length || keys.some(key => typeof key !== "string" || !aliases.includes(key))) return undefined;
      const copy: Record<string, unknown> = Object.create(null);
      for (const alias of aliases) {
        const descriptor = Object.getOwnPropertyDescriptor(row, alias);
        if (!descriptor || !("value" in descriptor)) return undefined;
        copy[alias] = descriptor.value;
      }
      rows.push(Object.freeze(copy));
    }
    return Object.freeze(rows);
  } catch { return undefined; }
}

