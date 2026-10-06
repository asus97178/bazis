import { expect, test } from "bun:test";
import { OrmOwnedStoreAdmissionError } from "../errors";
import { PostgresProvider } from "../Providers/PostgresProvider";
import { failure, postgresOwnedStoreCapability, type OwnedStoreCreateOperationV1, type OwnedStoreIdentityInsertV1, type OwnedStoreSecondaryLockPlanV1, type RegistryLockedOwnedStoreSessionV1, type SecondaryLockedOwnedStoreSessionV1 } from "../Providers/ormOwnedStoreRuntime";
import { defineOrmOwnedStoreV1 } from "../Schema/OrmOwnedStore";
import { canonicalOwnedStoreModelHashV1, canonicalOwnedStoreScopeHashV1, canonicalOwnedStoreScopeLockPreimageV1, canonicalOwnedStoreStoreLockPreimageV1, ownedStoreAdvisoryLockV1 } from "../Schema/OwnedStoreCanonical";
import { admitOwnedStoresV1 } from "../Schema/OwnedStoreAdmission";
import { parseOwnedStoreCatalogSnapshotV1, parseOwnedStoreRegistrySnapshotV1, validateFixedRegistryShapeV1, verifyOwnedStoreCatalogAllV1, type OwnedStoreCatalogSnapshotV1 } from "../Schema/OwnedStoreCatalog";
import type { OrmExpectedSchema } from "../Schema/ExpectedSchema";

function ownedError(error: unknown, code: OrmOwnedStoreAdmissionError["code"]): void {
  expect(error).toBeInstanceOf(OrmOwnedStoreAdmissionError);
  if (!(error instanceof OrmOwnedStoreAdmissionError)) throw new Error("missing owned-store error");
  expect(error.code).toBe(code); expect(error.message).toBe(code); expect(Object.hasOwn(error, "cause")).toBe(false);
}

function registryProjectorSqlFacts(sql: string, params: readonly unknown[]): unknown[] | undefined {
  if (sql.includes("__osnv_orm_owned_stores_v1") && sql.includes("AS relation_oid")) return [{ relation_oid: "50" }];
  if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) {
    const ids = String(params[0] ?? "");
    return ids.includes("54") ? [{ oid:"54",namespace_oid:"12000",schema_name:"public",relation_name:"__osnv_orm_owned_stores_v1_pkey",relkind:"i",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"n",tablespace_oid:"0",access_method:"btree",row_type_oid:"0",toast_relation_oid:"0" }] : [{ oid:"50",namespace_oid:"12000",schema_name:"public",relation_name:"__osnv_orm_owned_stores_v1",relkind:"r",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"d",tablespace_oid:"0",access_method:"heap",row_type_oid:"51",toast_relation_oid:"0" }];
  }
  if (sql.includes("AS option_count")) return String(params[0] ?? "").includes("54") ? [{ relation_oid:"54",option_count:"0" }] : [{ relation_oid:"50",option_count:"0" }];
  if (sql.includes("AS row_type_oid")) return [{ row_type_oid:"51",relation_oid:"50",schema_name:"public",type_name:"__osnv_orm_owned_stores_v1",typtype:"c",array_type_oid:"52",array_relation_oid:"0",array_schema_name:"public",array_type_name:"_osnv_orm_owned_stores_v1",array_typtype:"b",array_typcategory:"A",array_element_oid:"51",array_array_oid:"0" }];
  if (sql.includes("FROM pg_catalog.pg_attribute")) {
    const names = ["store_key","contract","format_version","owned_schema","table_prefix","owned_scope_hash","model_hash","created_at"];
    const types = ["text","text","bigint","text","text","text","text","timestamp with time zone"];
    return names.map((column_name,index)=>({ relation_oid:"50",attnum:String(index+1),column_name,dropped:false,local:true,inheritance_count:"0",physical_type:types[index],type_oid:types[index]==="bigint"?"20":types[index]==="timestamp with time zone"?"1184":"25",not_null:true,default_object_oid:null,default_expression:null,identity_code:"",generated_code:"",collation_oid:types[index]==="text"?"100":"0",type_default_collation_oid:types[index]==="text"?"100":"0",storage_code:types[index]==="text"?"x":"p",type_default_storage_code:types[index]==="text"?"x":"p",compression_code:"",has_default:false }));
  }
  if (sql.includes("SELECT i.indexrelid::pg_catalog.text AS index_relation_oid FROM pg_catalog.pg_index")) return [{ index_relation_oid:"54" }];
  if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class")) return [{ index_relation_oid:"54",table_relation_oid:"50",index_name:"__osnv_orm_owned_stores_v1_pkey",method_oid:"403",method_name:"btree",is_unique:true,is_primary:true,is_exclusion:false,is_immediate:true,is_valid:true,is_ready:true,is_live:true,is_replica_identity:false,nulls_not_distinct:false,key_attribute_count:"1",total_attribute_count:"1",index_expression:null,index_predicate:null,backing_constraint_oid:"53" }];
  if (sql.includes("pg_catalog.unnest(i.indkey)")) return [{ index_relation_oid:"54",element_ordinality:"1",value:"1",resolved_attnum:"1",column_name:"store_key" }];
  if (sql.includes("pg_catalog.unnest(i.indcollation)")) return [{ index_relation_oid:"54",element_ordinality:"1",value:"100" }];
  if (sql.includes("pg_catalog.unnest(i.indclass)")) return [{ index_relation_oid:"54",element_ordinality:"1",value:"3126" }];
  if (sql.includes("pg_catalog.unnest(i.indoption)")) return [{ index_relation_oid:"54",element_ordinality:"1",value:"0" }];
  if (sql.includes("AS actual_opclass_oid")) return [{ actual_opclass_oid:"3126",actual_method_oid:"403",actual_input_type_oid:"25",actual_opfamily_oid:"1994",actual_family_method_oid:"403",default_opclass_oid:"3126",default_method_oid:"403",default_input_type_oid:"25",default_is_default:true }];
  if (sql.includes("AS constraint_oid") && sql.includes("conkey_count")) return [{ constraint_oid:"53",relation_oid:"50",referenced_relation_oid:"0",constraint_name:"__osnv_orm_owned_stores_v1_pkey",constraint_type_code:"p",backing_index_oid:"54",delete_action_code:"a",update_action_code:"a",match_type_code:"s",is_deferrable:false,is_initially_deferred:false,is_validated:true,parent_constraint_oid:"0",inheritance_count:"0",is_no_inherit:true,conkey_count:"1",confkey_count:"0",confdelsetcols_count:"0",conpfeqop_count:"0",conppeqop_count:"0",conffeqop_count:"0",check_definition:null }];
  if (sql.includes("pg_catalog.unnest(c.conkey)")) return [{ request_ordinality:"1",constraint_oid:"53",element_ordinality:"1",attribute_number:"1",resolved_attribute_number:"1",column_name:"store_key" }];
  if (sql.includes("pg_catalog.unnest(c.confkey)") || sql.includes("pg_catalog.unnest(c.confdelsetcols)") || sql.includes("pg_catalog.unnest(c.conpfeqop)") || sql.includes("pg_catalog.unnest(c.conppeqop)") || sql.includes("pg_catalog.unnest(c.conffeqop)")) return [];
  if (sql.includes("AS class_oid")) return ["pg_class","pg_type","pg_constraint","pg_attrdef","pg_namespace","pg_proc","pg_rewrite","pg_trigger","pg_policy"].map((class_name,index)=>({class_oid:String(index+1),class_schema:"pg_catalog",class_name}));
  if (sql.includes("FROM pg_catalog.pg_depend")) return [["1","50","0","5","12000","0","n"],["2","51","0","1","50","0","i"],["2","52","0","2","51","0","i"],["3","53","0","1","50","1","a"],["1","54","0","3","53","0","i"]].map(([dependent_class_oid,dependent_oid,dependent_sub_id,referenced_class_oid,referenced_oid,referenced_sub_id,dependency_type])=>({dependent_class_oid,dependent_oid,dependent_sub_id,referenced_class_oid,referenced_oid,referenced_sub_id,dependency_type}));
  if (sql.includes("pg_catalog.pg_trigger") || sql.includes("pg_catalog.pg_rewrite") || sql.includes("pg_catalog.pg_policy") || sql.includes("pg_catalog.pg_inherits")) return [];
  if (sql.includes("FROM \"public\".\"__osnv_orm_owned_stores_v1\"")) return [];
  return undefined;
}

function fixtureOidArray(value: unknown): readonly string[] { if (typeof value !== "string" || !/^\{[1-9][0-9]*(?:,[1-9][0-9]*)*\}$/u.test(value)) throw new Error("invalid fixture oid array"); return value.slice(1,-1).split(","); }

const projectorDefinition=defineOrmOwnedStoreV1({contract:"osnv.orm-owned-store/v1",storeKey:"b2",formatVersion:1,ownedScope:{schema:"public",tablePrefix:"osnv_"}});
const projectorExpected:OrmExpectedSchema={tables:[{schema:"public",table:"osnv_items",columns:[{property:"id",column:"id",physicalType:"integer",nullable:false,default:{kind:"number",value:1},generation:"none"}],primaryKey:{name:"pk_items",columns:["id"]},indexes:[{name:"ix_items_id",columns:["id"],unique:false,method:"btree"}],foreignKeys:[],checks:[{name:"ck_items_id",expression:{kind:"compare",op:">=",left:"id",right:1}}]}]};
const projectorPrepared=Object.freeze({definition:projectorDefinition,expected:projectorExpected,ownedScopeHash:canonicalOwnedStoreScopeHashV1(projectorDefinition) as `sha256:${string}`,modelHash:canonicalOwnedStoreModelHashV1(projectorDefinition,projectorExpected) as `sha256:${string}`});
const projectorIdentityWire=Object.freeze({store_key:"b2",contract:"osnv.orm-owned-store/v1",format_version:"1",owned_schema:"public",table_prefix:"osnv_",owned_scope_hash:projectorPrepared.ownedScopeHash,model_hash:projectorPrepared.modelHash,created_at_epoch_microseconds:"0"});
const admissionExpected: OrmExpectedSchema = { tables: [{ ...projectorExpected.tables[0]!, columns: [{ ...projectorExpected.tables[0]!.columns[0]!, default: { kind: "none" } }] }] };
const admissionPrepared = Object.freeze({ definition: projectorDefinition, expected: admissionExpected, ownedScopeHash: canonicalOwnedStoreScopeHashV1(projectorDefinition) as `sha256:${string}`, modelHash: canonicalOwnedStoreModelHashV1(projectorDefinition, admissionExpected) as `sha256:${string}` });
const admissionIdentityWire = Object.freeze({ ...projectorIdentityWire, model_hash: admissionPrepared.modelHash });
function catalogueProjectorSqlFacts(sql: string, params: readonly unknown[]): unknown[] | undefined {
  const oidRows = (values: readonly string[], make: (oid: string) => Record<string, unknown>): Record<string, unknown>[] => values.map(oid => {
    if (!["10", "12", "13"].includes(oid)) throw new Error(`unknown fixture OID: ${oid}`);
    return make(oid);
  });
  const requested = (): readonly string[] => fixtureOidArray(params[0]);
  const index = (oid: string) => {
    if (oid !== "12" && oid !== "13") throw new Error(`unknown fixture index OID: ${oid}`);
    return oid === "12";
  };
  if (sql.includes("SELECT n.nspname AS schema_name")) return [{ schema_name: "public" }];
  if (sql.includes("pg_catalog.left(c.relname")) return [{ relation_oid: "10" }];
  if (sql.includes("SELECT i.indexrelid::pg_catalog.text AS index_relation_oid FROM pg_catalog.pg_index")) return [{ index_relation_oid: "12" }, { index_relation_oid: "13" }];
  if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class")) return oidRows(requested(), oid => {
    const primary = index(oid);
    return { index_relation_oid: oid, table_relation_oid: "10", index_name: primary ? "pk_items" : "ix_items_id", method_oid: "403", method_name: "btree", is_unique: primary, is_primary: primary, is_exclusion: false, is_immediate: true, is_valid: true, is_ready: true, is_live: true, is_replica_identity: false, nulls_not_distinct: false, key_attribute_count: "1", total_attribute_count: "1", index_expression: null, index_predicate: null, backing_constraint_oid: primary ? "16" : null };
  });
  if (sql.includes("pg_catalog.unnest(i.indkey)")) return oidRows(requested(), oid => ({ index_relation_oid: oid, element_ordinality: "1", value: "1", resolved_attnum: "1", column_name: "id" }));
  if (sql.includes("pg_catalog.unnest(i.indcollation)")) return oidRows(requested(), oid => ({ index_relation_oid: oid, element_ordinality: "1", value: "0" }));
  if (sql.includes("pg_catalog.unnest(i.indclass)")) return oidRows(requested(), oid => ({ index_relation_oid: oid, element_ordinality: "1", value: "3124" }));
  if (sql.includes("pg_catalog.unnest(i.indoption)")) return oidRows(requested(), oid => ({ index_relation_oid: oid, element_ordinality: "1", value: "0" }));
  if (sql.includes("AS actual_opclass_oid")) {
    for (const oid of requested()) if (oid !== "3124") throw new Error(`unknown fixture opclass OID: ${oid}`);
    return [{ actual_opclass_oid: "3124", actual_method_oid: "403", actual_input_type_oid: "20", actual_opfamily_oid: "1976", actual_family_method_oid: "403", default_opclass_oid: "3124", default_method_oid: "403", default_input_type_oid: "20", default_is_default: true }];
  }
  if (sql.includes("AS constraint_oid") && sql.includes("conkey_count")) return [{ constraint_oid: "17", relation_oid: "10", referenced_relation_oid: "0", constraint_name: "ck_items_id", constraint_type_code: "c", backing_index_oid: "0", delete_action_code: "a", update_action_code: "a", match_type_code: "s", is_deferrable: false, is_initially_deferred: false, is_validated: true, parent_constraint_oid: "0", inheritance_count: "0", is_no_inherit: false, conkey_count: "1", confkey_count: "0", confdelsetcols_count: "0", conpfeqop_count: "0", conppeqop_count: "0", conffeqop_count: "0", check_definition: "CHECK (id >= 1)" }, { constraint_oid: "16", relation_oid: "10", referenced_relation_oid: "0", constraint_name: "pk_items", constraint_type_code: "p", backing_index_oid: "12", delete_action_code: "a", update_action_code: "a", match_type_code: "s", is_deferrable: false, is_initially_deferred: false, is_validated: true, parent_constraint_oid: "0", inheritance_count: "0", is_no_inherit: true, conkey_count: "1", confkey_count: "0", confdelsetcols_count: "0", conpfeqop_count: "0", conppeqop_count: "0", conffeqop_count: "0", check_definition: null }];
  if (sql.includes("pg_catalog.unnest(c.conkey)")) return requested().flatMap((oid, index) => {
    if (oid !== "17" && oid !== "16") throw new Error(`unknown fixture constraint OID: ${oid}`);
    return [{ request_ordinality: String(index + 1), constraint_oid: oid, element_ordinality: "1", attribute_number: "1", resolved_attribute_number: "1", column_name: "id" }];
  });
  if (sql.includes("pg_catalog.unnest(c.confkey)") || sql.includes("pg_catalog.unnest(c.confdelsetcols)") || sql.includes("pg_catalog.unnest(c.conpfeqop)") || sql.includes("pg_catalog.unnest(c.conppeqop)") || sql.includes("pg_catalog.unnest(c.conffeqop)")) return [];
  if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return oidRows(requested(), oid => oid === "10" ? { oid, namespace_oid: "12000", schema_name: "public", relation_name: "osnv_items", relkind: "r", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "d", tablespace_oid: "0", access_method: "heap", row_type_oid: "11", toast_relation_oid: "0" } : { oid, namespace_oid: "12000", schema_name: "public", relation_name: oid === "12" ? "pk_items" : "ix_items_id", relkind: "i", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "btree", row_type_oid: "0", toast_relation_oid: "0" });
  if (sql.includes("option_count")) return oidRows(requested(), relation_oid => ({ relation_oid, option_count: "0" }));
  if (sql.includes("AS row_type_oid")) return [{ row_type_oid: "11", relation_oid: "10", schema_name: "public", type_name: "osnv_items", typtype: "c", array_type_oid: "15", array_relation_oid: "0", array_schema_name: "public", array_type_name: "_osnv_items", array_typtype: "b", array_typcategory: "A", array_element_oid: "11", array_array_oid: "0" }];
  if (sql.includes("FROM pg_catalog.pg_attribute")) return [{ relation_oid: "10", attnum: "1", column_name: "id", dropped: false, local: true, inheritance_count: "0", physical_type: "bigint", type_oid: "20", not_null: true, default_object_oid: "14", default_expression: "1", identity_code: "", generated_code: "", collation_oid: "0", type_default_collation_oid: "0", storage_code: "p", type_default_storage_code: "p", compression_code: "", has_default: true }];
  if (sql.includes("AS class_oid")) return ["pg_class", "pg_type", "pg_constraint", "pg_attrdef", "pg_namespace", "pg_proc", "pg_rewrite", "pg_trigger", "pg_policy"].map((class_name, index) => ({ class_oid: String(index + 1), class_schema: "pg_catalog", class_name }));
  if (sql.includes("FROM pg_catalog.pg_depend")) return [["1", "10", "0", "5", "12000", "0", "n"], ["2", "11", "0", "1", "10", "0", "i"], ["2", "15", "0", "2", "11", "0", "i"], ["4", "14", "0", "1", "10", "1", "a"], ["3", "16", "0", "1", "10", "1", "a"], ["1", "12", "0", "3", "16", "0", "i"], ["1", "13", "0", "1", "10", "1", "a"], ["3", "17", "0", "1", "10", "1", "a"], ["3", "17", "0", "1", "10", "1", "n"]].map(([dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type]) => ({ dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type }));
  if (sql.includes("pg_catalog.pg_trigger") || sql.includes("pg_catalog.pg_rewrite") || sql.includes("pg_catalog.pg_policy") || sql.includes("pg_catalog.pg_inherits")) return [];
  return undefined;
}

function registryProjectorRecorder(override?: (sql:string,params:readonly unknown[])=>unknown|undefined, options?: { readonly redactSqlParams?: boolean }){const events:string[]=[],queries:{sql:string;params:readonly unknown[]}[]=[],traces:{tag:string;params:readonly unknown[]}[]=[];let roots=0,reserves=0;const provider=new PostgresProvider({options:{},redactSqlParams:options?.redactSqlParams,onSql:(tag:string,params:readonly unknown[])=>{traces.push({tag,params});}});const session={unsafe:async(sql:string,params:readonly unknown[]=[])=>{queries.push({sql,params});events.push(sql);const overridden=override?.(sql,params);if(overridden!==undefined)return overridden;if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL search_path")||sql.includes("pg_catalog.pg_advisory_xact_lock"))return[];if(sql.includes("max_identifier_length"))return[{max_identifier_length:"63"}];if(sql.startsWith("SELECT EXISTS"))return[{public_schema_exists:true}];const facts=registryProjectorSqlFacts(sql,params);if(facts!==undefined)return facts;throw new Error(`unexpected SQL: ${sql}`);},release:async()=>{events.push("release");}};Object.defineProperty(provider,"sql",{configurable:true,value:{close:async()=>{},unsafe:async()=>{roots++;throw new Error("root");},reserve:async()=>{reserves++;return session;}}});const capability=postgresOwnedStoreCapability(provider);if(!capability)throw new Error("missing capability");return{provider,capability,events,queries,traces,counts:()=>({roots,reserves})};}

const foreignProjectorDefinition = defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey: "b2Foreign", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "osnv_" } });
const foreignProjectorExpected: OrmExpectedSchema = { tables: [
  { ...projectorExpected.tables[0]!, table: "osnv_a_items", primaryKey: { name: "pk_a_items", columns: ["id"] }, indexes: [{ name: "ix_a_items_id", columns: ["id"], unique: false, method: "btree" }], foreignKeys: [{ name: "fk_a_b", columns: ["id"], target: { schema: "public", table: "osnv_b_items" }, targetColumns: ["id"], onDelete: "cascade", onUpdate: "noAction" }] },
  { ...projectorExpected.tables[0]!, table: "osnv_b_items", primaryKey: { name: "pk_b_items", columns: ["id"] }, indexes: [{ name: "ix_b_items_id", columns: ["id"], unique: false, method: "btree" }] },
] };

function foreignCatalogueProjectorSqlFacts(sql: string, params: readonly unknown[]): unknown[] | undefined {
  const requested = () => fixtureOidArray(params[0]);
  const table = (oid: string) => oid === "10" ? "a" : oid === "110" ? "b" : undefined;
  const index = (oid: string) => oid === "12" || oid === "13" ? ["10", oid === "12" ? "16" : null, oid === "12"] as const : oid === "112" || oid === "113" ? ["110", oid === "112" ? "116" : null, oid === "112"] as const : undefined;
  const relations = (make: (oid: string) => Record<string, unknown>) => requested().map(oid => { if (!["10", "110", "12", "13", "112", "113"].includes(oid)) throw new Error(`unknown FK fixture OID: ${oid}`); return make(oid); });
  if (sql.includes("SELECT n.nspname AS schema_name")) return [{ schema_name: "public" }];
  if (sql.includes("pg_catalog.left(c.relname")) return [{ relation_oid: "10" }, { relation_oid: "110" }];
  if (sql.includes("SELECT i.indexrelid::pg_catalog.text AS index_relation_oid FROM pg_catalog.pg_index AS i WHERE")) return ["12", "13", "112", "113"].map(index_relation_oid => ({ index_relation_oid }));
  if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class")) return relations(index_relation_oid => { const fact = index(index_relation_oid); if (!fact) throw new Error("non-index request"); const [table_relation_oid, backing_constraint_oid, primary] = fact; const side = table_relation_oid === "10" ? "a" : "b"; return { index_relation_oid, table_relation_oid, index_name: primary ? `pk_${side}_items` : `ix_${side}_items_id`, method_oid: "403", method_name: "btree", is_unique: primary, is_primary: primary, is_exclusion: false, is_immediate: true, is_valid: true, is_ready: true, is_live: true, is_replica_identity: false, nulls_not_distinct: false, key_attribute_count: "1", total_attribute_count: "1", index_expression: null, index_predicate: null, backing_constraint_oid }; });
  if (sql.includes("pg_catalog.unnest(i.indkey)")) return relations(index_relation_oid => ({ index_relation_oid, element_ordinality: "1", value: "1", resolved_attnum: "1", column_name: "id" }));
  if (sql.includes("pg_catalog.unnest(i.indcollation)")) return relations(index_relation_oid => ({ index_relation_oid, element_ordinality: "1", value: "0" }));
  if (sql.includes("pg_catalog.unnest(i.indclass)")) return relations(index_relation_oid => ({ index_relation_oid, element_ordinality: "1", value: "3124" }));
  if (sql.includes("pg_catalog.unnest(i.indoption)")) return relations(index_relation_oid => ({ index_relation_oid, element_ordinality: "1", value: "0" }));
  if (sql.includes("AS actual_opclass_oid") && !sql.includes("fk_input AS")) { for (const oid of requested()) if (oid !== "3124") throw new Error("unknown FK opclass"); return [{ actual_opclass_oid: "3124", actual_method_oid: "403", actual_input_type_oid: "20", actual_opfamily_oid: "1976", actual_family_method_oid: "403", default_opclass_oid: "3124", default_method_oid: "403", default_input_type_oid: "20", default_is_default: true }]; }
  if (sql.includes("AS constraint_oid") && sql.includes("conkey_count")) return [
    ["17", "10", "0", "ck_items_id", "c", "0", "a"], ["118", "10", "110", "fk_a_b", "f", "112", "c"], ["16", "10", "0", "pk_a_items", "p", "12", "a"], ["117", "110", "0", "ck_items_id", "c", "0", "a"], ["116", "110", "0", "pk_b_items", "p", "112", "a"],
  ].map(([constraint_oid, relation_oid, referenced_relation_oid, constraint_name, constraint_type_code, backing_index_oid, delete_action_code]) => ({ constraint_oid, relation_oid, referenced_relation_oid, constraint_name, constraint_type_code, backing_index_oid, delete_action_code, update_action_code: "a", match_type_code: "s", is_deferrable: false, is_initially_deferred: false, is_validated: true, parent_constraint_oid: "0", inheritance_count: "0", is_no_inherit: constraint_type_code === "c" ? false : true, conkey_count: "1", confkey_count: constraint_type_code === "f" ? "1" : "0", confdelsetcols_count: "0", conpfeqop_count: constraint_type_code === "f" ? "1" : "0", conppeqop_count: constraint_type_code === "f" ? "1" : "0", conffeqop_count: constraint_type_code === "f" ? "1" : "0", check_definition: constraint_type_code === "c" ? "CHECK (id >= 1)" : null }));
  if (sql.includes("pg_catalog.unnest(c.conkey)")) return requested().map((constraint_oid, index) => ({ request_ordinality: String(index + 1), constraint_oid, element_ordinality: "1", attribute_number: "1", resolved_attribute_number: "1", column_name: "id" }));
  if (sql.includes("pg_catalog.unnest(c.confkey)")) return [{ request_ordinality: String(requested().indexOf("118") + 1), constraint_oid: "118", element_ordinality: "1", attribute_number: "1", resolved_attribute_number: "1", column_name: "id" }];
  if (sql.includes("pg_catalog.unnest(c.confdelsetcols)")) return [];
  if (sql.includes("pg_catalog.unnest(c.conpfeqop)") || sql.includes("pg_catalog.unnest(c.conppeqop)") || sql.includes("pg_catalog.unnest(c.conffeqop)")) return [{ request_ordinality: String(requested().indexOf("118") + 1), constraint_oid: "118", element_ordinality: "1", operator_oid: "99" }];
  if (sql.includes("fk_input AS")) return [{ request_ordinality: "1", fk_oid: "118", fk_position: "1", source_attnum: "1", referenced_attnum: "1", target_pk_constraint_oid: "116", target_pk_key_count: "1", target_pk_position: "1", target_index_oid: "112", target_index_key_count: "1", target_index_position: "1", actual_opclass_oid: "3124", opfamily_oid: "1976", opclass_method_oid: "403", opfamily_method_oid: "403", index_method_oid: "403", referenced_type_oid: "20" }];
  if (sql.includes("target_pk_constraint_oid")) return [{ request_ordinality: "1", fk_oid: "118", referenced_relation_oid: "110", referenced_supporting_index_oid: "112", target_pk_constraint_oid: "116", target_pk_backing_index_oid: "112" }];
  if (sql.includes("amop_oid")) return [{ request_ordinality: "1", requested_family_oid: "1976", requested_method_oid: "403", requested_type_oid: "20", amop_oid: "1000", amop_family_oid: "1976", amop_method_oid: "403", amop_left_type_oid: "20", amop_right_type_oid: "20", amop_purpose: "s", amop_strategy: "3", operator_oid: "99", operator_left_type_oid: "20", operator_right_type_oid: "20" }];
  if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return relations(oid => { const side = table(oid); if (side) return { oid, namespace_oid: "12000", schema_name: "public", relation_name: `osnv_${side}_items`, relkind: "r", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "d", tablespace_oid: "0", access_method: "heap", row_type_oid: side === "a" ? "11" : "111", toast_relation_oid: "0" }; const fact = index(oid)!; const [owner, , primary] = fact; const ownerSide = owner === "10" ? "a" : "b"; return { oid, namespace_oid: "12000", schema_name: "public", relation_name: primary ? `pk_${ownerSide}_items` : `ix_${ownerSide}_items_id`, relkind: "i", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "btree", row_type_oid: "0", toast_relation_oid: "0" }; });
  if (sql.includes("option_count")) return relations(relation_oid => ({ relation_oid, option_count: "0" }));
  if (sql.includes("AS row_type_oid")) return ["a", "b"].map((side, index) => { const relation_oid = index === 0 ? "10" : "110", row_type_oid = index === 0 ? "11" : "111", array_type_oid = index === 0 ? "15" : "115"; return { row_type_oid, relation_oid, schema_name: "public", type_name: `osnv_${side}_items`, typtype: "c", array_type_oid, array_relation_oid: "0", array_schema_name: "public", array_type_name: `_osnv_${side}_items`, array_typtype: "b", array_typcategory: "A", array_element_oid: row_type_oid, array_array_oid: "0" }; });
  if (sql.includes("FROM pg_catalog.pg_attribute")) return ["10", "110"].map((relation_oid, index) => ({ relation_oid, attnum: "1", column_name: "id", dropped: false, local: true, inheritance_count: "0", physical_type: "bigint", type_oid: "20", not_null: true, default_object_oid: index === 0 ? "14" : "114", default_expression: "1", identity_code: "", generated_code: "", collation_oid: "0", type_default_collation_oid: "0", storage_code: "p", type_default_storage_code: "p", compression_code: "", has_default: true }));
  if (sql.includes("FROM pg_catalog.pg_trigger")) return [["121", "10", "1644", "RI_FKey_check_ins", "5"], ["122", "10", "1645", "RI_FKey_check_upd", "17"], ["123", "110", "1646", "RI_FKey_cascade_del", "9"], ["124", "110", "1655", "RI_FKey_noaction_upd", "17"]].map(([trigger_oid, relation_oid, function_oid, function_name, type_bits], index) => ({ trigger_oid, relation_oid, trigger_name: `ri_${index}`, is_internal: true, constraint_oid: "118", parent_trigger_oid: "0", enabled_code: "O", function_oid, function_schema: "pg_catalog", function_name, type_bits }));
  if (sql.includes("pg_catalog.pg_rewrite") || sql.includes("pg_catalog.pg_policy") || sql.includes("pg_catalog.pg_inherits")) return [];
  if (sql.includes("AS class_oid")) return ["pg_class", "pg_type", "pg_constraint", "pg_attrdef", "pg_namespace", "pg_proc", "pg_rewrite", "pg_trigger", "pg_policy"].map((class_name, index) => ({ class_oid: String(index + 1), class_schema: "pg_catalog", class_name }));
  if (sql.includes("FROM pg_catalog.pg_depend")) return [["1", "10", "0", "5", "12000", "0", "n"], ["1", "12", "0", "3", "16", "0", "i"], ["1", "13", "0", "1", "10", "1", "a"], ["1", "110", "0", "5", "12000", "0", "n"], ["1", "112", "0", "3", "116", "0", "i"], ["1", "113", "0", "1", "110", "1", "a"], ["2", "11", "0", "1", "10", "0", "i"], ["2", "15", "0", "2", "11", "0", "i"], ["2", "111", "0", "1", "110", "0", "i"], ["2", "115", "0", "2", "111", "0", "i"], ["3", "16", "0", "1", "10", "1", "a"], ["3", "17", "0", "1", "10", "1", "a"], ["3", "17", "0", "1", "10", "1", "n"], ["3", "116", "0", "1", "110", "1", "a"], ["3", "117", "0", "1", "110", "1", "a"], ["3", "117", "0", "1", "110", "1", "n"], ["3", "118", "0", "1", "10", "1", "a"], ["3", "118", "0", "1", "110", "1", "n"], ["3", "118", "0", "1", "112", "0", "n"], ["4", "14", "0", "1", "10", "1", "a"], ["4", "114", "0", "1", "110", "1", "a"], ["8", "121", "0", "3", "118", "0", "i"], ["8", "122", "0", "3", "118", "0", "i"], ["8", "123", "0", "3", "118", "0", "i"], ["8", "124", "0", "3", "118", "0", "i"]].reverse().map(([dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type]) => ({ dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type }));
  return undefined;
}

const foreignIdentityExpected: OrmExpectedSchema = { tables: [{ ...foreignProjectorExpected.tables[0]!, columns: [{ ...foreignProjectorExpected.tables[0]!.columns[0]!, default: { kind: "none" }, generation: "identityByDefault" }] }, foreignProjectorExpected.tables[1]!] };

function foreignIdentityCatalogueProjectorSqlFacts(sql: string, params: readonly unknown[]): unknown[] | undefined {
  const requested = () => fixtureOidArray(params[0]);
  if (sql.includes("catalog_class_oid")) return [{ catalog_class_oid: "1" }];
  if (sql.includes("sequence_oid") && sql.includes("owner_relation_oid")) return [{ dependent_class_oid: "1", sequence_oid: "18", dependent_sub_id: "0", referenced_class_oid: "1", owner_relation_oid: "10", owner_attnum: "1", dependency_type: "i" }];
  if (sql.includes("pg_catalog.pg_sequence")) return [{ relation_oid: "18", sequence_type_oid: "20", resolved_type_oid: "20", type_schema: "pg_catalog", type_name: "int8", start_value: "1", increment_value: "1", minimum_value: "1", maximum_value: "9223372036854775807", cache_value: "1", cycle: false }];
  if (sql.includes("FROM pg_catalog.pg_attribute")) return [{ relation_oid: "10", attnum: "1", column_name: "id", dropped: false, local: true, inheritance_count: "0", physical_type: "bigint", type_oid: "20", not_null: true, default_object_oid: null, default_expression: null, identity_code: "d", generated_code: "", collation_oid: "0", type_default_collation_oid: "0", storage_code: "p", type_default_storage_code: "p", compression_code: "", has_default: false }, { relation_oid: "110", attnum: "1", column_name: "id", dropped: false, local: true, inheritance_count: "0", physical_type: "bigint", type_oid: "20", not_null: true, default_object_oid: "114", default_expression: "1", identity_code: "", generated_code: "", collation_oid: "0", type_default_collation_oid: "0", storage_code: "p", type_default_storage_code: "p", compression_code: "", has_default: true }];
  if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid") && requested().includes("18")) return requested().map(oid => oid === "18" ? { oid: "18", namespace_oid: "12000", schema_name: "public", relation_name: "actual_identity_sequence_name", relkind: "S", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: null, row_type_oid: "0", toast_relation_oid: "0" } : foreignCatalogueProjectorSqlFacts(sql, [`{${oid}}`])![0]!);
  if (sql.includes("option_count") && requested().includes("18")) return requested().map(relation_oid => ({ relation_oid, option_count: "0" }));
  if (sql.includes("FROM pg_catalog.pg_depend")) { const base = foreignCatalogueProjectorSqlFacts(sql, params)! as Record<string, unknown>[]; return [...base.filter(row => !(row.dependent_class_oid === "4" && row.dependent_oid === "14")), { dependent_class_oid: "1", dependent_oid: "18", dependent_sub_id: "0", referenced_class_oid: "5", referenced_oid: "12000", referenced_sub_id: "0", dependency_type: "n" }, { dependent_class_oid: "1", dependent_oid: "18", dependent_sub_id: "0", referenced_class_oid: "1", referenced_oid: "10", referenced_sub_id: "1", dependency_type: "i" }]; }
  return foreignCatalogueProjectorSqlFacts(sql, params);
}

function foreignIdentityToastCatalogueProjectorSqlFacts(sql: string, params: readonly unknown[]): unknown[] | undefined {
  const requested = () => fixtureOidArray(params[0]);
  const toastRelation = (oid: string) => oid === "30" ? { oid, namespace_oid: "11999", schema_name: "pg_toast", relation_name: "pg_toast_30", relkind: "t", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "heap", row_type_oid: "0", toast_relation_oid: "0" } : { oid, namespace_oid: "11999", schema_name: "pg_toast", relation_name: "pg_toast_30_index", relkind: "i", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "btree", row_type_oid: "0", toast_relation_oid: "0" };
  if (sql.includes("sequence_oid") && sql.includes("owner_relation_oid")) return foreignIdentityCatalogueProjectorSqlFacts(sql, params);
  if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid") && requested().includes("10") && !requested().includes("30")) return requested().map(oid => ({ ...foreignIdentityCatalogueProjectorSqlFacts(sql, [`{${oid}}`])![0]!, ...(oid === "10" ? { toast_relation_oid: "30" } : {}) }));
  if (sql.includes("SELECT i.indexrelid::pg_catalog.text AS index_relation_oid FROM")) return [...foreignIdentityCatalogueProjectorSqlFacts(sql, params)!, { index_relation_oid: "31" }];
  if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid") && requested().some(oid => oid === "30" || oid === "31")) return requested().map(oid => oid === "30" || oid === "31" ? toastRelation(oid) : oid === "10" ? { ...foreignIdentityCatalogueProjectorSqlFacts(sql, [`{10}`])![0]!, toast_relation_oid: "30" } : foreignIdentityCatalogueProjectorSqlFacts(sql, [`{${oid}}`])![0]!);
  if (sql.includes("option_count") && requested().some(oid => oid === "30" || oid === "31")) return requested().map(relation_oid => ({ relation_oid, option_count: "0" }));
  if (sql.includes("FROM pg_catalog.pg_attribute")) return [...foreignIdentityCatalogueProjectorSqlFacts(sql, params)!, ...[["chunk_id", "oid", "26", "p"], ["chunk_seq", "integer", "23", "p"], ["chunk_data", "bytea", "17", "x"]].map(([column_name, physical_type, type_oid, type_default_storage_code], index) => ({ relation_oid: "30", attnum: String(index + 1), column_name, dropped: false, local: true, inheritance_count: "0", physical_type, type_oid, not_null: false, default_object_oid: null, default_expression: null, identity_code: "", generated_code: "", collation_oid: "0", type_default_collation_oid: "0", storage_code: "p", type_default_storage_code, compression_code: "", has_default: false }))];
  if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class") && requested().includes("31")) return [...requested().filter(oid => oid !== "31").flatMap(oid => foreignIdentityCatalogueProjectorSqlFacts(sql, [`{${oid}}`])!), { index_relation_oid: "31", table_relation_oid: "30", index_name: "pg_toast_30_index", method_oid: "403", method_name: "btree", is_unique: true, is_primary: true, is_exclusion: false, is_immediate: true, is_valid: true, is_ready: true, is_live: true, is_replica_identity: false, nulls_not_distinct: false, key_attribute_count: "2", total_attribute_count: "2", index_expression: null, index_predicate: null, backing_constraint_oid: null }];
  const vector = (value: string, second?: string) => requested().flatMap(index_relation_oid => index_relation_oid === "31" ? [["1", value], ...(second ? [["2", second]] : [])].map(([element_ordinality, value]) => ({ index_relation_oid, element_ordinality, value, ...(sql.includes("indkey") ? { resolved_attnum: value, column_name: value === "1" ? "chunk_id" : "chunk_seq" } : {}) })) : foreignIdentityCatalogueProjectorSqlFacts(sql, [`{${index_relation_oid}}`])!);
  if (sql.includes("pg_catalog.unnest(i.indkey)")) return vector("1", "2");
  if (sql.includes("pg_catalog.unnest(i.indcollation)") || sql.includes("pg_catalog.unnest(i.indoption)")) return vector("0", "0");
  if (sql.includes("pg_catalog.unnest(i.indclass)")) return vector("1981", "1978");
  if (sql.includes("AS actual_opclass_oid") && !sql.includes("fk_input AS") && requested().some(oid => oid === "1981" || oid === "1978")) return requested().map(oid => oid === "1981" ? { actual_opclass_oid: "1981", actual_method_oid: "403", actual_input_type_oid: "26", actual_opfamily_oid: "1989", actual_family_method_oid: "403", default_opclass_oid: "1981", default_method_oid: "403", default_input_type_oid: "26", default_is_default: true } : oid === "1978" ? { actual_opclass_oid: "1978", actual_method_oid: "403", actual_input_type_oid: "23", actual_opfamily_oid: "1976", actual_family_method_oid: "403", default_opclass_oid: "1978", default_method_oid: "403", default_input_type_oid: "23", default_is_default: true } : foreignIdentityCatalogueProjectorSqlFacts(sql, [`{${oid}}`])![0]!);
  if (sql.includes("FROM pg_catalog.pg_depend")) return [...foreignIdentityCatalogueProjectorSqlFacts(sql, params)!, { dependent_class_oid: "1", dependent_oid: "30", dependent_sub_id: "0", referenced_class_oid: "1", referenced_oid: "10", referenced_sub_id: "0", dependency_type: "i" }, { dependent_class_oid: "1", dependent_oid: "31", dependent_sub_id: "0", referenced_class_oid: "1", referenced_oid: "30", referenced_sub_id: "1", dependency_type: "a" }, { dependent_class_oid: "1", dependent_oid: "31", dependent_sub_id: "0", referenced_class_oid: "1", referenced_oid: "30", referenced_sub_id: "2", dependency_type: "a" }];
  return foreignIdentityCatalogueProjectorSqlFacts(sql, params);
}

function registryToastProjectorSqlFacts(sql: string, params: readonly unknown[]): unknown[] | undefined {
  const requested = (): readonly string[] => fixtureOidArray(params[0]);
  const rows = (allowed: readonly string[], make: (oid: string) => Record<string, unknown>): Record<string, unknown>[] => requested().map(oid => {
    if (!allowed.includes(oid)) throw new Error(`unknown Registry TOAST fixture OID: ${oid}`);
    return make(oid);
  });
  const relation = (oid: string) => {
    if (oid === "50") return { oid, namespace_oid: "12000", schema_name: "public", relation_name: "__osnv_orm_owned_stores_v1", relkind: "r", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "d", tablespace_oid: "0", access_method: "heap", row_type_oid: "51", toast_relation_oid: "55" };
    if (oid === "54") return { oid, namespace_oid: "12000", schema_name: "public", relation_name: "__osnv_orm_owned_stores_v1_pkey", relkind: "i", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "btree", row_type_oid: "0", toast_relation_oid: "0" };
    if (oid === "55") return { oid, namespace_oid: "11999", schema_name: "pg_toast", relation_name: "pg_toast_55", relkind: "t", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "heap", row_type_oid: "0", toast_relation_oid: "0" };
    if (oid === "56") return { oid, namespace_oid: "11999", schema_name: "pg_toast", relation_name: "pg_toast_55_index", relkind: "i", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "btree", row_type_oid: "0", toast_relation_oid: "0" };
    throw new Error(`unknown Registry TOAST relation OID: ${oid}`);
  };
  if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return rows(["50", "54", "55", "56"], relation);
  if (sql.includes("AS option_count")) return rows(["50", "54", "55", "56"], relation_oid => ({ relation_oid, option_count: "0" }));
  if (sql.includes("FROM pg_catalog.pg_attribute")) return requested().flatMap(relation_oid => {
    if (relation_oid === "50") return [["store_key", "text", "25", "true", "100", "x"], ["contract", "text", "25", "true", "100", "x"], ["format_version", "bigint", "20", "true", "0", "p"], ["owned_schema", "text", "25", "true", "100", "x"], ["table_prefix", "text", "25", "true", "100", "x"], ["owned_scope_hash", "text", "25", "true", "100", "x"], ["model_hash", "text", "25", "true", "100", "x"], ["created_at", "timestamp with time zone", "1184", "true", "0", "p"]].map(([column_name, physical_type, type_oid, not_null, collation_oid, storage_code], index) => ({ relation_oid, attnum: String(index + 1), column_name, dropped: false, local: true, inheritance_count: "0", physical_type, type_oid, not_null: not_null === "true", default_object_oid: null, default_expression: null, identity_code: "", generated_code: "", collation_oid, type_default_collation_oid: collation_oid, storage_code, type_default_storage_code: storage_code, compression_code: "", has_default: false }));
    if (relation_oid === "55") return [["chunk_id", "oid", "26", "p"], ["chunk_seq", "integer", "23", "p"], ["chunk_data", "bytea", "17", "x"]].map(([column_name, physical_type, type_oid, type_default_storage_code], index) => ({ relation_oid, attnum: String(index + 1), column_name, dropped: false, local: true, inheritance_count: "0", physical_type, type_oid, not_null: false, default_object_oid: null, default_expression: null, identity_code: "", generated_code: "", collation_oid: "0", type_default_collation_oid: "0", storage_code: "p", type_default_storage_code: type_default_storage_code!, compression_code: "", has_default: false }));
    throw new Error(`unknown Registry TOAST attribute relation OID: ${relation_oid}`);
  });
  if (sql.includes("SELECT i.indexrelid::pg_catalog.text AS index_relation_oid FROM pg_catalog.pg_index")) return [{ index_relation_oid: "54" }, { index_relation_oid: "56" }];
  if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class")) return rows(["54", "56"], index_relation_oid => index_relation_oid === "54"
    ? { index_relation_oid, table_relation_oid: "50", index_name: "__osnv_orm_owned_stores_v1_pkey", method_oid: "403", method_name: "btree", is_unique: true, is_primary: true, is_exclusion: false, is_immediate: true, is_valid: true, is_ready: true, is_live: true, is_replica_identity: false, nulls_not_distinct: false, key_attribute_count: "1", total_attribute_count: "1", index_expression: null, index_predicate: null, backing_constraint_oid: "53" }
    : { index_relation_oid, table_relation_oid: "55", index_name: "pg_toast_55_index", method_oid: "403", method_name: "btree", is_unique: true, is_primary: true, is_exclusion: false, is_immediate: true, is_valid: true, is_ready: true, is_live: true, is_replica_identity: false, nulls_not_distinct: false, key_attribute_count: "2", total_attribute_count: "2", index_expression: null, index_predicate: null, backing_constraint_oid: null });
  const vector = (values: Record<string, readonly (readonly [string, string, string?])[]>): Record<string, unknown>[] => requested().flatMap(index_relation_oid => {
    if (index_relation_oid !== "54" && index_relation_oid !== "56") throw new Error(`unknown Registry TOAST vector index OID: ${index_relation_oid}`);
    return (values[index_relation_oid] ?? []).map(([element_ordinality, value, column_name]) => ({ index_relation_oid, element_ordinality, value, ...(column_name === undefined ? {} : { resolved_attnum: value, column_name }) }));
  });
  if (sql.includes("pg_catalog.unnest(i.indkey)")) return vector({ "54": [["1", "1", "store_key"]], "56": [["1", "1", "chunk_id"], ["2", "2", "chunk_seq"]] });
  if (sql.includes("pg_catalog.unnest(i.indcollation)")) return vector({ "54": [["1", "100"]], "56": [["1", "0"], ["2", "0"]] });
  if (sql.includes("pg_catalog.unnest(i.indclass)")) return vector({ "54": [["1", "3126"]], "56": [["1", "1981"], ["2", "1978"]] });
  if (sql.includes("pg_catalog.unnest(i.indoption)")) return vector({ "54": [["1", "0"]], "56": [["1", "0"], ["2", "0"]] });
  if (sql.includes("AS actual_opclass_oid")) return requested().map(oid => {
    const facts = { "3126": ["25", "1994"], "1981": ["26", "1989"], "1978": ["23", "1976"] } as const;
    const value = facts[oid as keyof typeof facts]; if (!value) throw new Error(`unknown Registry TOAST opclass OID: ${oid}`);
    return { actual_opclass_oid: oid, actual_method_oid: "403", actual_input_type_oid: value[0], actual_opfamily_oid: value[1], actual_family_method_oid: "403", default_opclass_oid: oid, default_method_oid: "403", default_input_type_oid: value[0], default_is_default: true };
  });
  if (sql.includes("FROM pg_catalog.pg_depend")) return [["1", "50", "0", "5", "12000", "0", "n"], ["2", "51", "0", "1", "50", "0", "i"], ["2", "52", "0", "2", "51", "0", "i"], ["3", "53", "0", "1", "50", "1", "a"], ["1", "54", "0", "3", "53", "0", "i"], ["1", "55", "0", "1", "50", "0", "i"], ["1", "56", "0", "1", "55", "1", "a"], ["1", "56", "0", "1", "55", "2", "a"]].map(([dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type]) => ({ dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type }));
  return undefined;
}

test("actual PostgresProvider projects and validates a complete empty Registry",async()=>{const recorder=registryProjectorRecorder();const raw=await recorder.capability.withOwnedStoreAdmission(undefined,registry=>registry.inspectRegistry());const parsed=parseOwnedStoreRegistrySnapshotV1(raw,[],{maxIdentifierLength:63n});if(raw.state.kind!=="present"||parsed.state.kind!=="present")throw new Error("missing present Registry");validateFixedRegistryShapeV1(parsed.state.shape);expect(raw).toEqual(parsed);expect(parsed).not.toBe(raw);expect(raw.state.rows).toEqual([]);expect(raw.state.shape.columns.map(value=>value.name)).toEqual(["store_key","contract","format_version","owned_schema","table_prefix","owned_scope_hash","model_hash","created_at"]);expect(raw.state.shape.columns.map(value=>value.physicalType)).toEqual(["text","text","integer","text","text","text","text","datetime"]);expect(raw.state.shape.catalogClasses.map(value=>value.oid)).toEqual(["1","2","3","5"]);expect(raw.state.shape.rowType.oid).toBe("51");expect(raw.state.shape.arrayType.elementTypeOid).toBe("51");expect(raw.state.shape.indexes).toHaveLength(1);expect(raw.state.shape.indexRelations[0]?.oid).toBe("54");expect(raw.state.shape.dependencies).toHaveLength(5);expect(raw.state.shape.toast).toBeNull();for(const value of [raw,raw.state,raw.state.shape,raw.state.rows,raw.state.shape.columns,raw.state.shape.indexes,raw.state.shape.indexRelations,raw.state.shape.constraints,raw.state.shape.triggers,raw.state.shape.rules,raw.state.shape.policies,raw.state.shape.inheritance,raw.state.shape.sequences,raw.state.shape.dependencies])expect(Object.isFrozen(value)).toBe(true);expect(recorder.counts()).toEqual({roots:0,reserves:1});expect(recorder.events.filter(value=>value==="COMMIT")).toHaveLength(1);expect(recorder.events.filter(value=>value==="release")).toHaveLength(1);expect(recorder.events).not.toContain("ROLLBACK");});

test("actual PostgresProvider rejects a Registry root relation with the wrong physical kind", async () => {
  const recorder = registryProjectorRecorder((sql, params) => {
    if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return [{ oid: "50", namespace_oid: "12000", schema_name: "public", relation_name: "__osnv_orm_owned_stores_v1", relkind: "i", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "btree", row_type_oid: "0", toast_relation_oid: "0" }];
    return registryProjectorSqlFacts(sql, params);
  });
  const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, registry => registry.inspectRegistry()));
  if (result.ok) throw new Error("wrong Registry root kind unexpectedly succeeded");
  ownedError(result.error, "ORM_OWNED_STORE_DRIFT");
  const rootQuery = recorder.queries.find(query => query.sql.includes("__osnv_orm_owned_stores_v1") && query.sql.includes("AS relation_oid"));
  expect(rootQuery).toBeDefined(); expect(rootQuery?.params).toEqual([]); expect(rootQuery?.sql).toContain("n.nspname = 'public'"); expect(rootQuery?.sql).toContain("c.relname = '__osnv_orm_owned_stores_v1'"); expect(rootQuery?.sql).not.toContain("relkind"); expect(rootQuery?.sql).not.toContain("LIMIT");
  expect(recorder.queries.some(query => query.sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))).toBe(true); expect(recorder.queries.some(query => query.sql.includes("option_count"))).toBe(true);
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(1); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events).not.toContain("COMMIT"); expect(recorder.events.some(value => /CREATE|INSERT/u.test(value))).toBe(false);
});

test("actual PostgresProvider projects and validates the fixed Registry TOAST closure", async () => {
  const recorder = registryProjectorRecorder(registryToastProjectorSqlFacts);
  const raw = await recorder.capability.withOwnedStoreAdmission(undefined, registry => registry.inspectRegistry());
  const parsed = parseOwnedStoreRegistrySnapshotV1(raw, [], { maxIdentifierLength: 63n });
  if (raw.state.kind !== "present" || parsed.state.kind !== "present" || raw.state.shape.toast === null) throw new Error("missing Registry TOAST");
  validateFixedRegistryShapeV1(parsed.state.shape);
  expect(raw).toEqual(parsed); expect(raw.state.shape.toast.relation.oid).toBe("55"); expect(raw.state.shape.toast.indexRelations[0]?.oid).toBe("56"); expect(raw.state.shape.dependencies).toHaveLength(5); expect(raw.state.shape.toast.dependencies).toHaveLength(3); expect(recursivelyFrozen(raw)).toBe(true);
  expect(recorder.queries.find(query => query.sql.includes("FROM pg_catalog.pg_depend"))?.sql.endsWith("LIMIT 65513")).toBe(true);
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => value.startsWith("CREATE") || value.startsWith("INSERT"))).toBe(false);
});

const registryToastLedger = (extra: readonly Record<string, unknown>[] = []): readonly Record<string, unknown>[] => {
  const base: readonly Record<string, unknown>[] = [["1", "50", "0", "5", "12000", "0", "n"], ["2", "51", "0", "1", "50", "0", "i"], ["2", "52", "0", "2", "51", "0", "i"], ["3", "53", "0", "1", "50", "1", "a"], ["1", "54", "0", "3", "53", "0", "i"], ["1", "55", "0", "1", "50", "0", "i"], ["1", "56", "0", "1", "55", "1", "a"], ["1", "56", "0", "1", "55", "2", "a"]].map(([dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type]) => ({ dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type }));
  return [...base, ...extra];
};
const registryToastRecorder = (dependencies: readonly Record<string, unknown>[]) => registryProjectorRecorder((sql, params) => sql.includes("FROM pg_catalog.pg_depend") ? dependencies : registryToastProjectorSqlFacts(sql, params));
const dependencyOrder = (left: { dependentClassOid: string; dependentOid: string; dependentSubId: string; referencedClassOid: string; referencedOid: string; referencedSubId: string; kind: string }, right: typeof left): number => [left.dependentClassOid, left.dependentOid, left.dependentSubId, left.referencedClassOid, left.referencedOid, left.referencedSubId].map((value, index) => Number(value) - Number([right.dependentClassOid, right.dependentOid, right.dependentSubId, right.referencedClassOid, right.referencedOid, right.referencedSubId][index]!)).find(value => value !== 0) ?? left.kind.localeCompare(right.kind);

test("actual PostgresProvider retains referenced-only and cross-class Registry TOAST dependency facts before the verifier rejects extras", async () => {
  const recorder = registryToastRecorder(registryToastLedger([{ dependent_class_oid: "3", dependent_oid: "53", dependent_sub_id: "0", referenced_class_oid: "1", referenced_oid: "55", referenced_sub_id: "0", dependency_type: "n" }, { dependent_class_oid: "2", dependent_oid: "55", dependent_sub_id: "0", referenced_class_oid: "1", referenced_oid: "50", referenced_sub_id: "0", dependency_type: "n" }]));
  const raw = await recorder.capability.withOwnedStoreAdmission(undefined, registry => registry.inspectRegistry());
  const parsed = parseOwnedStoreRegistrySnapshotV1(raw, [], { maxIdentifierLength: 63n });
  if (raw.state.kind !== "present" || parsed.state.kind !== "present") throw new Error("missing Registry");
  const parsedShape = parsed.state.shape;
  const dependencies = [...raw.state.shape.dependencies, ...raw.state.shape.toast!.dependencies];
  const fields = (value: typeof dependencies[number]) => [value.dependentClassOid, value.dependentOid, value.dependentSubId, value.referencedClassOid, value.referencedOid, value.referencedSubId, value.kind] as const;
  expect(raw.state.shape.dependencies).toHaveLength(7); expect(raw.state.shape.toast!.dependencies).toHaveLength(3); expect(dependencies).toHaveLength(10); expect(raw.state.shape.dependencies).toEqual([...raw.state.shape.dependencies].sort(dependencyOrder)); expect(raw.state.shape.toast!.dependencies).toEqual([...raw.state.shape.toast!.dependencies].sort(dependencyOrder)); expect(raw.state.shape.dependencies.map(fields)).toEqual([["1", "50", "0", "5", "12000", "0", "normal"], ["1", "54", "0", "3", "53", "0", "internal"], ["2", "51", "0", "1", "50", "0", "internal"], ["2", "52", "0", "2", "51", "0", "internal"], ["2", "55", "0", "1", "50", "0", "normal"], ["3", "53", "0", "1", "50", "1", "automatic"], ["3", "53", "0", "1", "55", "0", "normal"]]); expect(raw.state.shape.toast!.dependencies.map(fields)).toEqual([["1", "55", "0", "1", "50", "0", "internal"], ["1", "56", "0", "1", "55", "1", "automatic"], ["1", "56", "0", "1", "55", "2", "automatic"]]); expect(new Set(dependencies.map(value => `${value.dependentClassOid}/${value.dependentOid}/${value.dependentSubId}/${value.referencedClassOid}/${value.referencedOid}/${value.referencedSubId}/${value.kind}`)).size).toBe(10); expect(recursivelyFrozen(raw)).toBe(true);
  expect(() => validateFixedRegistryShapeV1(parsedShape)).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => value.startsWith("CREATE") || value.startsWith("INSERT"))).toBe(false);
});

for (const [count, code] of [[65512, undefined], [65513, "ORM_OWNED_STORE_DRIFT"], [65514, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"]] as const) test(`actual PostgresProvider Registry TOAST aggregate dependency boundary ${count}`, async () => {
  const extra = Array.from({ length: count - 8 }, (_, index) => ({ dependent_class_oid: "1", dependent_oid: "55", dependent_sub_id: String(index + 100), referenced_class_oid: "1", referenced_oid: "50", referenced_sub_id: "0", dependency_type: "i" }));
  const recorder = registryToastRecorder(registryToastLedger(extra));
  const result = await Promise.resolve().then(() => recorder.capability.withOwnedStoreAdmission(undefined, registry => registry.inspectRegistry())).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  expect(recorder.queries.find(query => query.sql.includes("FROM pg_catalog.pg_depend"))?.sql.endsWith("LIMIT 65513")).toBe(true); expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 });
  if (code) { if (result.ok) throw new Error("oversize TOAST dependency ledger succeeded"); ownedError(result.error, code); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(1); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(0); }
  else { if (!result.ok || result.value.state.kind !== "present") throw result.ok ? new Error("missing Registry") : result.error; const shape = result.value.state.shape; expect(shape.dependencies).toHaveLength(5); expect(shape.toast!.dependencies).toHaveLength(65507); expect(shape.dependencies.length + shape.toast!.dependencies.length).toBe(65512); expect(shape.triggers).toEqual([]); expect(shape.rules).toEqual([]); expect(shape.policies).toEqual([]); expect(shape.inheritance).toEqual([]); expect(shape.sequences).toEqual([]); const total = 3 + shape.catalogClasses.length + shape.columns.length + shape.indexes.length + shape.indexRelations.length + shape.constraints.length + shape.triggers.length + shape.rules.length + shape.policies.length + shape.inheritance.length + shape.sequences.length + 1 + shape.toast!.columns.length + shape.toast!.indexes.length + shape.toast!.indexRelations.length + shape.dependencies.length + shape.toast!.dependencies.length; expect(total).toBe(65536); expect(recursivelyFrozen(result.value)).toBe(true); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); }
  expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => value.startsWith("CREATE") || value.startsWith("INSERT"))).toBe(false);
});

function registryBudgetRows(count: number): readonly Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => { const key = `store_${String(index).padStart(4, "0")}`, definition = defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey: key, formatVersion: 1, ownedScope: { schema: "public", tablePrefix: `scope_${String(index).padStart(4, "0")}_` } }); return { store_key: key, contract: definition.contract, format_version: "1", owned_schema: definition.ownedScope.schema, table_prefix: definition.ownedScope.tablePrefix, owned_scope_hash: canonicalOwnedStoreScopeHashV1(definition), model_hash: projectorPrepared.modelHash, created_at_epoch_microseconds: String(index) }; }).reverse();
}
function registryBudgetEdges(count: number): readonly Record<string, unknown>[] { return Array.from({ length: count }, (_, index) => ({ dependent_class_oid: "1", dependent_oid: "50", dependent_sub_id: String(index), referenced_class_oid: "5", referenced_oid: "12000", referenced_sub_id: "0", dependency_type: "n" })); }
function recursivelyFrozen(value: unknown, seen = new Set<object>()): boolean { if (value === null || typeof value !== "object") return true; if (seen.has(value)) return true; seen.add(value); return Object.isFrozen(value) && Reflect.ownKeys(value).every(key => recursivelyFrozen((value as Record<PropertyKey, unknown>)[key], seen)); }
async function registryBudgetSnapshot(rows: readonly Record<string, unknown>[], dependencies?: readonly Record<string, unknown>[]) {
  const recorder = registryProjectorRecorder((sql) => {
    if (sql.includes('FROM "public"."__osnv_orm_owned_stores_v1"')) return rows;
    if (sql.includes("FROM pg_catalog.pg_depend") && dependencies) return dependencies;
    return undefined;
  });
  const result = await Promise.resolve().then(() => recorder.capability.withOwnedStoreAdmission(undefined, registry => registry.inspectRegistry())).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  return { recorder, result };
}
for (const [count, code] of [[4096, undefined], [4097, "ORM_OWNED_STORE_DRIFT"], [4098, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"]] as const) test(`actual PostgresProvider Registry data boundary ${count}`, async () => {
  const rows = registryBudgetRows(count), { recorder, result } = await registryBudgetSnapshot(rows);
  const query = recorder.queries.find(value => value.sql.includes('FROM "public"."__osnv_orm_owned_stores_v1"')); expect(query?.sql.endsWith("LIMIT 4097")).toBe(true); expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 });
  if (code) { if (result.ok) throw new Error("oversize Registry data succeeded"); ownedError(result.error, code); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(1); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(0); } else { if (!result.ok) throw result.error; const parsed = parseOwnedStoreRegistrySnapshotV1(result.value, [], { maxIdentifierLength: 63n }); if (parsed.state.kind !== "present" || result.value.state.kind !== "present") throw new Error("missing Registry"); validateFixedRegistryShapeV1(parsed.state.shape); const expected = rows.map(row => row.store_key as string).sort(); expect(result.value.state.rows.map(row => row.storeKey)).toEqual(expected); expect(result.value.state.rows[0]).not.toBe(rows[0]); expect(recursivelyFrozen(result.value.state.rows)).toBe(true); expect(parsed.state.rows).toHaveLength(4096); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); }
  expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => value.startsWith("CREATE") || value.startsWith("INSERT"))).toBe(false);
});
for (const [count, code] of [[65518, undefined], [65519, "ORM_OWNED_STORE_DRIFT"], [65520, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"]] as const) test(`actual PostgresProvider Registry aggregate dependency boundary ${count}`, async () => {
  const { recorder, result } = await registryBudgetSnapshot(registryBudgetRows(4096), registryBudgetEdges(count));
  const query = recorder.queries.find(value => value.sql.includes("FROM pg_catalog.pg_depend")); expect(query?.sql.endsWith("LIMIT 65519")).toBe(true); expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 });
  if (code) { if (result.ok) throw new Error("oversize dependency ledger succeeded"); ownedError(result.error, code); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(1); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(0); } else { if (!result.ok) throw result.error; if (result.value.state.kind !== "present") throw new Error("missing Registry"); const shape = result.value.state.shape, total = 3 + shape.catalogClasses.length + shape.columns.length + shape.indexes.length + shape.indexRelations.length + shape.constraints.length + shape.triggers.length + shape.rules.length + shape.policies.length + shape.inheritance.length + shape.sequences.length + shape.dependencies.length; expect(total).toBe(65536); expect(result.value.state.rows).toHaveLength(4096); expect(recursivelyFrozen(result.value.state)).toBe(true); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); }
  expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => value.startsWith("CREATE") || value.startsWith("INSERT"))).toBe(false);
});

test("actual PostgresProvider projects and verifies the complete recorded Catalogue fixture", async () => {
  const recorder = registryProjectorRecorder(catalogueProjectorSqlFacts);
  const raw = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope]));
  const parsed = parseOwnedStoreCatalogSnapshotV1(raw, { maxIdentifierLength: 63n });
  verifyOwnedStoreCatalogAllV1(parsed, { stores: [{ definition: projectorDefinition, expectedSchema: projectorExpected }], requestedScopes: [projectorDefinition.ownedScope] });
  expect(parsed).not.toBe(raw);
  expect(parsed.relations).toHaveLength(3); expect(parsed.rowTypes).toHaveLength(1); expect(parsed.arrayTypes).toHaveLength(1); expect(parsed.indexes).toHaveLength(2); expect(parsed.constraints).toHaveLength(2); expect(parsed.dependencies).toHaveLength(9); expect(parsed.catalogClasses).toHaveLength(5);
  expect(Object.isFrozen(raw.columns[0]?.default)).toBe(true); expect(Object.isFrozen(raw.constraints[0]?.checkExpression)).toBe(true);
  expect(recorder.queries.some(query => query.params.includes("{12,13}"))).toBe(true);
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events).not.toContain("ROLLBACK");
  expect(recorder.events.some(sql => sql.includes("CREATE") || sql.includes("INSERT"))).toBe(false);
});

test("actual PostgresProvider preserves a nested CHECK AST in raw Catalogue before parsing", async () => {
  const recorder = registryProjectorRecorder((sql, params) => {
    if (sql.includes("AS constraint_oid") && sql.includes("conkey_count")) {
      const rows = catalogueProjectorSqlFacts(sql, params) as readonly Record<string, unknown>[];
      return rows.map(row => row.constraint_oid === "17" ? { ...row, check_definition: "CHECK ((id >= 1) AND (id <= 9))" } : row);
    }
    return catalogueProjectorSqlFacts(sql, params);
  });
  const raw = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope]));
  const check = raw.constraints.find(value => value.oid === "17")?.checkExpression;
  expect(check).toEqual({ kind: "and", left: { kind: "compare", op: ">=", left: "id", right: 1 }, right: { kind: "compare", op: "<=", left: "id", right: 9 } });
  expect(recursivelyFrozen(check)).toBe(true);
  expect(parseOwnedStoreCatalogSnapshotV1(raw, { maxIdentifierLength: 63n })).toEqual(raw);
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => /CREATE|INSERT/u.test(value))).toBe(false);
});

for (const [name, root, toast] of [["direct unproven TOAST", "t", false], ["materialized root declared TOAST", "m", true]] as const) test(`actual PostgresProvider preserves ${name} without attribute capture`, async () => {
  const recorder = registryProjectorRecorder((sql, params) => {
    const requested = () => fixtureOidArray(params[0]);
    if (sql.includes("pg_catalog.left(c.relname")) return [{ relation_oid: "10" }];
    if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return requested().map(oid => oid === "55" ? { oid, namespace_oid:"99", schema_name:"pg_toast", relation_name:"pg_toast_10", relkind:"t", relpersistence:"p", relispartition:false, relrowsecurity:false, relforcerowsecurity:false, relreplident:"n", tablespace_oid:"0", access_method:"heap", row_type_oid:"0", toast_relation_oid:"0" } : { oid, namespace_oid:"12000", schema_name:"public", relation_name:"osnv_items", relkind:root, relpersistence:"p", relispartition:false, relrowsecurity:false, relforcerowsecurity:false, relreplident:"d", tablespace_oid:"0", access_method:"heap", row_type_oid:toast?"11":"0", toast_relation_oid:toast?"55":"0" });
    if (sql.includes("option_count")) return requested().map(relation_oid => ({ relation_oid, option_count:"0" }));
    if (sql.includes("AS row_type_oid")) return [{ row_type_oid:"11", relation_oid:"10", schema_name:"public", type_name:"osnv_items", typtype:"c", array_type_oid:"15", array_relation_oid:"0", array_schema_name:"public", array_type_name:"_osnv_items", array_typtype:"b", array_typcategory:"A", array_element_oid:"11", array_array_oid:"0" }];
    if (sql.includes("FROM pg_catalog.pg_attribute")) return [];
    if (/pg_catalog\.pg_(index|constraint|trigger|rewrite|policy|inherits|depend)/u.test(sql)) return [];
    return catalogueProjectorSqlFacts(sql, params);
  });
  const raw = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope]));
  expect(raw.relations.map(value => value.kind)).toEqual(toast ? ["toastTable", "materializedView"] : ["toastTable"]); expect(raw.columns).toEqual([]); expect(recorder.queries.some(query => query.sql.includes("FROM pg_catalog.pg_attribute"))).toBe(false); expect(recursivelyFrozen(raw)).toBe(true); const parsed=parseOwnedStoreCatalogSnapshotV1(raw,{maxIdentifierLength:63n});expect(parsed).toEqual(raw);expect(()=>verifyOwnedStoreCatalogAllV1(parsed,{stores:[{definition:projectorDefinition,expectedSchema:projectorExpected}],requestedScopes:[projectorDefinition.ownedScope]})).toThrow("ORM_OWNED_STORE_DRIFT");expect(recorder.counts()).toEqual({roots:0,reserves:1});expect(recorder.events.filter(x=>x==="COMMIT")).toHaveLength(1);expect(recorder.events.filter(x=>x==="ROLLBACK")).toHaveLength(0);expect(recorder.events.filter(x=>x==="release")).toHaveLength(1);expect(recorder.events.some(x=>/CREATE|INSERT/u.test(x))).toBe(false);
});

test("actual PostgresProvider preserves nonempty raw rule policy and inheritance families before parsing", async () => {
  const recorder=registryProjectorRecorder((sql,params)=>{if(sql.includes("FROM pg_catalog.pg_rewrite"))return[{rule_oid:"510",relation_oid:"10",rule_name:"r",event_code:"1",enabled_code:"O",is_instead:false}];if(sql.includes("FROM pg_catalog.pg_policy")&&sql.includes("role_count"))return[{policy_oid:"511",relation_oid:"10",policy_name:"p",permissive:true,command_code:"r",using_expression:null,check_expression:null,role_count:"1"}];if(sql.includes("WITH requested(policy_oid"))return[{request_ordinality:"1",policy_oid:"511",element_ordinality:"1",role_oid:"0"}];if(sql.includes("FROM pg_catalog.pg_inherits"))return[{child_relation_oid:"10",parent_relation_oid:"110",sequence:"1"}];return catalogueProjectorSqlFacts(sql,params);});const raw=await recorder.capability.withOwnedStoreAdmission(undefined,async registry=>(await registry.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope]));expect(raw.rules).toEqual([{oid:"510",relationOid:"10",name:"r",event:"1",enabled:"O",instead:false}]);expect(raw.policies).toEqual([{oid:"511",relationOid:"10",name:"p",permissive:true,command:"r",roles:["0"],usingExpression:null,checkExpression:null}]);expect(raw.inheritance).toEqual([{childRelationOid:"10",parentRelationOid:"110",sequence:"1"}]);expect(raw.catalogClasses).toEqual(expect.arrayContaining([{oid:"7",schema:"pg_catalog",name:"pg_rewrite",kind:"pg_rewrite"},{oid:"9",schema:"pg_catalog",name:"pg_policy",kind:"other"}]));expect(recursivelyFrozen(raw)).toBe(true);const parsed=parseOwnedStoreCatalogSnapshotV1(raw,{maxIdentifierLength:63n});expect(parsed).toEqual(raw);expect(()=>verifyOwnedStoreCatalogAllV1(parsed,{stores:[{definition:projectorDefinition,expectedSchema:projectorExpected}],requestedScopes:[projectorDefinition.ownedScope]})).toThrow("ORM_OWNED_STORE_DRIFT");expect(recorder.counts()).toEqual({roots:0,reserves:1});expect(recorder.events.filter(x=>x==="COMMIT")).toHaveLength(1);expect(recorder.events.filter(x=>x==="ROLLBACK")).toHaveLength(0);expect(recorder.events.filter(x=>x==="release")).toHaveLength(1);expect(recorder.events.some(x=>/CREATE|INSERT/u.test(x))).toBe(false);});

for (const hostile of ["constructor", "toString", "__proto__"] as const) test(`actual PostgresProvider preserves hostile dependency class ${hostile} before B1`, async () => {
  const recorder = registryProjectorRecorder((sql, params) => {
    if (sql.includes("FROM pg_catalog.pg_depend")) {
      const rows = catalogueProjectorSqlFacts(sql, params) as readonly Record<string, unknown>[];
      return [...rows, { dependent_class_oid: "1001", dependent_oid: "600", dependent_sub_id: "0", referenced_class_oid: "1", referenced_oid: "10", referenced_sub_id: "0", dependency_type: hostile }];
    }
    if (sql.includes("AS class_oid") && params.length > 0) return [{ class_oid: "1001", class_schema: "pg_catalog", class_name: hostile }];
    return catalogueProjectorSqlFacts(sql, params);
  });
  const raw = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope]));
  expect(raw.catalogClasses).toContainEqual({ oid: "1001", schema: "pg_catalog", name: hostile, kind: "other" });
  expect(raw.dependencies).toContainEqual({ dependentClassOid: "1001", dependentOid: "600", dependentSubId: "0", referencedClassOid: "1", referencedOid: "10", referencedSubId: "0", kind: "other" });
  expect(recursivelyFrozen(raw)).toBe(true);
  const parsed = parseOwnedStoreCatalogSnapshotV1(raw, { maxIdentifierLength: 63n }); expect(parsed).toEqual(raw);
  expect(() => verifyOwnedStoreCatalogAllV1(parsed, { stores: [{ definition: projectorDefinition, expectedSchema: projectorExpected }], requestedScopes: [projectorDefinition.ownedScope] })).toThrow("ORM_OWNED_STORE_DRIFT");
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => /CREATE|INSERT/u.test(value))).toBe(false);
});

function ledgerWitness(extra: readonly Record<string, unknown>[], observed: readonly Record<string, unknown>[] | null = null) { return registryProjectorRecorder((sql, params) => { if (sql.includes("FROM pg_catalog.pg_depend")) return [...catalogueProjectorSqlFacts(sql, params) as readonly Record<string, unknown>[], ...extra]; if (sql.includes("AS class_oid") && params.length && observed !== null) return observed; return catalogueProjectorSqlFacts(sql, params); }); }
const selfEdge={dependent_class_oid:"1",dependent_oid:"10",dependent_sub_id:"0",referenced_class_oid:"1",referenced_oid:"10",referenced_sub_id:"0",dependency_type:"n"};
test("actual PostgresProvider preserves one both-end self dependency before parsing",async()=>{const r=ledgerWitness([selfEdge]);const raw=await r.capability.withOwnedStoreAdmission(undefined,async x=>(await x.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope]));const self={dependentClassOid:"1",dependentOid:"10",dependentSubId:"0",referencedClassOid:"1",referencedOid:"10",referencedSubId:"0",kind:"normal" as const};expect(raw.dependencies.filter(x=>x.dependentClassOid==="1"&&x.dependentOid==="10"&&x.referencedClassOid==="1"&&x.referencedOid==="10")).toEqual([self]);expect(raw.dependencies).toHaveLength(10);const queries=r.queries.filter(x=>x.sql.includes("FROM pg_catalog.pg_depend"));expect(queries).toHaveLength(1);expect(queries[0]!.sql).toContain("EXISTS (SELECT 1 FROM seeds AS s WHERE s.classid=d.classid AND s.objid=d.objid) OR EXISTS (SELECT 1 FROM seeds AS s WHERE s.classid=d.refclassid AND s.objid=d.refobjid)");expect(queries[0]!.sql).not.toContain("UNION ALL");expect(queries[0]!.sql).not.toContain("DISTINCT");expect(queries[0]!.sql).not.toContain("GROUP BY");expect(parseOwnedStoreCatalogSnapshotV1(raw,{maxIdentifierLength:63n})).toEqual(raw);expect(()=>verifyOwnedStoreCatalogAllV1(raw,{stores:[{definition:projectorDefinition,expectedSchema:projectorExpected}],requestedScopes:[projectorDefinition.ownedScope]})).toThrow("ORM_OWNED_STORE_DRIFT");expect(recursivelyFrozen(raw)).toBe(true);expect(r.counts()).toEqual({roots:0,reserves:1});expect(r.events.filter(x=>x==="COMMIT")).toHaveLength(1);expect(r.events.filter(x=>x==="ROLLBACK")).toHaveLength(0);expect(r.events.filter(x=>x==="release")).toHaveLength(1);expect(r.events.some(x=>/CREATE|INSERT/u.test(x))).toBe(false);});
test("actual PostgresProvider raw reader preserves duplicate dependency before the parser rejects",async()=>{const r=ledgerWitness([selfEdge,selfEdge]);const raw=await r.capability.withOwnedStoreAdmission(undefined,async x=>(await x.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope]));const self={dependentClassOid:"1",dependentOid:"10",dependentSubId:"0",referencedClassOid:"1",referencedOid:"10",referencedSubId:"0",kind:"normal" as const};expect(raw.dependencies.filter(x=>x.dependentClassOid==="1"&&x.dependentOid==="10"&&x.referencedClassOid==="1"&&x.referencedOid==="10")).toEqual([self,self]);expect(raw.dependencies).toHaveLength(11);expect(recursivelyFrozen(raw)).toBe(true);expect(()=>parseOwnedStoreCatalogSnapshotV1(raw,{maxIdentifierLength:63n})).toThrow("ORM_OWNED_STORE_DRIFT");expect(r.counts()).toEqual({roots:0,reserves:1});expect(r.events.filter(x=>x==="COMMIT")).toHaveLength(1);expect(r.events.filter(x=>x==="ROLLBACK")).toHaveLength(0);expect(r.events.filter(x=>x==="release")).toHaveLength(1);expect(r.events.some(x=>/CREATE|INSERT/u.test(x))).toBe(false);});
for(const [name,rows,code] of [["external",[{class_oid:"1001",class_schema:"external_namespace",class_name:"external_object"}],undefined],["missing",[],"ORM_OWNED_STORE_DRIFT"],["ambiguous",[{class_oid:"1001",class_schema:"external_namespace",class_name:"external_object"},{class_oid:"1001",class_schema:"external_namespace",class_name:"external_object"}],"ORM_OWNED_STORE_DRIFT"]] as const)test(`actual PostgresProvider ledger observed class ${name}`,async()=>{const edge={dependent_class_oid:"1001",dependent_oid:"600",dependent_sub_id:"0",referenced_class_oid:"1",referenced_oid:"10",referenced_sub_id:"0",dependency_type:"n"};const r=ledgerWitness([edge],rows);const outcome=await admissionResult(()=>r.capability.withOwnedStoreAdmission(undefined,async x=>(await x.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope])));const lookup=r.queries.filter(x=>x.sql.includes("AS class_oid")&&x.params.length);expect(lookup).toHaveLength(1);expect(lookup[0]?.params).toEqual(["{1001}"]);expect(lookup[0]?.sql).toContain("LIMIT 2");expect(lookup[0]?.sql).toContain("FROM pg_catalog.pg_class AS c");expect(lookup[0]?.sql).toContain("JOIN pg_catalog.pg_namespace AS n");if(code){if(outcome.ok)throw new Error("expected drift");ownedError(outcome.error,code);expect(r.events.filter(x=>x==="ROLLBACK")).toHaveLength(1);expect(r.events.filter(x=>x==="COMMIT")).toHaveLength(0);}else{if(!outcome.ok)throw outcome.error;const raw=outcome.value as OwnedStoreCatalogSnapshotV1;expect(raw.catalogClasses.map(x=>x.oid)).toEqual(["1","2","3","4","5","1001"]);expect(raw.catalogClasses.at(-1)).toEqual({oid:"1001",schema:"other",name:"external_object",kind:"other"});expect(raw.dependencies.at(-1)).toEqual({dependentClassOid:"1001",dependentOid:"600",dependentSubId:"0",referencedClassOid:"1",referencedOid:"10",referencedSubId:"0",kind:"normal"});expect(parseOwnedStoreCatalogSnapshotV1(raw,{maxIdentifierLength:63n})).toEqual(raw);expect(()=>verifyOwnedStoreCatalogAllV1(raw,{stores:[{definition:projectorDefinition,expectedSchema:projectorExpected}],requestedScopes:[projectorDefinition.ownedScope]})).toThrow("ORM_OWNED_STORE_DRIFT");expect(recursivelyFrozen(raw)).toBe(true);expect(r.events.filter(x=>x==="COMMIT")).toHaveLength(1);expect(r.events.filter(x=>x==="ROLLBACK")).toHaveLength(0);}expect(r.counts()).toEqual({roots:0,reserves:1});expect(r.events.filter(x=>x==="release")).toHaveLength(1);expect(r.events.some(x=>/CREATE|INSERT/u.test(x))).toBe(false);});

test("actual PostgresProvider clones 513 UTF-8 sorted Catalogue scopes into two bound batches", async () => {
  const prefix = "owned%_'\\\\";
  const scopes = Array.from({ length: 511 }, (_, index) => ({ schema: `s${String(index).padStart(3, "0")}`, tablePrefix: prefix }));
  scopes.push({ schema: "\ue000", tablePrefix: prefix }, { schema: "\u{10000}", tablePrefix: prefix });
  const baseline = scopes.map(scope => ({ ...scope }));
  let scopeQueries = 0;
  const recorder = registryProjectorRecorder((sql, params) => {
    if (sql.includes("SELECT n.nspname AS schema_name")) {
      scopeQueries++;
      if (scopeQueries === 1) scopes[0]!.schema = "mutated-after-dispatch";
      return params.includes("s000") ? [{ schema_name: "s000" }, { schema_name: "\ue000" }] : [{ schema_name: "\u{10000}" }];
    }
    return catalogueProjectorSqlFacts(sql, params);
  });
  const snapshot = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog(scopes));
  expect(snapshot.requestedScopes).toEqual(baseline); expect(snapshot.requestedScopes[0]).not.toBe(scopes[0]);
  expect(Object.isFrozen(snapshot.requestedScopes)).toBe(true); expect(Object.isFrozen(snapshot.requestedScopes[0]!)).toBe(true);
  expect(snapshot.existingSchemas).toEqual(["s000", "\ue000", "\u{10000}"]);
  const scopeSql = recorder.queries.filter(query => query.sql.includes("SELECT n.nspname AS schema_name"));
  expect(scopeSql).toHaveLength(2); expect(scopeSql.map(query => query.params.length)).toEqual([1024, 2]);
  for (const query of scopeSql) { expect(query.sql).toContain("WITH requested(schema_name, table_prefix) AS (VALUES"); expect(query.sql).toContain("pg_catalog.pg_namespace"); expect(query.sql).toContain("pg_catalog.convert_to(n.nspname, 'UTF8')"); expect(query.sql).toContain("LIMIT 513"); expect(query.sql).not.toContain("LIKE"); expect(query.sql).not.toContain(prefix); }
  expect(scopeSql[0]!.params.slice(0, 4)).toEqual(["s000", prefix, "s001", prefix]); expect(scopeSql[1]!.params).toEqual(["\u{10000}", prefix]);
  const rootSql = recorder.queries.filter(query => query.sql.includes("pg_catalog.left(c.relname"));
  expect(rootSql).toHaveLength(2); expect(rootSql.map(query => query.params.length)).toEqual([1024, 2]);
  for (const query of rootSql) { expect(query.sql).toContain("pg_catalog.pg_class"); expect(query.sql).toContain("pg_catalog.left"); expect(query.sql).not.toContain("LIKE"); expect(query.sql).not.toContain(prefix); }
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events).toContain("COMMIT"); expect(recorder.events).toContain("release"); expect(recorder.events).not.toContain("ROLLBACK");
});

async function indexOnlyBoundary(count: number, widths: (oid: string) => number) {
  const events: string[] = [], queries: { sql: string; params: readonly unknown[] }[] = [];
  let roots = 0, reserves = 0;
  const ids = [...Array.from({ length: count - 1 }, (_, i) => String(i + 1)), "4294967295"];
  const provider = new PostgresProvider({ options: {} });
  Object.defineProperty(provider, "sql", { configurable: true, value: {
    close: async () => {},
    unsafe: async () => { roots++; throw new Error("root"); },
    reserve: async () => {
      reserves++;
      return {
        unsafe: async (sql: string, params: readonly unknown[] = []) => {
          events.push(sql); queries.push({ sql, params });
          const requested = () => fixtureOidArray(params[0]);
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL") || sql.includes("pg_advisory")) return [];
          if (sql.includes("max_identifier_length")) return [{ max_identifier_length: "63" }];
          if (sql.startsWith("SELECT EXISTS")) return [{ public_schema_exists: true }];
          if (sql.includes("__osnv_orm_owned_stores_v1")) return [];
          if (sql.includes("SELECT n.nspname AS schema_name")) return [{ schema_name: "public" }];
          if (sql.includes("pg_catalog.left(c.relname")) return ids.map(relation_oid => ({ relation_oid }));
          if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return requested().map(oid => ({ oid, namespace_oid: "12000", schema_name: "public", relation_name: `owned_index_${oid}`, relkind: "i", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "n", tablespace_oid: "0", access_method: "btree", row_type_oid: "0", toast_relation_oid: "0" }));
          if (sql.includes("option_count")) return requested().map(relation_oid => ({ relation_oid, option_count: "0" }));
          if (sql.includes("FROM pg_catalog.pg_index AS i WHERE")) return requested().map(index_relation_oid => ({ index_relation_oid }));
          if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class")) return requested().map(index_relation_oid => ({ index_relation_oid, table_relation_oid: "4000000000", index_name: `owned_index_${index_relation_oid}`, method_oid: "403", method_name: "btree", is_unique: false, is_primary: false, is_exclusion: false, is_immediate: true, is_valid: true, is_ready: true, is_live: true, is_replica_identity: false, nulls_not_distinct: false, key_attribute_count: String(widths(index_relation_oid)), total_attribute_count: String(widths(index_relation_oid)), index_expression: null, index_predicate: null, backing_constraint_oid: null }));
          if (sql.includes("pg_catalog.unnest(i.indkey)") || sql.includes("pg_catalog.unnest(i.indcollation)") || sql.includes("pg_catalog.unnest(i.indclass)") || sql.includes("pg_catalog.unnest(i.indoption)")) {
            const key = sql.includes("indkey"), kind = key ? "key" : sql.includes("indcollation") ? "collation" : sql.includes("indclass") ? "opclass" : "option";
            return requested().flatMap(index_relation_oid => Array.from({ length: widths(index_relation_oid) }, (_, index) => key ? ({ index_relation_oid, element_ordinality: String(index + 1), value: String(index + 1), resolved_attnum: String(index + 1), column_name: `c${index + 1}` }) : ({ index_relation_oid, element_ordinality: String(index + 1), value: kind === "collation" ? "0" : kind === "opclass" ? "3124" : "0" })));
          }
          if (sql.includes("FROM pg_catalog.pg_opclass AS actual")) return [{ actual_opclass_oid: "3124", actual_method_oid: "403", actual_input_type_oid: "20", actual_opfamily_oid: "1976", actual_family_method_oid: "403", default_opclass_oid: "3124", default_method_oid: "403", default_input_type_oid: "20", default_is_default: true }];
          if (sql.includes("AS class_oid")) return ["pg_class", "pg_type", "pg_constraint", "pg_attrdef", "pg_namespace", "pg_proc", "pg_rewrite", "pg_trigger", "pg_policy"].map((class_name, index) => ({ class_oid: String(9000 + index), class_schema: "pg_catalog", class_name }));
          return [];
        },
        release: async () => { events.push("release"); },
      };
    },
  } });
  const capability = postgresOwnedStoreCapability(provider);
  if (!capability) throw new Error("missing");
  const snapshot = await capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([{ schema: "public", tablePrefix: "owned_" }]));
  return { snapshot, events, queries, roots, reserves };
}

for (const [count, width] of [[1024, (_: string) => 1], [1025, (oid: string) => oid === "1023" ? 128 : oid === "1024" || oid === "4294967295" ? 1 : 64]] as const) test(`actual PostgresProvider projects index-only OID/vector boundary ${count}`, async () => { const result = await indexOnlyBoundary(count, width); const parsed = parseOwnedStoreCatalogSnapshotV1(result.snapshot, { maxIdentifierLength: 63n }); expect(parsed).toEqual(result.snapshot); expect(result.snapshot.relations).toHaveLength(count); expect(result.snapshot.indexes).toHaveLength(count); expect(result.snapshot.catalogClasses).toHaveLength(5); expect(result.snapshot.rowTypes).toEqual([]); expect(result.snapshot.arrayTypes).toEqual([]); expect(result.snapshot.columns).toEqual([]); expect(result.snapshot.constraints).toEqual([]); expect(result.snapshot.triggers).toEqual([]); expect(result.snapshot.rules).toEqual([]); expect(result.snapshot.policies).toEqual([]); expect(result.snapshot.inheritance).toEqual([]); expect(result.snapshot.sequences).toEqual([]); expect(result.snapshot.dependencies).toEqual([]); expect(recursivelyFrozen(result.snapshot)).toBe(true); const schema = result.queries.filter(query => query.sql.includes("SELECT n.nspname AS schema_name")); expect(schema).toHaveLength(1); expect(schema[0]!.params).toEqual(["public", "owned_"]); const relations = result.queries.filter(query => query.sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")); const expectedOids = [...Array.from({ length: count - 1 }, (_, index) => String(index + 1)), "4294967295"]; expect(relations.map(query => fixtureOidArray(query.params[0]))).toEqual(count === 1024 ? [expectedOids] : [expectedOids.slice(0, 1024), expectedOids.slice(1024)]); expect(result.snapshot.requestedScopes).toEqual([{ schema: "public", tablePrefix: "owned_" }]); expect(result.snapshot.existingSchemas).toEqual(["public"]); expect(result.snapshot.relations.map(value => value.oid)).toEqual([...expectedOids].sort((left, right) => Buffer.compare(Buffer.from(`owned_index_${left}`, "utf8"), Buffer.from(`owned_index_${right}`, "utf8")))); expect(result.snapshot.indexes.map(value => value.indexRelationOid)).toEqual(expectedOids); expect(result.snapshot.catalogClasses.map(value => value.oid)).toEqual(["9000", "9001", "9002", "9003", "9004"]); const allFamilies = [result.snapshot.relations, result.snapshot.rowTypes, result.snapshot.arrayTypes, result.snapshot.columns, result.snapshot.indexes, result.snapshot.constraints, result.snapshot.triggers, result.snapshot.rules, result.snapshot.policies, result.snapshot.inheritance, result.snapshot.sequences, result.snapshot.dependencies, result.snapshot.catalogClasses]; expect(allFamilies.reduce((sum, family) => sum + family.length, 0)).toBe(count === 1024 ? 2053 : 2055); const expectedWidths = expectedOids.map(oid => count === 1024 ? 1 : oid === "1023" ? 128 : oid === "1024" || oid === "4294967295" ? 1 : 64); expect(result.snapshot.indexes.map((index, position) => ({ oid: index.indexRelationOid, attributes: index.attributeNumbers, names: index.columnNames, collations: index.collationOids, opclasses: index.opclassOids, defaults: index.defaultOpclassOids, options: index.options }))).toEqual(expectedOids.map((oid, position) => ({ oid, attributes: Array.from({ length: expectedWidths[position]! }, (_, ordinal) => String(ordinal + 1)), names: Array.from({ length: expectedWidths[position]! }, (_, ordinal) => `c${ordinal + 1}`), collations: Array.from({ length: expectedWidths[position]! }, () => "0"), opclasses: Array.from({ length: expectedWidths[position]! }, () => "3124"), defaults: Array.from({ length: expectedWidths[position]! }, () => "3124"), options: Array.from({ length: expectedWidths[position]! }, () => "0") }))); const ledger = result.queries.filter(query => query.sql.includes("FROM pg_catalog.pg_depend")); expect(ledger).toHaveLength(1); const [ledgerQuery] = ledger; expect(ledgerQuery!.sql.match(/ROWS FROM/gu)).toHaveLength(count === 1024 ? 1 : 2); expect(ledgerQuery!.sql.match(/pg_catalog\.unnest\(\$\d+::pg_catalog\.oid\[\]\)/gu)).toHaveLength(count === 1024 ? 2 : 4); expect(ledgerQuery!.sql).not.toContain("DISTINCT"); expect(ledgerQuery!.sql).not.toContain("GROUP BY"); expect(ledgerQuery!.sql).not.toMatch(/pg_catalog\.unnest\([^)]*,/u); expect(ledgerQuery!.sql).not.toMatch(/\[[0-9]+\]/u); const rootOids = expectedOids; expect(ledgerQuery!.params.map(fixtureOidArray)).toEqual(count === 1024 ? [Array.from({ length: 1024 }, () => "9000"), rootOids] : [Array.from({ length: 1024 }, () => "9000"), rootOids.slice(0, 1024), ["9000"], ["4294967295"]]); for (const [source, expectedBatches] of [["indkey", count === 1024 ? [expectedOids] : [expectedOids.slice(0, 1023), expectedOids.slice(1023)]], ["indcollation", count === 1024 ? [expectedOids] : [expectedOids.slice(0, 1023), expectedOids.slice(1023)]], ["indclass", count === 1024 ? [expectedOids] : [expectedOids.slice(0, 1023), expectedOids.slice(1023)]], ["indoption", count === 1024 ? [expectedOids] : [expectedOids.slice(0, 1023), expectedOids.slice(1023)]]] as const) { const queries = result.queries.filter(query => query.sql.includes(`pg_catalog.unnest(i.${source})`)); expect(queries.map(query => fixtureOidArray(query.params[0]))).toEqual(expectedBatches); expect(queries.map(query => Number(query.sql.match(/LIMIT (\d+)$/u)?.[1]))).toEqual(count === 1024 ? [1025] : [65537, 3]); } const vectors = result.queries.filter(query => query.sql.includes("pg_catalog.unnest(i.ind")); expect(vectors).toHaveLength(count === 1024 ? 4 : 8); expect(vectors.map(query => Number(query.sql.match(/LIMIT (\d+)$/u)?.[1])).sort((a,b)=>a-b)).toEqual(count === 1024 ? [1025,1025,1025,1025] : [3,3,3,3,65537,65537,65537,65537]); expect(expectedWidths.reduce((sum, value) => sum + value, 0)).toBe(count === 1024 ? 1024 : 65538); expect(result.roots).toBe(0); expect(result.reserves).toBe(1); expect(result.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(result.events.filter(value => value === "ROLLBACK")).toHaveLength(0); expect(result.events.filter(value => value === "release")).toHaveLength(1); expect(result.events.some(value => /CREATE|INSERT/u.test(value))).toBe(false); });

for (const [name, scopes] of [
  ["unsorted", [{ schema: "\u{10000}", tablePrefix: "owned_" }, { schema: "\ue000", tablePrefix: "owned_" }]],
  ["descriptor-hostile", (() => { const value: unknown[] = []; Object.defineProperty(value, "0", { enumerable: true, get: () => ({ schema: "public", tablePrefix: "owned_" }) }); value.length = 1; return value; })()],
] as const) test(`actual PostgresProvider rejects ${name} Catalogue scopes before catalogue SQL`, async () => {
  const recorder = registryProjectorRecorder(catalogueProjectorSqlFacts);
  const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog(scopes as unknown as readonly { readonly schema: string; readonly tablePrefix: string }[])));
  if (result.ok) throw new Error("invalid Catalogue scopes unexpectedly succeeded");
  ownedError(result.error, "ORM_OWNED_STORE_DRIFT");
  expect(recorder.queries.some(query => query.sql.includes("SELECT n.nspname AS schema_name") || query.sql.includes("pg_catalog.left(c.relname"))).toBe(false);
  expect(recorder.traces.some(trace => trace.tag === "osnv.owned-store:catalog-read")).toBe(false);
  expect(recorder.events).toContain("ROLLBACK"); expect(recorder.events).toContain("release"); expect(recorder.events).not.toContain("COMMIT");
});

test("actual PostgresProvider redacts successful Registry and Catalogue read trace params even when configured false", async () => {
  const registryRecorder = registryProjectorRecorder(registryToastProjectorSqlFacts, { redactSqlParams: false });
  const registrySnapshot = await registryRecorder.capability.withOwnedStoreAdmission(undefined, registry => registry.inspectRegistry());
  expect(registrySnapshot.state.kind).toBe("present");
  const catalogueRecorder = registryProjectorRecorder((sql, params) => foreignIdentityToastCatalogueProjectorSqlFacts(sql, params), { redactSqlParams: false });
  const catalogueSnapshot = await catalogueRecorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([foreignProjectorDefinition.ownedScope]));
  expect(catalogueSnapshot.relations).toHaveLength(9);
  for (const traces of [registryRecorder.traces, catalogueRecorder.traces]) for (const trace of traces.filter(value => value.tag === "osnv.owned-store:registry-read" || value.tag === "osnv.owned-store:catalog-read")) expect(trace.params).toEqual([]);
  expect(registryRecorder.traces.some(trace => trace.tag === "osnv.owned-store:registry-read")).toBe(true); expect(catalogueRecorder.traces.some(trace => trace.tag === "osnv.owned-store:catalog-read")).toBe(true);
  expect(catalogueRecorder.queries.some(query => query.sql.includes("pg_catalog.left(c.relname") && query.params.length === 2)).toBe(true);
  expect(catalogueRecorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(catalogueRecorder.events).toContain("COMMIT"); expect(catalogueRecorder.events).toContain("release"); expect(catalogueRecorder.events).not.toContain("ROLLBACK");
});

const foreignLedgerExpected = `1 10 0 5 12000 0 normal|1 12 0 3 16 0 internal|1 13 0 1 10 1 automatic|1 110 0 5 12000 0 normal|1 112 0 3 116 0 internal|1 113 0 1 110 1 automatic|2 11 0 1 10 0 internal|2 15 0 2 11 0 internal|2 111 0 1 110 0 internal|2 115 0 2 111 0 internal|3 16 0 1 10 1 automatic|3 17 0 1 10 1 automatic|3 17 0 1 10 1 normal|3 116 0 1 110 1 automatic|3 117 0 1 110 1 automatic|3 117 0 1 110 1 normal|3 118 0 1 10 1 automatic|3 118 0 1 110 1 normal|3 118 0 1 112 0 normal|4 14 0 1 10 1 automatic|4 114 0 1 110 1 automatic|8 121 0 3 118 0 internal|8 122 0 3 118 0 internal|8 123 0 3 118 0 internal|8 124 0 3 118 0 internal`.split("|").map(value => value.split(" "));
const ledgerOrder = (left: readonly string[], right: readonly string[]) => left.slice(0, 6).map((value, index) => Number(value) - Number(right[index]!)).find(value => value !== 0) ?? left[6]!.localeCompare(right[6]!);
const foreignIdentityLedgerExpected = [...foreignLedgerExpected.filter(value => !(value[0] === "4" && value[1] === "14")), ["1", "18", "0", "1", "10", "1", "internal"], ["1", "18", "0", "5", "12000", "0", "normal"]].sort(ledgerOrder);
const foreignIdentityToastLedgerExpected = [...foreignIdentityLedgerExpected, ["1", "30", "0", "1", "10", "0", "internal"], ["1", "31", "0", "1", "30", "1", "automatic"], ["1", "31", "0", "1", "30", "2", "automatic"]].sort(ledgerOrder);

test("actual PostgresProvider projects the complete same-store FK Catalogue through the registered capability", async () => {
  const recorder = registryProjectorRecorder((sql, params) => foreignCatalogueProjectorSqlFacts(sql, params));
  const snapshot = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([foreignProjectorDefinition.ownedScope]));
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(snapshot, { maxIdentifierLength: 63n }), { stores: [{ definition: foreignProjectorDefinition, expectedSchema: foreignProjectorExpected }], requestedScopes: [foreignProjectorDefinition.ownedScope] })).not.toThrow();
  expect(snapshot.relations.map(value => value.oid)).toEqual(["13", "113", "10", "110", "12", "112"]);
  expect(snapshot.indexes.map(value => value.indexRelationOid)).toEqual(["12", "13", "112", "113"]);
  const foreignKey = snapshot.constraints.find(value => value.oid === "118");
  expect(foreignKey).toMatchObject({ relationOid: "10", referencedRelationOid: "110", backingIndexOid: "112", onDelete: "cascade", onUpdate: "noAction", match: "simple", primaryForeignEqualityOperatorOids: ["99"], primaryPrimaryEqualityOperatorOids: ["99"], foreignForeignEqualityOperatorOids: ["99"], defaultEqualityOperatorOids: ["99"] });
  expect(snapshot.triggers.map(value => [value.oid, value.relationOid, value.functionOid, value.functionName, value.typeBits])).toEqual([["121", "10", "1644", "RI_FKey_check_ins", "5"], ["122", "10", "1645", "RI_FKey_check_upd", "17"], ["123", "110", "1646", "RI_FKey_cascade_del", "9"], ["124", "110", "1655", "RI_FKey_noaction_upd", "17"]]);
  expect(snapshot.catalogClasses.map(value => value.oid)).toEqual(["1", "2", "3", "4", "5", "6", "8"]);
  expect(snapshot.dependencies).toHaveLength(25);
  expect({ relations: snapshot.relations.length, rowTypes: snapshot.rowTypes.length, arrayTypes: snapshot.arrayTypes.length, columns: snapshot.columns.length, indexes: snapshot.indexes.length, constraints: snapshot.constraints.length, triggers: snapshot.triggers.length, catalogClasses: snapshot.catalogClasses.length, dependencies: snapshot.dependencies.length, rules: snapshot.rules.length, policies: snapshot.policies.length, inheritance: snapshot.inheritance.length, sequences: snapshot.sequences.length }).toEqual({ relations: 6, rowTypes: 2, arrayTypes: 2, columns: 2, indexes: 4, constraints: 5, triggers: 4, catalogClasses: 7, dependencies: 25, rules: 0, policies: 0, inheritance: 0, sequences: 0 });
  expect(snapshot.dependencies.map(value => [value.dependentClassOid, value.dependentOid, value.dependentSubId, value.referencedClassOid, value.referencedOid, value.referencedSubId, value.kind])).toEqual([["1", "10", "0", "5", "12000", "0", "normal"], ["1", "12", "0", "3", "16", "0", "internal"], ["1", "13", "0", "1", "10", "1", "automatic"], ["1", "110", "0", "5", "12000", "0", "normal"], ["1", "112", "0", "3", "116", "0", "internal"], ["1", "113", "0", "1", "110", "1", "automatic"], ["2", "11", "0", "1", "10", "0", "internal"], ["2", "15", "0", "2", "11", "0", "internal"], ["2", "111", "0", "1", "110", "0", "internal"], ["2", "115", "0", "2", "111", "0", "internal"], ["3", "16", "0", "1", "10", "1", "automatic"], ["3", "17", "0", "1", "10", "1", "automatic"], ["3", "17", "0", "1", "10", "1", "normal"], ["3", "116", "0", "1", "110", "1", "automatic"], ["3", "117", "0", "1", "110", "1", "automatic"], ["3", "117", "0", "1", "110", "1", "normal"], ["3", "118", "0", "1", "10", "1", "automatic"], ["3", "118", "0", "1", "110", "1", "normal"], ["3", "118", "0", "1", "112", "0", "normal"], ["4", "14", "0", "1", "10", "1", "automatic"], ["4", "114", "0", "1", "110", "1", "automatic"], ["8", "121", "0", "3", "118", "0", "internal"], ["8", "122", "0", "3", "118", "0", "internal"], ["8", "123", "0", "3", "118", "0", "internal"], ["8", "124", "0", "3", "118", "0", "internal"]]);
  for (const value of [snapshot, snapshot.relations, snapshot.rowTypes, snapshot.arrayTypes, snapshot.columns, snapshot.indexes, snapshot.constraints, snapshot.triggers, snapshot.rules, snapshot.policies, snapshot.inheritance, snapshot.sequences, snapshot.dependencies, ...snapshot.dependencies]) expect(Object.isFrozen(value)).toBe(true);
  expect(recursivelyFrozen(snapshot)).toBe(true);
  expect(snapshot.rules).toEqual([]); expect(snapshot.policies).toEqual([]); expect(snapshot.inheritance).toEqual([]); expect(snapshot.sequences).toEqual([]);
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 });
  expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); expect(recorder.events.filter(value => value === "release")).toHaveLength(1);
  expect(recorder.events.some(value => /CREATE|INSERT/u.test(value))).toBe(false);
});

test("actual PostgresProvider projects the same-store FK Catalogue identity sequence", async () => {
  const recorder = registryProjectorRecorder((sql, params) => foreignIdentityCatalogueProjectorSqlFacts(sql, params));
  const snapshot = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([foreignProjectorDefinition.ownedScope]));
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(snapshot, { maxIdentifierLength: 63n }), { stores: [{ definition: foreignProjectorDefinition, expectedSchema: foreignIdentityExpected }], requestedScopes: [foreignProjectorDefinition.ownedScope] })).not.toThrow();
  expect({ relations: snapshot.relations.length, rowTypes: snapshot.rowTypes.length, arrayTypes: snapshot.arrayTypes.length, columns: snapshot.columns.length, indexes: snapshot.indexes.length, constraints: snapshot.constraints.length, triggers: snapshot.triggers.length, sequences: snapshot.sequences.length, catalogClasses: snapshot.catalogClasses.length, dependencies: snapshot.dependencies.length }).toEqual({ relations: 7, rowTypes: 2, arrayTypes: 2, columns: 2, indexes: 4, constraints: 5, triggers: 4, sequences: 1, catalogClasses: 7, dependencies: 26 });
  expect(snapshot.sequences).toMatchObject([{ relationOid: "18", type: "bigint", start: "1", increment: "1", minimum: "1", maximum: "9223372036854775807", cache: "1", cycle: false }]);
  expect(snapshot.columns.find(value => value.relationOid === "10")).toMatchObject({ default: { kind: "none" }, generation: "identityByDefault", defaultObjectOid: null });
  expect(snapshot.dependencies.some(value => value.dependentOid === "14")).toBe(false);
  expect(snapshot.dependencies.map(value => [value.dependentClassOid, value.dependentOid, value.dependentSubId, value.referencedClassOid, value.referencedOid, value.referencedSubId, value.kind])).toEqual(foreignIdentityLedgerExpected);
  expect(snapshot.relations.map(value => value.oid)).toEqual(["18", "13", "113", "10", "110", "12", "112"]); expect(snapshot.indexes.map(value => value.indexRelationOid)).toEqual(["12", "13", "112", "113"]); expect(snapshot.columns.map(value => [value.relationOid, value.attnum, value.name])).toEqual([["10", "1", "id"], ["110", "1", "id"]]); expect(snapshot.rules).toEqual([]); expect(snapshot.policies).toEqual([]); expect(snapshot.inheritance).toEqual([]);
  expect(recursivelyFrozen(snapshot)).toBe(true); expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => /CREATE|INSERT/u.test(value))).toBe(false);
});

test("actual PostgresProvider projects the same-store FK identity and TOAST closure", async () => {
  const recorder = registryProjectorRecorder((sql, params) => foreignIdentityToastCatalogueProjectorSqlFacts(sql, params));
  const snapshot = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([foreignProjectorDefinition.ownedScope]));
  expect(() => verifyOwnedStoreCatalogAllV1(parseOwnedStoreCatalogSnapshotV1(snapshot, { maxIdentifierLength: 63n }), { stores: [{ definition: foreignProjectorDefinition, expectedSchema: foreignIdentityExpected }], requestedScopes: [foreignProjectorDefinition.ownedScope] })).not.toThrow();
  expect({ relations: snapshot.relations.length, rowTypes: snapshot.rowTypes.length, arrayTypes: snapshot.arrayTypes.length, columns: snapshot.columns.length, indexes: snapshot.indexes.length, constraints: snapshot.constraints.length, triggers: snapshot.triggers.length, sequences: snapshot.sequences.length, catalogClasses: snapshot.catalogClasses.length, dependencies: snapshot.dependencies.length }).toEqual({ relations: 9, rowTypes: 2, arrayTypes: 2, columns: 5, indexes: 5, constraints: 5, triggers: 4, sequences: 1, catalogClasses: 7, dependencies: 29 });
  expect(snapshot.relations.find(value => value.oid === "10")?.toastRelationOid).toBe("30"); expect(snapshot.indexes.find(value => value.indexRelationOid === "31")).toMatchObject({ tableRelationOid: "30", attributeNumbers: ["1", "2"], opclassOids: ["1981", "1978"] });
  expect(snapshot.dependencies.map(value => [value.dependentClassOid, value.dependentOid, value.dependentSubId, value.referencedClassOid, value.referencedOid, value.referencedSubId, value.kind])).toEqual(foreignIdentityToastLedgerExpected);
  expect(snapshot.relations.map(value => value.oid)).toEqual(["30", "31", "18", "13", "113", "10", "110", "12", "112"]); expect(snapshot.indexes.map(value => value.indexRelationOid)).toEqual(["12", "13", "31", "112", "113"]); expect(snapshot.columns.map(value => [value.relationOid, value.attnum, value.name])).toEqual([["10", "1", "id"], ["30", "1", "chunk_id"], ["30", "2", "chunk_seq"], ["30", "3", "chunk_data"], ["110", "1", "id"]]); expect(snapshot.rules).toEqual([]); expect(snapshot.policies).toEqual([]); expect(snapshot.inheritance).toEqual([]);
  expect(snapshot.dependencies.filter(value => value.dependentOid === "30" || value.dependentOid === "31")).toHaveLength(3); expect(recursivelyFrozen(snapshot)).toBe(true); expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(0); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events.some(value => /CREATE|INSERT/u.test(value))).toBe(false);
});

for (const enabledCode of ["constructor", "toString", "__proto__"] as const) test(`actual PostgresProvider maps hostile trigger enabled code ${enabledCode} to other before B2 validation`, async () => {
  const recorder = registryProjectorRecorder((sql, params) => sql.includes("FROM pg_catalog.pg_trigger") ? [{ trigger_oid: "500", relation_oid: "10", trigger_name: "owned_trigger", is_internal: true, constraint_oid: "0", parent_trigger_oid: "0", enabled_code: enabledCode, function_oid: "501", function_schema: "public", function_name: "owned_fn", type_bits: "5" }] : catalogueProjectorSqlFacts(sql, params));
  const raw = await recorder.capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([projectorDefinition.ownedScope]));
  expect(raw.triggers).toHaveLength(1); expect(raw.triggers[0]?.enabled).toBe("other"); expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events).toContain("COMMIT");
});

function admissionCatalogueProjectorSqlFacts(sql: string, params: readonly unknown[]): unknown[] | undefined {
  if (sql.includes("FROM pg_catalog.pg_attribute")) return [{ relation_oid: "10", attnum: "1", column_name: "id", dropped: false, local: true, inheritance_count: "0", physical_type: "bigint", type_oid: "20", not_null: true, default_object_oid: null, default_expression: null, identity_code: "", generated_code: "", collation_oid: "0", type_default_collation_oid: "0", storage_code: "p", type_default_storage_code: "p", compression_code: "", has_default: false }];
  if (sql.includes("FROM pg_catalog.pg_depend")) return [["1", "10", "0", "5", "12000", "0", "n"], ["2", "11", "0", "1", "10", "0", "i"], ["2", "15", "0", "2", "11", "0", "i"], ["3", "16", "0", "1", "10", "1", "a"], ["1", "12", "0", "3", "16", "0", "i"], ["1", "13", "0", "1", "10", "1", "a"], ["3", "17", "0", "1", "10", "1", "a"], ["3", "17", "0", "1", "10", "1", "n"]].map(([dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type]) => ({ dependent_class_oid, dependent_oid, dependent_sub_id, referenced_class_oid, referenced_oid, referenced_sub_id, dependency_type }));
  return catalogueProjectorSqlFacts(sql, params);
}

function projectorAdmissionRecorder(rows: readonly unknown[]) {
  let registryMode = true;
  return registryProjectorRecorder((sql, params) => {
    if (sql.includes('FROM "public"."__osnv_orm_owned_stores_v1"')) return rows;
    if (sql.includes("__osnv_orm_owned_stores_v1") && sql.includes("AS relation_oid")) registryMode = true;
    if (sql.includes("SELECT n.nspname AS schema_name")) registryMode = false;
    if (registryMode) return undefined;
    return admissionCatalogueProjectorSqlFacts(sql, params);
  });
}

test("actual PostgresProvider normal admission reopens the admission-valid Catalogue without mutations", async () => {
  const recorder = projectorAdmissionRecorder([admissionIdentityWire]);
  const receipt = await admitOwnedStoresV1(recorder.provider, { stores: [admissionPrepared] });
  expect(Object.isFrozen(receipt)).toBe(true);
  const registryRows = recorder.queries.filter(query => query.sql.includes('FROM "public"."__osnv_orm_owned_stores_v1"'));
  const catalogueRoots = recorder.queries.filter(query => query.sql.includes("pg_catalog.left(c.relname"));
  expect(registryRows).toHaveLength(2); expect(catalogueRoots).toHaveLength(1);
  expect(recorder.queries.indexOf(registryRows[0]!)).toBeLessThan(recorder.queries.indexOf(catalogueRoots[0]!)); expect(recorder.queries.indexOf(catalogueRoots[0]!)).toBeLessThan(recorder.queries.indexOf(registryRows[1]!));
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events).not.toContain("ROLLBACK");
  expect(recorder.events.some(sql => sql.includes("CREATE") || sql.includes("ALTER") || sql.includes("INSERT"))).toBe(false);
});

test("actual PostgresProvider normal admission rejects an occupied admission-valid Catalogue without its identity before mutation", async () => {
  const recorder = projectorAdmissionRecorder([]);
  let error: unknown;
  try { await admitOwnedStoresV1(recorder.provider, { stores: [admissionPrepared] }); } catch (caught) { error = caught; }
  ownedError(error, "ORM_OWNED_STORE_IDENTITY_MISSING");
  expect(recorder.queries.filter(query => query.sql.includes('FROM "public"."__osnv_orm_owned_stores_v1"'))).toHaveLength(1);
  expect(recorder.queries.filter(query => query.sql.includes("pg_catalog.left(c.relname"))).toHaveLength(1);
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "ROLLBACK")).toHaveLength(1); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events).not.toContain("COMMIT");
  expect(recorder.events.some(sql => sql.includes("CREATE") || sql.includes("ALTER") || sql.includes("INSERT"))).toBe(false);
});

function projectorCreateRecorder() {
  let registryExists = false, catalogueMode = false, tableCreated = false, indexCreated = false, identityInserted = false;
  const recorder = registryProjectorRecorder((sql, params) => {
    if (sql === 'CREATE TABLE "public"."__osnv_orm_owned_stores_v1" ("store_key" pg_catalog.text NOT NULL, "contract" pg_catalog.text NOT NULL, "format_version" pg_catalog.int8 NOT NULL, "owned_schema" pg_catalog.text NOT NULL, "table_prefix" pg_catalog.text NOT NULL, "owned_scope_hash" pg_catalog.text NOT NULL, "model_hash" pg_catalog.text NOT NULL, "created_at" pg_catalog.timestamptz NOT NULL, CONSTRAINT "__osnv_orm_owned_stores_v1_pkey" PRIMARY KEY ("store_key"))') { registryExists = true; return []; }
    if (sql.startsWith('CREATE TABLE "public"."osnv_items"')) { tableCreated = true; return []; }
    if (sql.startsWith('CREATE INDEX "ix_items_id" ON "public"."osnv_items"')) { indexCreated = true; return []; }
    if (sql.startsWith('INSERT INTO "public"."__osnv_orm_owned_stores_v1"')) { expect(params).toEqual([admissionPrepared.definition.storeKey, admissionPrepared.definition.contract, admissionPrepared.definition.formatVersion, admissionPrepared.definition.ownedScope.schema, admissionPrepared.definition.ownedScope.tablePrefix, admissionPrepared.ownedScopeHash, admissionPrepared.modelHash]); identityInserted = true; return Object.assign([], { affectedRows: null, count: 1 }); }
    if (sql.includes("__osnv_orm_owned_stores_v1") && sql.includes("AS relation_oid")) { catalogueMode = false; return registryExists ? undefined : []; }
    if (sql.includes('FROM "public"."__osnv_orm_owned_stores_v1"')) return identityInserted ? [admissionIdentityWire] : [];
    if (sql.includes("SELECT n.nspname AS schema_name")) catalogueMode = true;
    if (!catalogueMode) return undefined;
    if (sql.includes("pg_catalog.left(c.relname")) return tableCreated && indexCreated ? catalogueProjectorSqlFacts(sql, params) : [];
    return tableCreated && indexCreated ? admissionCatalogueProjectorSqlFacts(sql, params) : catalogueProjectorSqlFacts(sql, params);
  });
  return recorder;
}

test("actual PostgresProvider normal admission creates Registry, Catalogue, and identity in order", async () => {
  const recorder = projectorCreateRecorder();
  const receipt = await admitOwnedStoresV1(recorder.provider, { stores: [admissionPrepared] });
  expect(Object.isFrozen(receipt)).toBe(true);
  const registryRoots = recorder.queries.filter(query => query.sql.includes("__osnv_orm_owned_stores_v1") && query.sql.includes("AS relation_oid"));
  const catalogueRoots = recorder.queries.filter(query => query.sql.includes("pg_catalog.left(c.relname"));
  const registryDdl = recorder.queries.findIndex(query => query.sql.startsWith('CREATE TABLE "public"."__osnv_orm_owned_stores_v1"'));
  const tableDdl = recorder.queries.findIndex(query => query.sql.startsWith('CREATE TABLE "public"."osnv_items"'));
  const indexDdl = recorder.queries.findIndex(query => query.sql.startsWith('CREATE INDEX "ix_items_id" ON "public"."osnv_items"'));
  const insert = recorder.queries.findIndex(query => query.sql.startsWith('INSERT INTO "public"."__osnv_orm_owned_stores_v1"'));
  expect(registryRoots).toHaveLength(3); expect(catalogueRoots).toHaveLength(2); expect(registryDdl).toBeGreaterThan(recorder.queries.indexOf(catalogueRoots[0]!)); expect(tableDdl).toBeGreaterThan(registryDdl); expect(indexDdl).toBeGreaterThan(tableDdl); expect(insert).toBeGreaterThan(recorder.queries.indexOf(catalogueRoots[1]!)); expect(recorder.queries.indexOf(registryRoots[2]!)).toBeGreaterThan(insert);
  expect(recorder.counts()).toEqual({ roots: 0, reserves: 1 }); expect(recorder.events.filter(value => value === "COMMIT")).toHaveLength(1); expect(recorder.events.filter(value => value === "release")).toHaveLength(1); expect(recorder.events).not.toContain("ROLLBACK");
});


test("actual PostgresProvider installs the owned-store reservation capability with an exact setup fence", async () => {
  const events: string[] = [], traces: unknown[][] = [];
  let rootCalls = 0, releases = 0;
  const root = {
    unsafe: async () => { rootCalls++; return []; },
    close: async () => {},
    reserve: async () => ({
      unsafe: async (sql: string, params: readonly unknown[] = []) => {
        events.push(`${sql}|${params.map(String).join(",")}`);
        if (sql.startsWith("SELECT pg_catalog.current_setting")) return [{ max_identifier_length: "63" }];
        return [];
      },
      release: async () => { releases++; },
    }),
  };
  const provider = new PostgresProvider({ options: {}, onSql: (_tag, params) => traces.push([...params]) });
  Object.defineProperty(provider, "sql", { value: root, configurable: true });
  const capability = postgresOwnedStoreCapability(provider);
  if (!capability) throw new Error("missing provider capability");
  const value = await capability.withOwnedStoreAdmission(undefined, async (session) => {
    expect(Object.isFrozen(session)).toBe(true); expect(session.maxIdentifierLength).toBe(63n); return "ready";
  });
  expect(value).toBe("ready"); expect(rootCalls).toBe(0); expect(releases).toBe(1);
  expect(events.map(item => item.split("|")[0])).toEqual(["BEGIN", "SELECT pg_catalog.pg_advisory_xact_lock($1::pg_catalog.int8)", "SET LOCAL search_path = pg_catalog, pg_temp", "SELECT pg_catalog.current_setting('max_identifier_length') AS max_identifier_length", "COMMIT"]);
  expect(traces.every(params => params.length === 0)).toBe(true);
});

test("actual PostgresProvider accepts an intentional undefined callback result after commit and release", async () => {
  let committed = 0, released = 0;
  const provider = new PostgresProvider({ options: {} });
  Object.defineProperty(provider, "sql", { value: { unsafe: async () => [], close: async () => {}, reserve: async () => ({ unsafe: async (sql: string) => { if (sql.startsWith("SELECT pg_catalog.current_setting")) return [{ max_identifier_length: "63" }]; if (sql === "COMMIT") committed++; return []; }, release: async () => { released++; } }) }, configurable: true });
  const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing provider capability");
  await expect(capability.withOwnedStoreAdmission(undefined, async () => undefined)).resolves.toBeUndefined();
  expect(committed).toBe(1); expect(released).toBe(1);
});

test("actual PostgresProvider preserves only an authentic callback admission error after certain cleanup", async () => {
  for (const [thrown, code] of [[new OrmOwnedStoreAdmissionError("ORM_OWNED_STORE_IDENTITY_MISSING", "ORM_OWNED_STORE_IDENTITY_MISSING"), "ORM_OWNED_STORE_IDENTITY_MISSING"], [new OrmOwnedStoreAdmissionError("ORM_OWNED_STORE_DRIFT", "ORM_OWNED_STORE_DRIFT"), "ORM_OWNED_STORE_DRIFT"], [new Error("raw callback"), "ORM_OWNED_STORE_LOCK_UNAVAILABLE"]] as const) {
    const events: string[] = []; let caught: unknown;
    const provider = new PostgresProvider({ options: {} });
    Object.defineProperty(provider, "sql", { value: { unsafe: async () => { throw new Error("root pool"); }, close: async () => {}, reserve: async () => ({ unsafe: async (sql: string) => { events.push(sql); if (sql.startsWith("SELECT pg_catalog.current_setting")) return [{ max_identifier_length: "63" }]; return []; }, release: async () => { events.push("release"); } }) }, configurable: true });
    const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing provider capability");
    try { await capability.withOwnedStoreAdmission(undefined, async () => { throw thrown; }); } catch (error) { caught = error; }
    ownedError(caught, code);
    expect(events).toContain("ROLLBACK"); expect(events).toContain("release");
  }
});

test("actual PostgresProvider rejects missing reserve before callback", async () => {
  const provider = new PostgresProvider({ options: {} });
  Object.defineProperty(provider, "sql", { value: { unsafe: async () => [], close: async () => {} }, configurable: true });
  const capability = postgresOwnedStoreCapability(provider);
  if (!capability) throw new Error("missing provider capability");
  let callbacks = 0, caught: unknown;
  try { await capability.withOwnedStoreAdmission(undefined, async () => { callbacks++; }); } catch (error) { caught = error; }
  ownedError(caught, "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); expect(callbacks).toBe(0);
});

test("actual PostgresProvider projects an absent Registry from its reserved session without a root-pool query", async () => {
  let rootCalls = 0;
  const provider = new PostgresProvider({ options: {} });
  Object.defineProperty(provider, "sql", { value: { unsafe: async () => { rootCalls++; return []; }, close: async () => {}, reserve: async () => ({ unsafe: async (sql: string) => {
    if (sql.startsWith("SELECT pg_catalog.current_setting")) return [{ max_identifier_length: "63" }];
    if (sql.startsWith("SELECT EXISTS")) return [{ public_schema_exists: true }];
    if (sql.includes("__osnv_orm_owned_stores_v1")) return [];
    return [];
  }, release: async () => {} }) }, configurable: true });
  const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing provider capability");
  const state = await capability.withOwnedStoreAdmission(undefined, async (session) => (await session.inspectRegistry()).state);
  expect(state).toEqual({ kind: "absent" }); expect(rootCalls).toBe(0);
});

test("actual PostgresProvider closes falsey reservation, search-path, and context failures before callback", async () => {
  const cases: readonly [string, unknown, OrmOwnedStoreAdmissionError["code"]][] = [
    ["falsey reserve", false, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"], ["short maximum", "62", "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"], ["noncanonical maximum", "063", "ORM_OWNED_STORE_LOCK_UNAVAILABLE"], ["wire number", 63, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
  ];
  for (const [name, maximum, code] of cases) {
    const events: string[] = []; let releases = 0, callbacks = 0, caught: unknown;
    const provider = new PostgresProvider({ options: {} });
    Object.defineProperty(provider, "sql", { value: { unsafe: async () => { throw new Error("root pool"); }, close: async () => {}, reserve: async () => name === "falsey reserve" ? maximum : ({ unsafe: async (sql: string) => { events.push(sql); if (sql === "SET LOCAL search_path = pg_catalog, pg_temp" && name === "search-path") throw new Error("set"); if (sql.startsWith("SELECT pg_catalog.current_setting")) return [{ max_identifier_length: maximum }]; return []; }, release: async () => { releases++; } }) }, configurable: true });
    const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing provider capability");
    try { await capability.withOwnedStoreAdmission(undefined, async () => { callbacks++; }); } catch (error) { caught = error; }
    ownedError(caught, code); expect(callbacks, name).toBe(0); if (name !== "falsey reserve") { expect(events).toContain("ROLLBACK"); expect(releases).toBe(1); }
  }
});

const durableDefinition = defineOrmOwnedStoreV1({ contract: "osnv.orm-owned-store/v1", storeKey: "provider-durable", formatVersion: 1, ownedScope: { schema: "public", tablePrefix: "provider_durable_" } });
const durableStorePreimage = canonicalOwnedStoreStoreLockPreimageV1(durableDefinition);
const durableScopePreimage = canonicalOwnedStoreScopeLockPreimageV1(durableDefinition.ownedScope);
const durablePlan: OwnedStoreSecondaryLockPlanV1 = Object.freeze({
  stores: Object.freeze([{ kind: "store" as const, preimage: durableStorePreimage, key: ownedStoreAdvisoryLockV1(durableStorePreimage) }]),
  scopes: Object.freeze([{ kind: "scope" as const, preimage: durableScopePreimage, key: ownedStoreAdvisoryLockV1(durableScopePreimage) }]),
});

function deferredPhysical(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve: () => resolve?.() };
}

async function admissionResult(work: () => Promise<unknown>): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }> {
  try { return { ok: true, value: await work() }; }
  catch (error) { return { ok: false, error }; }
}

function durableRecorder(step: (stage: string) => void | Promise<void> = () => {}, trace?: (tag: string) => void, registryPublicRows: readonly unknown[] = [{ public_schema_exists: true }]): { readonly capability: NonNullable<ReturnType<typeof postgresOwnedStoreCapability>>; readonly events: string[] } {
  const events: string[] = [];
  let advisoryCalls = 0;
  const session = {
    unsafe: async (sql: string) => {
      const stage = sql === "BEGIN" ? "begin"
        : sql === "COMMIT" ? "commit"
          : sql === "ROLLBACK" ? "rollback"
            : sql.startsWith("SET LOCAL") ? "searchPath"
              : sql.includes("max_identifier_length") ? "context"
                : sql.includes("pg_advisory_xact_lock") ? advisoryCalls++ === 0 ? "registryLock" : "secondaryLock"
                  : sql.startsWith("SELECT EXISTS") ? "registryPublic"
                    : sql.includes("__osnv_orm_owned_stores_v1") ? "registryRoot"
                      : "unexpected";
      events.push(stage);
      await step(stage);
      events.push(`${stage}:done`);
      if (stage === "context") return [{ max_identifier_length: "63" }];
      if (stage === "registryPublic") return registryPublicRows;
      if (stage === "registryRoot") return [];
      if (stage === "unexpected") throw new Error(`unexpected durable SQL: ${sql}`);
      return [];
    },
    release: async () => { events.push("release"); await step("release"); events.push("release:done"); },
  };
  const provider = new PostgresProvider({ options: {}, onSql: trace ? (tag: string) => trace(tag) : undefined });
  Object.defineProperty(provider, "sql", { value: { unsafe: async () => { throw new Error("root SQL is forbidden"); }, close: async () => {}, reserve: async () => { events.push("reserve"); await step("reserve"); events.push("reserve:done"); return session; } }, configurable: true });
  const capability = postgresOwnedStoreCapability(provider);
  if (!capability) throw new Error("missing durable owned-store capability");
  return { capability, events };
}

test("actual PostgresProvider drains a dangling physical secondary lock before rollback and revocation", async () => {
  const held = deferredPhysical(), entered = deferredPhysical(), releaseEntered = deferredPhysical(), releaseGate = deferredPhysical();
  const recorder = durableRecorder(async stage => {
    if (stage === "secondaryLock") { entered.resolve(); await held.promise; }
    if (stage === "release") { releaseEntered.resolve(); await releaseGate.promise; }
  });
  let settled = false;
  const pending = admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
    void registry.lockSecondary(durablePlan).catch(() => {});
    await entered.promise;
    return "callback returned";
  })).then(result => { settled = true; return result; });
  await entered.promise; await new Promise<void>(resolve => setTimeout(resolve, 0));
  const beforeDrain = { settled, events: [...recorder.events] };
  held.resolve();
  await releaseEntered.promise;
  releaseGate.resolve();
  const result = await pending;
  if (result.ok) throw new Error("dangling lock unexpectedly committed");
  ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(beforeDrain.settled).toBe(false); expect(beforeDrain.events).not.toContain("rollback"); expect(beforeDrain.events).not.toContain("release");
  expect(recorder.events.indexOf("secondaryLock:done")).toBeLessThan(recorder.events.indexOf("rollback"));
  expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
});

test("actual PostgresProvider fences old Registry handles and allows only the captured secondary Registry facade", async () => {
  const recorder = durableRecorder();
  const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
    const secondary = await registry.lockSecondary(durablePlan);
    const old = await admissionResult(() => registry.inspectRegistry());
    if (old.ok) throw new Error("old Registry facade remained usable");
    ownedError(old.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect((await secondary.inspectRegistry()).state).toEqual({ kind: "absent" });
    return "callback after old-handle misuse";
  }));
  if (result.ok) throw new Error("callback-owned misuse unexpectedly committed");
  ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(recorder.events).toContain("rollback");

  const clean = durableRecorder();
  await expect(clean.capability.withOwnedStoreAdmission(undefined, async registry => {
    const secondary = await registry.lockSecondary(durablePlan);
    expect((await secondary.inspectRegistry()).state).toEqual({ kind: "absent" });
    return "secondary read";
  })).resolves.toBe("secondary read");
  expect(clean.events).toContain("commit"); expect(clean.events).not.toContain("rollback");
});

test("actual PostgresProvider closes callback handles before rollback, fences native abort after context, and redacts proxy or falsey callback failures", async () => {
  let captured: RegistryLockedOwnedStoreSessionV1 | undefined;
  let rollbackHandle: Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }> | undefined;
  const rollback = durableRecorder(stage => { if (stage === "rollback" && captured) rollbackHandle = admissionResult(() => captured!.lockSecondary(durablePlan)); });
  const callbackFailure = await admissionResult(() => rollback.capability.withOwnedStoreAdmission(undefined, async registry => { captured = registry; throw failure("ORM_OWNED_STORE_IDENTITY_MISSING"); }));
  if (callbackFailure.ok) throw new Error("safe callback failure unexpectedly committed");
  ownedError(callbackFailure.error, "ORM_OWNED_STORE_IDENTITY_MISSING");
  if (!rollbackHandle) throw new Error("rollback did not exercise captured facade");
  const late = await rollbackHandle;
  if (late.ok) throw new Error("captured Registry remained usable during rollback");
  ownedError(late.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(rollback.events).not.toContain("secondaryLock");

  const controller = new AbortController(); let ownGetterReads = 0, callbacks = 0;
  Object.defineProperty(controller.signal, "aborted", { get() { ownGetterReads++; return false; } });
  const aborted = durableRecorder(stage => { if (stage === "context") controller.abort(); });
  const abortedResult = await admissionResult(() => aborted.capability.withOwnedStoreAdmission(controller.signal, async () => { callbacks++; return "unsafe"; }));
  if (abortedResult.ok) throw new Error("post-context abort unexpectedly entered callback");
  ownedError(abortedResult.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(ownGetterReads).toBe(0); expect(callbacks).toBe(0); expect(aborted.events).not.toContain("commit");

  for (const thrown of [false, new Proxy(failure("ORM_OWNED_STORE_DRIFT"), { get() { throw new Error("proxy get"); }, getPrototypeOf() { throw new Error("proxy prototype"); }, getOwnPropertyDescriptor() { throw new Error("proxy descriptor"); }, ownKeys() { throw new Error("proxy keys"); } })]) {
    const hostile = durableRecorder();
    const hostileResult = await admissionResult(() => hostile.capability.withOwnedStoreAdmission(undefined, async () => { throw thrown; }));
    if (hostileResult.ok) throw new Error("hostile callback failure unexpectedly committed");
    ownedError(hostileResult.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  }
});

test("actual PostgresProvider maps all three physical callback-route failures to LOCK", async () => {
  for (const [route, failingStage] of [["initial Registry", "registryPublic"], ["secondary lock", "secondaryLock"], ["secondary Registry", "registryPublic"]] as const) {
    const recorder = durableRecorder(stage => { if (stage === failingStage) throw failure("ORM_OWNED_STORE_DRIFT"); });
    const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
      if (route === "initial Registry") return registry.inspectRegistry();
      const secondary = await registry.lockSecondary(durablePlan);
      return route === "secondary Registry" ? secondary.inspectRegistry() : "unreachable";
    }));
    if (result.ok) throw new Error(`${route} physical failure unexpectedly committed`);
    ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect(recorder.events).not.toContain("commit");
    expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
    expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
  }
});

test("actual PostgresProvider poisons a swallowed rejected initial Registry read", async () => {
  let swallowed = false;
  const recorder = durableRecorder(stage => { if (stage === "registryPublic") throw new Error("physical Registry read rejected"); });
  const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
    await registry.inspectRegistry().catch(() => { swallowed = true; });
    return "callback swallowed physical Registry failure";
  }));
  expect(swallowed).toBe(true);
  if (result.ok) throw new Error("swallowed Registry failure unexpectedly committed");
  ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(recorder.events).not.toContain("commit");
  expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
  expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
});

test("actual PostgresProvider remembers a pending secondary Registry read before draining it", async () => {
  const entered = deferredPhysical(), physicalGate = deferredPhysical(), releaseEntered = deferredPhysical(), releaseGate = deferredPhysical();
  const recorder = durableRecorder(async stage => {
    if (stage === "registryPublic") { entered.resolve(); await physicalGate.promise; }
    if (stage === "release") { releaseEntered.resolve(); await releaseGate.promise; }
  });
  let settled = false;
  const pending = admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
    const secondary = await registry.lockSecondary(durablePlan);
    void secondary.inspectRegistry().catch(() => {});
    await entered.promise;
    return "callback returned with secondary read pending";
  })).then(result => { settled = true; return result; });
  await entered.promise; await new Promise<void>(resolve => setTimeout(resolve, 0));
  const beforeDrain = { settled, events: [...recorder.events] };
  physicalGate.resolve();
  await releaseEntered.promise;
  releaseGate.resolve();
  const result = await pending;
  if (result.ok) throw new Error("cleanly drained secondary Registry read unexpectedly committed");
  ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(beforeDrain.settled).toBe(false); expect(beforeDrain.events).not.toContain("commit"); expect(beforeDrain.events).not.toContain("rollback"); expect(beforeDrain.events).not.toContain("release");
  expect(recorder.events.indexOf("registryPublic:done")).toBeLessThan(recorder.events.indexOf("rollback"));
  expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
  expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
});

test("actual PostgresProvider gives settlement lock uncertainty priority over a rejected semantic callback with a pending read", async () => {
  const entered = deferredPhysical(), physicalGate = deferredPhysical(), releaseEntered = deferredPhysical(), releaseGate = deferredPhysical();
  const recorder = durableRecorder(async stage => {
    if (stage === "registryPublic") { entered.resolve(); await physicalGate.promise; }
    if (stage === "release") { releaseEntered.resolve(); await releaseGate.promise; }
  });
  let settled = false;
  const pending = admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
    const secondary = await registry.lockSecondary(durablePlan);
    void secondary.inspectRegistry().catch(() => {});
    await entered.promise;
    throw failure("ORM_OWNED_STORE_IDENTITY_MISSING");
  })).then(result => { settled = true; return result; });
  await entered.promise; await new Promise<void>(resolve => setTimeout(resolve, 0));
  const beforeDrain = { settled, events: [...recorder.events] };
  physicalGate.resolve();
  await releaseEntered.promise;
  releaseGate.resolve();
  const result = await pending;
  if (result.ok) throw new Error("pending rejected callback unexpectedly committed");
  ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(beforeDrain.settled).toBe(false); expect(beforeDrain.events).not.toContain("rollback"); expect(beforeDrain.events).not.toContain("release");
  expect(recorder.events.indexOf("registryPublic:done")).toBeLessThan(recorder.events.indexOf("rollback"));
  expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
  expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
});

test("actual PostgresProvider gives native abort during rollback or release priority over a semantic callback error", async () => {
  for (const cleanup of ["rollback", "release"] as const) {
    const controller = new AbortController();
    const recorder = durableRecorder(stage => { if (stage === cleanup) controller.abort(); });
    const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(controller.signal, async () => { throw failure("ORM_OWNED_STORE_IDENTITY_MISSING"); }));
    if (result.ok) throw new Error(`abort during ${cleanup} unexpectedly preserved semantic error`);
    ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
    expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
  }
});

test("actual PostgresProvider does not let a fresh semantic error hide swallowed read or phase uncertainty", async () => {
  for (const origin of ["read", "phase"] as const) {
    const recorder = durableRecorder(stage => { if (origin === "read" && stage === "registryPublic") throw new Error("physical Registry read"); });
    const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
      if (origin === "read") await registry.inspectRegistry().catch(() => {});
      else { await registry.lockSecondary(durablePlan); await registry.inspectRegistry().catch(() => {}); }
      throw failure("ORM_OWNED_STORE_DRIFT");
    }));
    if (result.ok) throw new Error(`swallowed ${origin} uncertainty unexpectedly committed`);
    ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect(recorder.events).not.toContain("commit");
    expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
    expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
  }
});

test("actual PostgresProvider classifies trace-hook failures on Registry and secondary locks as lock uncertainty", async () => {
  for (const route of ["registry-read", "store-lock", "scope-lock"] as const) {
    const recorder = durableRecorder(undefined, tag => { if (tag === `osnv.owned-store:${route}`) throw failure("ORM_OWNED_STORE_DRIFT"); });
    const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
      if (route === "registry-read") return registry.inspectRegistry();
      const secondary = await registry.lockSecondary(durablePlan);
      return secondary.inspectRegistry();
    }));
    if (result.ok) throw new Error(`${route} trace failure unexpectedly committed`);
    ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect(recorder.events).not.toContain("commit");
    expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
    expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
  }
});

test("actual PostgresProvider preserves a semantic DRIFT after a successful Registry snapshot and certain cleanup", async () => {
  const recorder = durableRecorder();
  const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
    expect((await registry.inspectRegistry()).state).toEqual({ kind: "absent" });
    throw failure("ORM_OWNED_STORE_DRIFT");
  }));
  if (result.ok) throw new Error("clean semantic DRIFT unexpectedly committed");
  ownedError(result.error, "ORM_OWNED_STORE_DRIFT");
  expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
  expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
});

test("actual PostgresProvider records invalid initial and secondary Registry wire facts as lock uncertainty", async () => {
  for (const [location, rows] of [["initial boolean", [{ public_schema_exists: "true" }]], ["initial cardinality", [{ public_schema_exists: true }, { public_schema_exists: true }]], ["secondary boolean", [{ public_schema_exists: "true" }]], ["secondary cardinality", [{ public_schema_exists: true }, { public_schema_exists: true }]]] as const) {
    const recorder = durableRecorder(undefined, undefined, rows);
    const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(undefined, async registry => {
      if (location.startsWith("initial")) await registry.inspectRegistry().catch(() => {});
      else { const secondary = await registry.lockSecondary(durablePlan); await secondary.inspectRegistry().catch(() => {}); }
      throw failure("ORM_OWNED_STORE_DRIFT");
    }));
    if (result.ok) throw new Error(`${location} invalid wire unexpectedly committed`);
    ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect(recorder.events).not.toContain("commit");
    expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
    expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
  }
});

test("actual PostgresProvider fences already-aborted native signals before Registry, secondary lock, and secondary Registry dispatch", async () => {
  for (const route of ["registry", "secondaryLock", "secondaryRegistry"] as const) {
    const controller = new AbortController(), recorder = durableRecorder();
    const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(controller.signal, async registry => {
      if (route === "registry") { controller.abort(); return registry.inspectRegistry(); }
      if (route === "secondaryLock") { controller.abort(); return registry.lockSecondary(durablePlan); }
      const secondary = await registry.lockSecondary(durablePlan);
      controller.abort();
      return secondary.inspectRegistry();
    }));
    if (result.ok) throw new Error(`${route} pre-abort unexpectedly committed`);
    ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    if (route !== "secondaryLock") expect(recorder.events).not.toContain("registryPublic");
    else expect(recorder.events).not.toContain("secondaryLock");
    expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
    expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
  }
});

test("actual PostgresProvider applies a post-trace native abort fence to every reachable working dispatch tag", async () => {
  const cases = [
    ["begin", "begin"], ["registry-lock", "registryLock"], ["search-path", "searchPath"], ["server-context", "context"],
    ["registry-read", "registryPublic"], ["store-lock", "secondaryLock"], ["scope-lock", "scopeLock"], ["commit", "commit"],
  ] as const;
  for (const [tag, blockedStage] of cases) {
    const controller = new AbortController();
    const recorder = durableRecorder(undefined, trace => { if (trace === `osnv.owned-store:${tag}`) controller.abort(); });
    const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(controller.signal, async registry => {
      if (tag === "registry-read") return registry.inspectRegistry();
      if (tag === "store-lock" || tag === "scope-lock") return registry.lockSecondary(durablePlan);
      return "clean callback";
    }));
    if (result.ok) throw new Error(`${tag} trace-abort unexpectedly committed`);
    ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    if (tag === "scope-lock") expect(recorder.events.filter(event => event === "secondaryLock")).toHaveLength(1);
    else expect(recorder.events).not.toContain(blockedStage);
    expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
    expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
  }
});

test("actual PostgresProvider still dispatches rollback and release when cleanup trace observes an abort", async () => {
  const controller = new AbortController();
  const recorder = durableRecorder(undefined, tag => { if (tag === "osnv.owned-store:rollback") controller.abort(); });
  const result = await admissionResult(() => recorder.capability.withOwnedStoreAdmission(controller.signal, async () => { throw failure("ORM_OWNED_STORE_IDENTITY_MISSING"); }));
  if (result.ok) throw new Error("cleanup abort unexpectedly committed");
  ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(recorder.events.filter(event => event === "rollback")).toHaveLength(1);
  expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
});

const mutationTable = Object.freeze({
  schema: "owned", table: "jobs",
  columns: Object.freeze([{ property: "id", column: "id", physicalType: "integer", nullable: false, generation: "none" as const, default: Object.freeze({ kind: "none" as const }) }]),
  primaryKey: Object.freeze({ name: "jobs_pkey", columns: Object.freeze(["id"]) }), indexes: Object.freeze([]), foreignKeys: Object.freeze([]), checks: Object.freeze([]),
});
const mutationOperations: readonly OwnedStoreCreateOperationV1[] = Object.freeze([
  Object.freeze({ kind: "createSchema" as const, schema: "owned" }),
  Object.freeze({ kind: "createTable" as const, table: mutationTable }),
  Object.freeze({ kind: "addForeignKey" as const, table: mutationTable, foreignKey: Object.freeze({ name: "jobs_fk", columns: Object.freeze(["id"]), target: Object.freeze({ schema: "public", table: "root" }), targetColumns: Object.freeze(["id"]), onDelete: "restrict", onUpdate: "noAction" }) }),
  Object.freeze({ kind: "createIndex" as const, table: mutationTable, index: Object.freeze({ name: "jobs_idx", columns: Object.freeze(["id"]), unique: false, method: "btree" }) }),
]);
const mutationRows: readonly OwnedStoreIdentityInsertV1[] = Object.freeze([
  Object.freeze({ storeKey: "alpha", contract: "osnv.orm-owned-store/v1", formatVersion: 1, ownedSchema: "owned", tablePrefix: "jobs_", ownedScopeHash: `sha256:${"1".repeat(64)}` as `sha256:${string}`, modelHash: `sha256:${"2".repeat(64)}` as `sha256:${string}` }),
  Object.freeze({ storeKey: "beta", contract: "osnv.orm-owned-store/v1", formatVersion: 2, ownedSchema: "owned", tablePrefix: "tasks_", ownedScopeHash: `sha256:${"3".repeat(64)}` as `sha256:${string}`, modelHash: `sha256:${"4".repeat(64)}` as `sha256:${string}` }),
]);

function mutationRecorder(result: (sql: string) => unknown | Promise<unknown> = () => Object.assign([], { affectedRows: 1 }), signal?: AbortSignal, onTrace?: (tag: string) => void, onRelease?: () => void | Promise<void>): { readonly events: string[]; readonly queries: { readonly sql: string; readonly params: readonly unknown[] }[]; readonly traces: string[]; readonly traceCalls: { readonly tag: string; readonly params: readonly unknown[] }[]; readonly counts: () => { readonly roots: number; readonly reserves: number; readonly releases: number }; readonly run: (work: (secondary: SecondaryLockedOwnedStoreSessionV1) => Promise<unknown>) => Promise<unknown> } {
  const events: string[] = [], queries: { sql: string; params: readonly unknown[] }[] = [], traces: string[] = [], traceCalls: { tag: string; params: readonly unknown[] }[] = [];
  let roots = 0, reserves = 0, releases = 0;
  const session = {
    unsafe: async (sql: string, params: readonly unknown[] = []) => {
      events.push(sql); queries.push({ sql, params: [...params] });
      if (sql.includes("max_identifier_length")) return [{ max_identifier_length: "63" }];
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL") || sql.includes("pg_advisory_xact_lock")) return [];
      return await result(sql);
    },
    release: async () => { releases++; events.push("release"); await onRelease?.(); },
  };
  const provider = new PostgresProvider({ options: {}, redactSqlParams: false, onSql: (tag, params) => { traces.push(tag); traceCalls.push({ tag, params: [...params] }); onTrace?.(tag); } });
  Object.defineProperty(provider, "sql", { value: { unsafe: async () => { roots++; throw new Error("root pool forbidden"); }, close: async () => {}, reserve: async () => { reserves++; return session; } }, configurable: true });
  const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing mutation capability");
  return {
    events, queries, traces, traceCalls, counts: () => ({ roots, reserves, releases }),
    run: async work => capability.withOwnedStoreAdmission(signal, async registry => {
      const secondary = await registry.lockSecondary({ stores: Object.freeze([]), scopes: Object.freeze([]) });
      return work(secondary);
    }),
  };
}

test("actual PostgresProvider renders only the four admission mutation variants and exact Registry DDL", async () => {
  const recorder = mutationRecorder();
  await recorder.run(async secondary => { await secondary.createRegistryV1(); await secondary.applyCreateOperations(mutationOperations); });
  const ddl = recorder.queries.filter(query => /^(CREATE|ALTER) /.test(query.sql));
  expect(ddl.map(query => query.sql)).toEqual([
    'CREATE TABLE "public"."__osnv_orm_owned_stores_v1" ("store_key" pg_catalog.text NOT NULL, "contract" pg_catalog.text NOT NULL, "format_version" pg_catalog.int8 NOT NULL, "owned_schema" pg_catalog.text NOT NULL, "table_prefix" pg_catalog.text NOT NULL, "owned_scope_hash" pg_catalog.text NOT NULL, "model_hash" pg_catalog.text NOT NULL, "created_at" pg_catalog.timestamptz NOT NULL, CONSTRAINT "__osnv_orm_owned_stores_v1_pkey" PRIMARY KEY ("store_key"))',
    'CREATE SCHEMA "owned"',
    'CREATE TABLE "owned"."jobs" ("id" bigint NOT NULL, CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"))',
    'ALTER TABLE "owned"."jobs" ADD CONSTRAINT "jobs_fk" FOREIGN KEY ("id") REFERENCES "public"."root" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    'CREATE INDEX "jobs_idx" ON "owned"."jobs" ("id")',
  ]);
  expect(ddl.every(query => query.params.length === 0)).toBe(true);
  expect(recorder.traces).toEqual(["osnv.owned-store:begin", "osnv.owned-store:registry-lock", "osnv.owned-store:search-path", "osnv.owned-store:server-context", "osnv.owned-store:registry-create", "osnv.owned-store:schema-create", "osnv.owned-store:table-create", "osnv.owned-store:foreign-key-create", "osnv.owned-store:index-create", "osnv.owned-store:commit"]);
});

test("actual PostgresProvider uses seven canonical identity parameters, database time, and strict native affected metadata", async () => {
  for (const metadata of [Object.assign([], { affectedRows: null, count: 1 }), Object.assign([], { count: 1 }), Object.assign([], { affectedRows: 1 }), Object.assign([], { affectedRows: 1, count: 1 })]) {
    const recorder = mutationRecorder(() => metadata);
    await recorder.run(secondary => secondary.insertIdentities(mutationRows));
    const inserts = recorder.queries.filter(query => query.sql.startsWith("INSERT "));
    expect(inserts).toHaveLength(2);
    for (const [index, query] of inserts.entries()) {
      const row = mutationRows[index]!;
      expect(query.sql).toBe('INSERT INTO "public"."__osnv_orm_owned_stores_v1" ("store_key","contract","format_version","owned_schema","table_prefix","owned_scope_hash","model_hash","created_at") VALUES($1,$2,$3::pg_catalog.int8,$4,$5,$6,$7,pg_catalog.clock_timestamp())');
      expect(query.params).toEqual([row.storeKey, row.contract, row.formatVersion, row.ownedSchema, row.tablePrefix, row.ownedScopeHash, row.modelHash]);
    }
  }
  for (const metadata of [Object.assign([], {}), Object.assign([], { affectedRows: null }), Object.assign([], { affectedRows: null, count: null }), Object.assign([], { affectedRows: 1, count: null }), Object.assign([], { affectedRows: 1, count: undefined }), Object.assign([], { affectedRows: 0 }), Object.assign([], { count: 2 }), Object.assign([], { affectedRows: 1, count: 2 }), Object.assign([{}], { affectedRows: "1" })]) {
    const recorder = mutationRecorder(() => metadata);
    const rejected = await admissionResult(() => recorder.run(secondary => secondary.insertIdentities(mutationRows)));
    if (rejected.ok) throw new Error("invalid INSERT metadata committed");
    ownedError(rejected.error, "ORM_OWNED_STORE_CREATE_FAILED");
    expect(recorder.events).toContain("ROLLBACK"); expect(recorder.events).toContain("release");
  }
});

test("actual PostgresProvider closes mutation rendering, physical failure, duplicate and abort paths", async () => {
  for (const operations of [[{ kind: "addColumn" }] as never, [{ kind: "addCheck" }] as never, [{ kind: "raw", sql: "DROP TABLE forbidden" }] as never, [{ kind: "createTable", table: {} }] as never, [null] as never] as const) {
    const recorder = mutationRecorder();
    const rejected = await admissionResult(() => recorder.run(secondary => secondary.applyCreateOperations(operations)));
    if (rejected.ok) throw new Error("invalid mutation operation committed");
    ownedError(rejected.error, "ORM_OWNED_STORE_CREATE_FAILED");
    expect(recorder.queries.filter(query => /^(CREATE|ALTER) /.test(query.sql))).toHaveLength(0); expect(recorder.events).not.toContain("COMMIT");
  }
  const physical = mutationRecorder(() => { throw new Error("DDL failure"); });
  const failed = await admissionResult(() => physical.run(secondary => secondary.createRegistryV1()));
  if (failed.ok) throw new Error("physical mutation failure committed");
  ownedError(failed.error, "ORM_OWNED_STORE_CREATE_FAILED");
  const duplicate = mutationRecorder();
  const repeated = await admissionResult(() => duplicate.run(async secondary => { await secondary.createRegistryV1(); await secondary.createRegistryV1(); }));
  if (repeated.ok) throw new Error("duplicate mutation committed");
  ownedError(repeated.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  const controller = new AbortController(), aborted = mutationRecorder(() => { controller.abort(); return Object.assign([], { affectedRows: 1 }); }, controller.signal);
  const cancelled = await admissionResult(() => aborted.run(secondary => secondary.insertIdentities(mutationRows)));
  if (cancelled.ok) throw new Error("post-insert abort committed");
  ownedError(cancelled.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(aborted.events).not.toContain("COMMIT"); expect(aborted.events).toContain("ROLLBACK");
});

test("actual PostgresProvider accepts native result arrays but never reads metadata getters or proxy traps", async () => {
  let getterReads = 0, proxyDescriptorTraps = 0;
  class NativeResult extends Array<unknown> {}
  const native = new NativeResult();
  Object.defineProperties(native, {
    affectedRows: { value: null, enumerable: false }, count: { value: 1, enumerable: false }, command: { value: "INSERT", enumerable: false }, lastInsertRowid: { value: null, enumerable: false },
  });
  await mutationRecorder(() => native).run(secondary => secondary.insertIdentities(mutationRows));
  for (const subclass of [false, true]) for (const flags of [false, true]) {
    const result: unknown[] = subclass ? new NativeResult() : [];
    Object.defineProperties(result, { affectedRows: { value: null, writable: flags, configurable: flags, enumerable: flags }, count: { value: 1, writable: flags, configurable: flags, enumerable: flags }, command: { value: "INSERT", writable: flags, configurable: flags, enumerable: flags }, lastInsertRowid: { value: null, writable: flags, configurable: flags, enumerable: flags } });
    await mutationRecorder(() => result).run(secondary => secondary.insertIdentities(mutationRows));
  }
  class InheritedResult extends Array<unknown> { get affectedRows() { getterReads++; return 1; } get count() { getterReads++; return 1; } }
  const inherited = new InheritedResult();
  const inheritedResult = await admissionResult(() => mutationRecorder(() => inherited).run(secondary => secondary.insertIdentities(mutationRows)));
  if (inheritedResult.ok) throw new Error("inherited metadata unexpectedly accepted");
  ownedError(inheritedResult.error, "ORM_OWNED_STORE_CREATE_FAILED"); expect(getterReads).toBe(0);
  const accessor = Object.assign([], { count: 1 });
  Object.defineProperty(accessor, "affectedRows", { get() { getterReads++; return 1; } });
  const accessorResult = await admissionResult(() => mutationRecorder(() => accessor).run(secondary => secondary.insertIdentities(mutationRows)));
  if (accessorResult.ok) throw new Error("metadata accessor unexpectedly accepted");
  ownedError(accessorResult.error, "ORM_OWNED_STORE_CREATE_FAILED"); expect(getterReads).toBe(0);
  const proxy = new Proxy(Object.assign([], { affectedRows: null, count: 1 }), {
    get(_target, key) { if (key === "then") return undefined; throw new Error("get"); }, getOwnPropertyDescriptor() { proxyDescriptorTraps++; throw new Error("descriptor"); },
  });
  const proxyResult = await admissionResult(() => mutationRecorder(() => proxy).run(secondary => secondary.insertIdentities(mutationRows)));
  if (proxyResult.ok) throw new Error("metadata proxy unexpectedly accepted");
  ownedError(proxyResult.error, "ORM_OWNED_STORE_CREATE_FAILED"); expect(proxyDescriptorTraps).toBe(0);
  const nonArrayResult = await admissionResult(() => mutationRecorder(() => ({ count: 1 })).run(secondary => secondary.insertIdentities(mutationRows)));
  if (nonArrayResult.ok) throw new Error("plain metadata object unexpectedly accepted");
  ownedError(nonArrayResult.error, "ORM_OWNED_STORE_CREATE_FAILED");
});

async function invokeMutation(method: "registry" | "apply" | "insert", secondary: SecondaryLockedOwnedStoreSessionV1): Promise<void> {
  if (method === "registry") return secondary.createRegistryV1();
  if (method === "apply") return secondary.applyCreateOperations(mutationOperations);
  return secondary.insertIdentities(mutationRows);
}

test("actual PostgresProvider fences once, swallowed, parallel and mutation-trace failures for every mutation method", async () => {
  for (const method of ["registry", "apply", "insert"] as const) {
    const once = mutationRecorder();
    const duplicate = await admissionResult(() => once.run(async secondary => { await invokeMutation(method, secondary); await invokeMutation(method, secondary); }));
    if (duplicate.ok) throw new Error(`${method} duplicate committed`);
    ownedError(duplicate.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(once.events).not.toContain("COMMIT");

    const swallowed = mutationRecorder(() => { throw failure("ORM_OWNED_STORE_DRIFT"); });
    const swallowedResult = await admissionResult(() => swallowed.run(async secondary => { await invokeMutation(method, secondary).catch(() => {}); throw failure("ORM_OWNED_STORE_DRIFT"); }));
    if (swallowedResult.ok) throw new Error(`${method} swallowed failure committed`);
    ownedError(swallowedResult.error, "ORM_OWNED_STORE_CREATE_FAILED");

    const traced = mutationRecorder(undefined, undefined, tag => { if (tag === `osnv.owned-store:${method === "registry" ? "registry-create" : method === "apply" ? "schema-create" : "identity-insert"}`) throw new Error("trace failure"); });
    const traceResult = await admissionResult(() => traced.run(secondary => invokeMutation(method, secondary)));
    if (traceResult.ok) throw new Error(`${method} trace failure committed`);
    ownedError(traceResult.error, "ORM_OWNED_STORE_CREATE_FAILED"); expect(traced.events).toContain("ROLLBACK");
  }
});

test("actual PostgresProvider drains one physical mutation while a parallel same-method call poisons each attempt", async () => {
  for (const method of ["registry", "apply", "insert"] as const) {
    const entered = deferredPhysical(), release = deferredPhysical();
    const recorder = mutationRecorder(sql => {
      if (/^(CREATE|ALTER|INSERT) /.test(sql)) { entered.resolve(); return release.promise.then(() => Object.assign([], { affectedRows: 1 })); }
      return Object.assign([], { affectedRows: 1 });
    });
    const pending = admissionResult(() => recorder.run(async secondary => {
      const first = invokeMutation(method, secondary);
      await entered.promise;
      const second = invokeMutation(method, secondary);
      release.resolve();
      await first;
      await second.catch(() => {});
      return "swallowed parallel rejection";
    }));
    const result = await pending;
    if (result.ok) throw new Error(`${method} parallel mutation committed`);
    ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    const statements = recorder.queries.filter(query => /^(CREATE|ALTER|INSERT) /.test(query.sql)), maximum = method === "apply" ? 4 : method === "insert" ? 2 : 1;
    const identities = statements.map(query => `${query.sql}\0${JSON.stringify(query.params)}`);
    expect(statements.length).toBeGreaterThanOrEqual(1); expect(statements.length).toBeLessThanOrEqual(maximum); expect(new Set(identities).size).toBe(identities.length);
    const expected = method === "registry"
      ? [{ sql: 'CREATE TABLE "public"."__osnv_orm_owned_stores_v1" ("store_key" pg_catalog.text NOT NULL, "contract" pg_catalog.text NOT NULL, "format_version" pg_catalog.int8 NOT NULL, "owned_schema" pg_catalog.text NOT NULL, "table_prefix" pg_catalog.text NOT NULL, "owned_scope_hash" pg_catalog.text NOT NULL, "model_hash" pg_catalog.text NOT NULL, "created_at" pg_catalog.timestamptz NOT NULL, CONSTRAINT "__osnv_orm_owned_stores_v1_pkey" PRIMARY KEY ("store_key"))', params: [] }]
      : method === "apply"
        ? [{ sql: 'CREATE SCHEMA "owned"', params: [] }, { sql: 'CREATE TABLE "owned"."jobs" ("id" bigint NOT NULL, CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"))', params: [] }, { sql: 'ALTER TABLE "owned"."jobs" ADD CONSTRAINT "jobs_fk" FOREIGN KEY ("id") REFERENCES "public"."root" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION', params: [] }, { sql: 'CREATE INDEX "jobs_idx" ON "owned"."jobs" ("id")', params: [] }]
        : mutationRows.map(row => ({ sql: 'INSERT INTO "public"."__osnv_orm_owned_stores_v1" ("store_key","contract","format_version","owned_schema","table_prefix","owned_scope_hash","model_hash","created_at") VALUES($1,$2,$3::pg_catalog.int8,$4,$5,$6,$7,pg_catalog.clock_timestamp())', params: [row.storeKey, row.contract, row.formatVersion, row.ownedSchema, row.tablePrefix, row.ownedScopeHash, row.modelHash] }));
    expect(statements).toEqual(expected.slice(0, statements.length));
    expect(recorder.events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(recorder.events.filter(event => event === "release")).toHaveLength(1); expect(recorder.events).not.toContain("COMMIT");
  }
});

test("actual PostgresProvider drains fulfilled and rejected dangling mutations through release before every final LOCK", async () => {
  for (const method of ["registry", "apply", "insert"] as const) for (const rejectedCallback of [false, true]) {
    const entered = deferredPhysical(), physicalGate = deferredPhysical(), releaseEntered = deferredPhysical(), releaseGate = deferredPhysical();
    const recorder = mutationRecorder(sql => {
      if (/^(CREATE|ALTER|INSERT) /.test(sql)) { entered.resolve(); return physicalGate.promise.then(() => Object.assign([], { affectedRows: 1 })); }
      return Object.assign([], { affectedRows: 1 });
    }, undefined, undefined, async () => { releaseEntered.resolve(); await releaseGate.promise; });
    let settled = false;
    const pending = admissionResult(() => recorder.run(async secondary => {
      void invokeMutation(method, secondary).catch(() => {});
      await entered.promise;
      if (rejectedCallback) throw failure("ORM_OWNED_STORE_DRIFT");
      return "fulfilled while mutation pending";
    })).then(value => { settled = true; return value; });
    await entered.promise; await new Promise<void>(resolve => setTimeout(resolve, 0));
    const beforePhysical = [...recorder.events];
    physicalGate.resolve(); await releaseEntered.promise;
    const beforeRelease = { settled, events: [...recorder.events] };
    releaseGate.resolve(); const final = await pending;
    if (final.ok) throw new Error(`${method}/${rejectedCallback} dangling mutation committed`);
    ownedError(final.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect(beforePhysical).not.toContain("ROLLBACK"); expect(beforePhysical).not.toContain("COMMIT"); expect(beforePhysical).not.toContain("release");
    expect(beforeRelease.settled).toBe(false); expect(beforeRelease.events).toContain("release");
    expect(recorder.events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(recorder.events.filter(event => event === "release")).toHaveLength(1); expect(recorder.events).not.toContain("COMMIT");
  }
});

test("actual PostgresProvider fences retained mutation handles and permits a clean later admission", async () => {
  for (const method of ["registry", "apply", "insert"] as const) {
    const recorder = mutationRecorder(); let retained: SecondaryLockedOwnedStoreSessionV1 | undefined;
    await recorder.run(async secondary => { retained = secondary; await invokeMutation(method, secondary); return "first"; });
    if (!retained) throw new Error("missing retained handle");
    const beforeLate = { events: [...recorder.events], queries: recorder.queries.length, counts: recorder.counts() };
    const late = await admissionResult(() => invokeMutation(method, retained!));
    if (late.ok) throw new Error(`${method} late handle succeeded`);
    ownedError(late.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect(recorder.events).toEqual(beforeLate.events); expect(recorder.queries).toHaveLength(beforeLate.queries); expect(recorder.counts()).toEqual(beforeLate.counts);
    const mutationCount = recorder.events.filter(event => /^(CREATE|ALTER|INSERT) /.test(event)).length;
    await expect(recorder.run(secondary => invokeMutation(method, secondary))).resolves.toBeUndefined();
    expect(recorder.events.filter(event => /^(CREATE|ALTER|INSERT) /.test(event))).toHaveLength(mutationCount + (method === "apply" ? 4 : method === "insert" ? 2 : 1));
    expect(recorder.counts()).toEqual({ roots: 0, reserves: 2, releases: 2 }); expect(recorder.events.filter(event => event === "COMMIT")).toHaveLength(2);
  }
});

test("actual PostgresProvider fences all mutation methods before SQL and all six mutation trace tags", async () => {
  for (const method of ["registry", "apply", "insert"] as const) {
    const controller = new AbortController(), recorder = mutationRecorder(undefined, controller.signal);
    const outcome = await admissionResult(() => recorder.run(async secondary => { controller.abort(); return invokeMutation(method, secondary); }));
    if (outcome.ok) throw new Error(`${method} pre-abort succeeded`);
    ownedError(outcome.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(recorder.events.filter(event => /^(CREATE|ALTER|INSERT) /.test(event))).toHaveLength(0);
  }
  const traceCases: readonly [string, (secondary: SecondaryLockedOwnedStoreSessionV1) => Promise<void>][] = [
    ["registry-create", secondary => secondary.createRegistryV1()],
    ["schema-create", secondary => secondary.applyCreateOperations([mutationOperations[0]!])],
    ["table-create", secondary => secondary.applyCreateOperations([mutationOperations[1]!])],
    ["foreign-key-create", secondary => secondary.applyCreateOperations([mutationOperations[2]!])],
    ["index-create", secondary => secondary.applyCreateOperations([mutationOperations[3]!])],
    ["identity-insert", secondary => secondary.insertIdentities(mutationRows)],
  ];
  for (const [tag, invoke] of traceCases) {
    const controller = new AbortController(), recorder = mutationRecorder(undefined, controller.signal, trace => { if (trace === `osnv.owned-store:${tag}`) controller.abort(); });
    const outcome = await admissionResult(() => recorder.run(invoke));
    if (outcome.ok) throw new Error(`${tag} post-trace abort succeeded`);
    ownedError(outcome.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
    expect(recorder.traceCalls.map(call => call.params)).toEqual(recorder.traceCalls.map(() => []));
    expect(recorder.traces.slice(0, 5)).toEqual(["osnv.owned-store:begin", "osnv.owned-store:registry-lock", "osnv.owned-store:search-path", "osnv.owned-store:server-context", `osnv.owned-store:${tag}`]);
    expect(recorder.events.filter(event => /^(CREATE|ALTER|INSERT) /.test(event))).toEqual([]);
    expect(recorder.events).not.toContain("COMMIT"); expect(recorder.events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(recorder.events.filter(event => event === "release")).toHaveLength(1);
  }
});

test("actual PostgresProvider maps every physical mutation failure form and cleanup uncertainty", async () => {
  for (const method of ["registry", "apply", "insert"] as const) for (const thrown of [new Error("raw"), undefined, null, failure("ORM_OWNED_STORE_DRIFT"), new Proxy(failure("ORM_OWNED_STORE_DRIFT"), {})] as const) {
    const recorder = mutationRecorder(() => { throw thrown; });
    const outcome = await admissionResult(() => recorder.run(secondary => invokeMutation(method, secondary)));
    if (outcome.ok) throw new Error(`${method} physical failure succeeded`);
    ownedError(outcome.error, "ORM_OWNED_STORE_CREATE_FAILED"); expect(recorder.events).toContain("ROLLBACK"); expect(recorder.events).not.toContain("COMMIT");
  }
  const controller = new AbortController();
  const cleanup = mutationRecorder(() => { throw new Error("mutation"); }, controller.signal, tag => { if (tag === "osnv.owned-store:rollback") controller.abort(); });
  const outcome = await admissionResult(() => cleanup.run(secondary => secondary.createRegistryV1()));
  if (outcome.ok) throw new Error("cleanup abort succeeded");
  ownedError(outcome.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE"); expect(cleanup.events).toContain("ROLLBACK"); expect(cleanup.events).toContain("release");
});

test("actual PostgresProvider exhaustively applies the asymmetric native metadata authority without coercion", async () => {
  const values = ["absent", "null", "one", "zero", "two", "nan", "string", "bigint", "undefined", "coercible", "accessor"] as const;
  type MetadataValue = typeof values[number];
  const set = (target: unknown[], name: "affectedRows" | "count", value: MetadataValue, reads: { value: number }) => {
    if (value === "absent") return;
    if (value === "accessor") { Object.defineProperty(target, name, { get() { reads.value++; return 1; } }); return; }
    const raw: Record<Exclude<MetadataValue, "absent" | "accessor">, unknown> = { null: null, one: 1, zero: 0, two: 2, nan: NaN, string: "1", bigint: 1n, undefined: undefined, coercible: { valueOf() { throw new Error("coercion forbidden"); } } };
    Object.defineProperty(target, name, { value: raw[value], enumerable: false });
  };
  const expected = (affectedRows: MetadataValue, count: MetadataValue) => {
    const affectedValid = affectedRows === "absent" || affectedRows === "null" || affectedRows === "one";
    const countValid = count === "absent" || count === "one";
    return affectedValid && countValid && (affectedRows === "one" || count === "one");
  };
  for (const affectedRows of values) for (const count of values) for (const length of [0, 1]) {
    const reads = { value: 0 }, metadata = Array.from({ length }); set(metadata, "affectedRows", affectedRows, reads); set(metadata, "count", count, reads);
    const result = await admissionResult(() => mutationRecorder(() => metadata).run(secondary => secondary.insertIdentities(mutationRows)));
    expect(reads.value).toBe(0);
    if (expected(affectedRows, count)) expect(result.ok).toBe(true);
    else { if (result.ok) throw new Error(`invalid metadata accepted: ${affectedRows}/${count}/${length}`); ownedError(result.error, "ORM_OWNED_STORE_CREATE_FAILED"); }
  }
});

type SelectTransportRoute = "context" | "public" | "root";
type SelectTransportObservation = { calls: number };
type SelectTransportMaker = (row: Record<string, unknown>, observed: SelectTransportObservation) => unknown;

function selectTransportRecorder(route: SelectTransportRoute, make: SelectTransportMaker) {
  const events: string[] = [], observed: SelectTransportObservation = { calls: 0 };
  let callbacks = 0, reserves = 0, roots = 0;
  const row: Record<string, unknown> = route === "context" ? { max_identifier_length: "63" } : route === "public" ? { public_schema_exists: true } : { relation_oid: "12345" };
  const result = make(row, observed);
  const session = {
    unsafe: async (sql: string) => {
      events.push(sql);
      if (sql.includes("max_identifier_length")) return route === "context" ? result : [{ max_identifier_length: "63" }];
      if (sql.includes("pg_namespace") && sql.includes("EXISTS")) return route === "public" ? result : [{ public_schema_exists: true }];
      if (sql.includes("__osnv_orm_owned_stores_v1")) return route === "root" ? result : [];
      if (sql.includes("pg_class")) return [];
      if (["BEGIN", "COMMIT", "ROLLBACK", "SET LOCAL search_path = pg_catalog, pg_temp"].includes(sql) || sql.includes("pg_advisory_xact_lock")) return [];
      throw new Error("unexpected SELECT transport SQL");
    },
    release: async () => { events.push("release"); },
  };
  const provider = new PostgresProvider({ options: {} });
  Object.defineProperty(provider, "sql", { configurable: true, value: {
    reserve: async () => { reserves++; return session; },
    unsafe: async () => { roots++; throw new Error("root pool forbidden"); },
    close: async () => {},
  } });
  const capability = postgresOwnedStoreCapability(provider);
  if (!capability) throw new Error("missing provider capability");
  const run = async (secondary: boolean, swallow: boolean) => capability.withOwnedStoreAdmission(undefined, async registry => {
    callbacks++;
    const facade = secondary ? await registry.lockSecondary({ stores: [], scopes: [] }) : registry;
    const reading = facade.inspectRegistry();
    if (swallow) { await reading.catch(() => {}); throw failure("ORM_OWNED_STORE_DRIFT"); }
    return await reading;
  }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  return { events, observed, run, counts: () => ({ callbacks, reserves, roots }) };
}

function selectTransportLocked(result: { ok: true; value: unknown } | { ok: false; error: unknown }, events: readonly string[]): void {
  expect(result.ok).toBe(false);
  if (!result.ok) ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(events).not.toContain("COMMIT");
  expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1);
  expect(events.filter(event => event === "release")).toHaveLength(1);
  expect(events.slice(-2)).toEqual(["ROLLBACK", "release"]);
}

const selectTransportBad: readonly [string, SelectTransportMaker][] = [
  ["null container", () => null], ["number container", () => 1], ["array-like object", row => ({ 0: row, length: 1 })], ["sparse array", () => new Array(1)],
  ["index getter", (row, observed) => Object.defineProperty(new Array(1), "0", { get() { observed.calls++; return row; } })],
  ["extra container key", row => Object.assign([row], { secret: true })], ["noncanonical index", row => Object.assign([row], { "01": row })], ["own container symbol", row => Object.assign([row], { [Symbol("extra")]: true })],
  ["metadata getter", (row, observed) => Object.defineProperty([row], "count", { get() { observed.calls++; return 1; } })],
  ["container proxy", (row, observed) => new Proxy([row], { ownKeys(target) { observed.calls++; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { observed.calls++; return Object.getOwnPropertyDescriptor(target, key); } })],
  ["null row", () => [null]], ["array row", () => [[]]], ["number row", () => [1]], ["missing alias", () => [{}]], ["extra row alias", row => [{ ...row, extra: "untrusted" }]], ["own row symbol", row => [{ ...row, [Symbol("extra")]: "untrusted" }]],
  ["alias accessor", (row, observed) => [Object.defineProperty({}, Object.keys(row)[0]!, { get() { observed.calls++; return Object.values(row)[0]; }, enumerable: true })]], ["inherited alias only", row => [Object.create(row)]],
  ["row proxy", (row, observed) => [new Proxy(row, { ownKeys(target) { observed.calls++; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { observed.calls++; return Object.getOwnPropertyDescriptor(target, key); } })]],
  ["wrong primitive", row => [{ [Object.keys(row)[0]!]: typeof Object.values(row)[0] === "boolean" ? "true" : 42 }]], ["coercible primitive", (row, observed) => [{ [Object.keys(row)[0]!]: { toString() { observed.calls++; return Object.values(row)[0]; }, valueOf() { observed.calls++; return Object.values(row)[0]; } } }]],
];

for (const route of ["context", "public", "root"] as const) for (const [name, make] of selectTransportBad) for (const secondary of route === "context" ? [false] : [false, true]) {
  test(`actual PostgresProvider SELECT transport rejects ${route}/${secondary}: ${name}`, async () => {
    const recorder = selectTransportRecorder(route, make), result = await recorder.run(secondary, true);
    selectTransportLocked(result, recorder.events); expect(recorder.observed.calls).toBe(0);
    expect(recorder.counts()).toEqual({ callbacks: route === "context" ? 0 : 1, reserves: 1, roots: 0 });
  });
}

for (const route of ["context", "public", "root"] as const) for (const subclass of [false, true]) for (const flags of [false, true]) {
  test(`actual PostgresProvider SELECT transport accepts native-shaped ${route}/${subclass}/${flags}`, async () => {
    const recorder = selectTransportRecorder(route, row => {
      class NativeArray extends Array<unknown> {}
      const entries: unknown[] = route === "root" ? [] : [row], value = subclass ? new NativeArray(...entries) : entries;
      for (const [name, metadata] of Object.entries({ count: entries.length, affectedRows: null, command: "SELECT", lastInsertRowid: null })) Object.defineProperty(value, name, { value: metadata, writable: flags, configurable: flags, enumerable: flags });
      return value;
    });
    const result = await recorder.run(false, false); expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state.kind).toBe("absent");
    expect(recorder.events.slice(-2)).toEqual(["COMMIT", "release"]); expect(recorder.events).not.toContain("ROLLBACK");
  });
}

for (const route of ["context", "public"] as const) test(`actual PostgresProvider SELECT transport ignores ${route} row prototype`, async () => {
  const recorder = selectTransportRecorder(route, (row, observed) => [Object.assign(Object.create({ get dangerous() { observed.calls++; throw new Error("getter"); } }), row)]);
  const result = await recorder.run(false, false); expect(result.ok).toBe(true); expect(recorder.observed.calls).toBe(0);
});
for (const route of ["context", "public"] as const) test(`actual PostgresProvider SELECT transport permits plain ${route} without metadata`, async () => {
  const recorder = selectTransportRecorder(route, row => [row]); expect((await recorder.run(false, false)).ok).toBe(true);
});
for (const route of ["context", "public", "root"] as const) test(`actual PostgresProvider SELECT transport ignores inherited ${route} metadata`, async () => {
  const recorder = selectTransportRecorder(route, (row, observed) => { class NativeArray extends Array<unknown> { get count() { observed.calls++; throw new Error("getter"); } } return route === "root" ? new NativeArray() : new NativeArray(row); });
  expect((await recorder.run(false, false)).ok).toBe(true); expect(recorder.observed.calls).toBe(0);
});

test("actual PostgresProvider SELECT transport rejects context over hard bound before callback", async () => {
  const recorder = selectTransportRecorder("context", row => [row, { ...row }]), result = await recorder.run(false, false);
  selectTransportLocked(result, recorder.events); expect(recorder.counts()).toEqual({ callbacks: 0, reserves: 1, roots: 0 });
});

type SelectTransportSetup = { context?: unknown; publicRows?: unknown; rootRows?: unknown };
async function selectTransportBoundary(setup: SelectTransportSetup, secondary: boolean, swallow: boolean) {
  const route: SelectTransportRoute = setup.context !== undefined ? "context" : setup.publicRows !== undefined ? "public" : "root";
  const recorder = selectTransportRecorder(route, row => setup.context ?? setup.publicRows ?? setup.rootRows ?? [row]);
  return { recorder, result: await recorder.run(secondary, swallow) };
}
for (const secondary of [false, true]) {
  test(`actual PostgresProvider SELECT public false is absent/${secondary}`, async () => {
    const { recorder, result } = await selectTransportBoundary({ publicRows: [{ public_schema_exists: false }] }, secondary, false);
    expect(result.ok).toBe(true); if (result.ok) { expect(result.value.publicSchemaExists).toBe(false); expect(result.value.state.kind).toBe("absent"); }
  });
  test(`actual PostgresProvider SELECT present root with missing relation closure is DRIFT/${secondary}`, async () => {
    const { recorder, result } = await selectTransportBoundary({ rootRows: [{ relation_oid: "12345" }] }, secondary, false);
    expect(result.ok).toBe(false); if (!result.ok) ownedError(result.error, "ORM_OWNED_STORE_DRIFT"); expect(recorder.events).toContain("ROLLBACK");
  });
  for (const [name, setup] of [["public", { publicRows: [{ public_schema_exists: true }, { public_schema_exists: true }] }], ["root", { rootRows: [{ relation_oid: "12345" }, { relation_oid: "67890" }] }]] as const) test(`actual PostgresProvider SELECT ${name} hard bound/${secondary}`, async () => {
    const { recorder, result } = await selectTransportBoundary(setup, secondary, true); selectTransportLocked(result, recorder.events);
  });
}
test("actual PostgresProvider SELECT noncanonical context is LOCK before callback", async () => {
  const { recorder, result } = await selectTransportBoundary({ context: [{ max_identifier_length: "063" }] }, false, false); selectTransportLocked(result, recorder.events); expect(recorder.counts()).toEqual({ callbacks: 0, reserves: 1, roots: 0 });
});
test("actual PostgresProvider SELECT short context is unsupported before callback", async () => {
  const { recorder, result } = await selectTransportBoundary({ context: [{ max_identifier_length: "62" }] }, false, false); expect(result.ok).toBe(false); if (!result.ok) ownedError(result.error, "ORM_OWNED_STORE_PROVIDER_UNSUPPORTED"); expect(recorder.counts()).toEqual({ callbacks: 0, reserves: 1, roots: 0 });
});

test("actual PostgresProvider Catalogue relation capture keeps malformed native booleans in the LOCK transport lane", async () => {
  const events: string[] = [];
  const provider = new PostgresProvider({ options: {} });
  Object.defineProperty(provider, "sql", { configurable: true, value: {
    close: async () => {}, unsafe: async () => { throw new Error("root pool forbidden"); }, reserve: async () => ({
      unsafe: async (sql: string) => {
        events.push(sql);
        if (sql.includes("max_identifier_length")) return [{ max_identifier_length: "63" }];
        if (sql.startsWith("SELECT EXISTS")) return [{ public_schema_exists: true }];
        if (sql.includes("__osnv_orm_owned_stores_v1")) return [];
        if (sql.includes("SELECT n.nspname AS schema_name")) return [{ schema_name: "public" }];
        if (sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid")) return [{ relation_oid: "101" }];
        if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return [{ oid: "101", namespace_oid: "2200", schema_name: "public", relation_name: "provider_durable_table", relkind: "r", relpersistence: "p", relispartition: "false", relrowsecurity: false, relforcerowsecurity: false, relreplident: "d", tablespace_oid: "0", access_method: "heap", row_type_oid: "0", toast_relation_oid: "0" }];
        return [];
      }, release: async () => { events.push("release"); },
    }),
  } });
  const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing provider capability");
  const result = await admissionResult(() => capability.withOwnedStoreAdmission(undefined, async registry => {
    const secondary = await registry.lockSecondary(durablePlan);
    return secondary.inspectCatalog([{ schema: "public", tablePrefix: "provider_durable_" }]);
  }));
  if (result.ok) throw new Error("malformed relation boolean unexpectedly committed");
  ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(events.some(event => event.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))).toBe(true);
  expect(events).toContain("ROLLBACK"); expect(events).toContain("release"); expect(events).not.toContain("COMMIT");
});

test("actual PostgresProvider Catalogue index recorder reaches default-opclass support before the intentional incomplete frontier", async () => {
  const events: string[] = []; let roots = 0, relationReads = 0, optionReads = 0;
  const provider = new PostgresProvider({ options: {} });
  Object.defineProperty(provider, "sql", { configurable: true, value: { close: async () => {}, unsafe: async () => { roots++; throw new Error("root"); }, reserve: async () => ({ unsafe: async (sql: string) => {
    events.push(sql);
    if (sql.includes("max_identifier_length")) return [{ max_identifier_length: "63" }]; if (sql.startsWith("SELECT EXISTS")) return [{ public_schema_exists: true }]; if (sql.includes("__osnv_orm_owned_stores_v1")) return [];
    if (sql.includes("SELECT n.nspname AS schema_name")) return [{ schema_name: "public" }]; if (sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid") && sql.includes("table_prefix")) return [{ relation_oid: "100" }];
    if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return [relationReads++ === 0 ? { oid:"100",namespace_oid:"2200",schema_name:"public",relation_name:"owned_table",relkind:"r",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"d",tablespace_oid:"0",access_method:"heap",row_type_oid:"101",toast_relation_oid:"0" } : { oid:"200",namespace_oid:"2200",schema_name:"public",relation_name:"owned_table_pkey",relkind:"i",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"n",tablespace_oid:"0",access_method:"btree",row_type_oid:"0",toast_relation_oid:"0" }];
    if (sql.includes("option_count")) return [{ relation_oid:optionReads++ === 0 ? "100":"200",option_count:"0" }];
    if (sql.includes("AS row_type_oid")) return [{ row_type_oid:"101",relation_oid:"100",schema_name:"public",type_name:"owned_table",typtype:"c",array_type_oid:"102",array_relation_oid:"0",array_schema_name:"public",array_type_name:"_owned_table",array_typtype:"b",array_typcategory:"A",array_element_oid:"101",array_array_oid:"0" }];
    if (sql.includes("FROM pg_catalog.pg_index AS i WHERE")) return [{ index_relation_oid:"200" }]; if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class")) return [{ index_relation_oid:"200",table_relation_oid:"100",index_name:"owned_table_pkey",method_oid:"403",method_name:"btree",is_unique:true,is_primary:true,is_exclusion:false,is_immediate:true,is_valid:true,is_ready:true,is_live:true,is_replica_identity:false,nulls_not_distinct:false,key_attribute_count:"1",total_attribute_count:"1",index_expression:null,index_predicate:null,backing_constraint_oid:"300" }];
    if (sql.includes("element.attnum")) return [{ index_relation_oid:"200",element_ordinality:"1",value:"1",resolved_attnum:"1",column_name:"id" }];
    if (sql.includes("i.indcollation")) return [{ index_relation_oid:"200",element_ordinality:"1",value:"0" }]; if (sql.includes("i.indclass")) return [{ index_relation_oid:"200",element_ordinality:"1",value:"400" }]; if (sql.includes("i.indoption")) return [{ index_relation_oid:"200",element_ordinality:"1",value:"0" }];
    if (sql.includes("FROM pg_catalog.pg_opclass AS actual")) return [{ actual_opclass_oid:"400",actual_method_oid:"403",actual_input_type_oid:"20",actual_opfamily_oid:"1976",actual_family_method_oid:"403",default_opclass_oid:"400",default_method_oid:"403",default_input_type_oid:"20",default_is_default:true }];
    return [];
  }, release: async () => { events.push("release"); } }) } });
  const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing capability");
  const result = await admissionResult(() => capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([{ schema:"public",tablePrefix:"owned_" }])));
  if (result.ok) throw new Error("incomplete catalogue unexpectedly succeeded"); ownedError(result.error,"ORM_OWNED_STORE_DRIFT");
  expect(events.some(sql => sql.includes("FROM pg_catalog.pg_opclass AS actual"))).toBe(true); expect(events.some(sql => sql.includes("constraint_type_code"))).toBe(true); expect(events).toContain("ROLLBACK"); expect(events).toContain("release"); expect(events).not.toContain("COMMIT"); expect(roots).toBe(0);
});

for (const [name, expected] of [
    ["key count primitive is LOCK", "ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
    ["key ordinal gap is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["null default candidate is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["two default candidates are DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["actual method mismatch is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["indkey -0 is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["indkey 32768 is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["indkey -32769 is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["indoption -0 is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["indoption 32768 is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["indoption -32769 is DRIFT", "ORM_OWNED_STORE_DRIFT"],
    ["indoption -32768 reaches opclass", "ORM_OWNED_STORE_DRIFT"],
    ["indoption 32767 reaches opclass", "ORM_OWNED_STORE_DRIFT"],
] as const)
    test(`actual PostgresProvider Catalogue index recorder ${name}`, async () => {
        const events: string[] = [];
        let roots = 0;
        const int2 = name.match(/(?:indkey|indoption) (-?[0-9]+)/u)?.[1] ?? "1";
        const provider = new PostgresProvider({ options: {} });
        Object.defineProperty(provider, "sql", { configurable: true, value: { close: async () => { }, unsafe: async () => { roots++; throw new Error("root"); }, reserve: async () => ({ unsafe: async (sql: string) => {
                        events.push(sql);
                        if (sql.includes("max_identifier_length"))
                            return [{ max_identifier_length: "63" }];
                        if (sql.startsWith("SELECT EXISTS"))
                            return [{ public_schema_exists: true }];
                        if (sql.includes("__osnv_orm_owned_stores_v1"))
                            return [];
                        if (sql.includes("SELECT n.nspname AS schema_name"))
                            return [{ schema_name: "public" }];
                        if (sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid") && sql.includes("table_prefix"))
                            return [{ relation_oid: "100" }];
                        if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))
                            return [{ oid: "100", namespace_oid: "2200", schema_name: "public", relation_name: "owned_table", relkind: "r", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "d", tablespace_oid: "0", access_method: "heap", row_type_oid: "101", toast_relation_oid: "0" }];
                        if (sql.includes("option_count"))
                            return [{ relation_oid: "100", option_count: "0" }];
                        if (sql.includes("AS row_type_oid"))
                            return [{ row_type_oid: "101", relation_oid: "100", schema_name: "public", type_name: "owned_table", typtype: "c", array_type_oid: "102", array_relation_oid: "0", array_schema_name: "public", array_type_name: "_owned_table", array_typtype: "b", array_typcategory: "A", array_element_oid: "101", array_array_oid: "0" }];
                        if (sql.includes("FROM pg_catalog.pg_attribute"))
                            return [];
                        if (sql.includes("FROM pg_catalog.pg_index AS i WHERE"))
                            return [{ index_relation_oid: "200" }];
                        if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class"))
                            return [{ index_relation_oid: "200", table_relation_oid: "100", index_name: "owned_table_pkey", method_oid: "403", method_name: "btree", is_unique: true, is_primary: true, is_exclusion: false, is_immediate: true, is_valid: true, is_ready: true, is_live: true, is_replica_identity: false, nulls_not_distinct: false, key_attribute_count: name.includes("key count") ? 1 : "1", total_attribute_count: "1", index_expression: null, index_predicate: null, backing_constraint_oid: "300" }];
                        if (sql.includes("element.attnum"))
                            return [{ index_relation_oid: "200", element_ordinality: name.includes("ordinal gap") ? "2" : "1", value: name.includes("indkey") ? int2 : "1", resolved_attnum: name.includes("indkey") ? int2 : "1", column_name: "id" }];
                        if (sql.includes("i.indcollation"))
                            return [{ index_relation_oid: "200", element_ordinality: "1", value: "0" }];
                        if (sql.includes("i.indclass"))
                            return [{ index_relation_oid: "200", element_ordinality: "1", value: "400" }];
                        if (sql.includes("i.indoption"))
                            return [{ index_relation_oid: "200", element_ordinality: "1", value: name.includes("indoption") ? int2 : "0" }];
                        if (sql.includes("FROM pg_catalog.pg_opclass AS actual")) {
                            const none = name.includes("null default"), two = name.includes("two default"), mismatch = name.includes("method mismatch");
                            const row = { actual_opclass_oid: "400", actual_method_oid: mismatch ? "405" : "403", actual_input_type_oid: "20", actual_opfamily_oid: "1976", actual_family_method_oid: mismatch ? "405" : "403", default_opclass_oid: none ? null : "400", default_method_oid: none ? null : (mismatch ? "405" : "403"), default_input_type_oid: none ? null : "20", default_is_default: none ? null : true };
                            return two ? [row, { ...row, default_opclass_oid: "401" }] : [row];
                        }
                        return [];
                    }, release: async () => { events.push("release"); } }) } });
        const capability = postgresOwnedStoreCapability(provider);
        if (!capability)
            throw new Error("missing");
        const result = await admissionResult(() => capability.withOwnedStoreAdmission(undefined, async (registry) => (await registry.lockSecondary(durablePlan)).inspectCatalog([{ schema: "public", tablePrefix: "owned_" }])));
        if (result.ok)
            throw new Error("unexpected");
        ownedError(result.error, expected);
        expect(events).toContain("ROLLBACK");
        expect(events.filter(x => x === "release")).toHaveLength(1);
        expect(events).not.toContain("COMMIT");
        expect(roots).toBe(0);
        expect(events.some(x => x.includes("constraint_type_code"))).toBe(false);
        if (name.includes("ordinal gap"))
            expect(events.some(x => x.includes("i.indcollation"))).toBe(false);
        if (name.includes("null default") || name.includes("two default") || name.includes("method mismatch"))
            expect(events.some(x => x.includes("FROM pg_catalog.pg_opclass AS actual"))).toBe(true);
        if (name.includes("indkey") || (name.includes("indoption") && !name.includes("reaches opclass")))
            expect(events.some(x => x.includes("FROM pg_catalog.pg_opclass AS actual"))).toBe(false);
        if (name.includes("reaches opclass"))
            expect(events.some(x => x.includes("FROM pg_catalog.pg_opclass AS actual"))).toBe(true);
    });

for (const [name, expected, typeDefaultCollation] of [["joined type null is DRIFT", "ORM_OWNED_STORE_DRIFT", null], ["joined type number is LOCK", "ORM_OWNED_STORE_LOCK_UNAVAILABLE", 1]] as const) test(`actual PostgresProvider Catalogue column recorder ${name}`, async () => {
  const events:string[]=[];let roots=0;const provider=new PostgresProvider({options:{}});Object.defineProperty(provider,"sql",{configurable:true,value:{close:async()=>{},unsafe:async()=>{roots++;throw new Error("root");},reserve:async()=>({unsafe:async(sql:string)=>{events.push(sql);if(sql.includes("max_identifier_length"))return[{max_identifier_length:"63"}];if(sql.startsWith("SELECT EXISTS"))return[{public_schema_exists:true}];if(sql.includes("__osnv_orm_owned_stores_v1"))return[];if(sql.includes("SELECT n.nspname AS schema_name"))return[{schema_name:"public"}];if(sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid")&&sql.includes("table_prefix"))return[{relation_oid:"100"}];if(sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))return[{oid:"100",namespace_oid:"2200",schema_name:"public",relation_name:"owned_table",relkind:"r",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"d",tablespace_oid:"0",access_method:"heap",row_type_oid:"101",toast_relation_oid:"0"}];if(sql.includes("option_count"))return[{relation_oid:"100",option_count:"0"}];if(sql.includes("AS row_type_oid"))return[{row_type_oid:"101",relation_oid:"100",schema_name:"public",type_name:"owned_table",typtype:"c",array_type_oid:"102",array_relation_oid:"0",array_schema_name:"public",array_type_name:"_owned_table",array_typtype:"b",array_typcategory:"A",array_element_oid:"101",array_array_oid:"0"}];if(sql.includes("FROM pg_catalog.pg_attribute"))return[{relation_oid:"100",attnum:"1",column_name:"id",dropped:false,local:true,inheritance_count:"0",physical_type:"bigint",type_oid:"20",not_null:true,default_object_oid:null,default_expression:null,identity_code:"",generated_code:"",collation_oid:"0",type_default_collation_oid:typeDefaultCollation,storage_code:"p",type_default_storage_code:"p",compression_code:"",has_default:false}];return[];},release:async()=>{events.push("release");}})}});const cap=postgresOwnedStoreCapability(provider);if(!cap)throw new Error("missing");const result=await admissionResult(()=>cap.withOwnedStoreAdmission(undefined,async registry=>(await registry.lockSecondary(durablePlan)).inspectCatalog([{schema:"public",tablePrefix:"owned_"}])));if(result.ok)throw new Error("unexpected");ownedError(result.error,expected);expect(events.some(sql=>sql.includes("FROM pg_catalog.pg_attribute"))).toBe(true);expect(events).toContain("ROLLBACK");expect(events.filter(x=>x==="release")).toHaveLength(1);expect(events).not.toContain("COMMIT");expect(roots).toBe(0);});

async function recordConstraintPkVector(attributeNumber: unknown, parentOverrides: Readonly<Partial<Record<"delete_action_code" | "update_action_code" | "match_type_code", unknown>>> = {}): Promise<{ readonly result: Awaited<ReturnType<typeof admissionResult>>; readonly events: readonly string[]; readonly rootCalls: number }> {
  const events: string[] = []; let rootCalls = 0;
  const provider = new PostgresProvider({ options: {} });
  const session = {
    unsafe: async (sql: string) => {
      events.push(sql);
      if (sql.includes("max_identifier_length")) return [{ max_identifier_length: "63" }];
      if (sql.startsWith("SELECT EXISTS")) return [{ public_schema_exists: true }];
      if (sql.includes("__osnv_orm_owned_stores_v1")) return [];
      if (sql.includes("SELECT n.nspname AS schema_name")) return [{ schema_name: "public" }];
      if (sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid") && sql.includes("table_prefix")) return [{ relation_oid: "100" }];
      if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return [{ oid: "100", namespace_oid: "2200", schema_name: "public", relation_name: "owned_table", relkind: "r", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "d", tablespace_oid: "0", access_method: "heap", row_type_oid: "101", toast_relation_oid: "0" }];
      if (sql.includes("option_count")) return [{ relation_oid: "100", option_count: "0" }];
      if (sql.includes("AS row_type_oid")) return [{ row_type_oid: "101", relation_oid: "100", schema_name: "public", type_name: "owned_table", typtype: "c", array_type_oid: "102", array_relation_oid: "0", array_schema_name: "public", array_type_name: "_owned_table", array_typtype: "b", array_typcategory: "A", array_element_oid: "101", array_array_oid: "0" }];
      if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class")) return [];
      if (sql.includes("constraint_type_code")) return [{ constraint_oid: "300", relation_oid: "100", referenced_relation_oid: "0", constraint_name: "owned_table_pkey", constraint_type_code: "p", backing_index_oid: "200", delete_action_code: "a", update_action_code: "a", match_type_code: "s", is_deferrable: false, is_initially_deferred: false, is_validated: true, parent_constraint_oid: "0", inheritance_count: "0", is_no_inherit: false, conkey_count: "1", confkey_count: "0", confdelsetcols_count: "0", conpfeqop_count: "0", conppeqop_count: "0", conffeqop_count: "0", check_definition: null, ...parentOverrides }];
      if (sql.includes("pg_catalog.unnest(c.conkey)")) return [{ request_ordinality: "1", constraint_oid: "300", element_ordinality: "1", attribute_number: attributeNumber, resolved_attribute_number: "1", column_name: "id" }];
      if (sql.includes("pg_catalog.unnest(c.confkey)") || sql.includes("pg_catalog.unnest(c.confdelsetcols)") || sql.includes("pg_catalog.unnest(c.conpfeqop)") || sql.includes("pg_catalog.unnest(c.conppeqop)") || sql.includes("pg_catalog.unnest(c.conffeqop)")) return [];
      if (sql.includes("FROM pg_catalog.pg_attribute")) return [];
      return [];
    },
    release: async () => { events.push("release"); },
  };
  Object.defineProperty(provider, "sql", { configurable: true, value: { close: async () => {}, unsafe: async () => { rootCalls++; throw new Error("root"); }, reserve: async () => session } });
  const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing capability");
  const result = await admissionResult(() => capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([{ schema: "public", tablePrefix: "owned_" }])));
  return { result, events, rootCalls };
}

test("actual PostgresProvider Catalogue PK vector recorder reaches all six vector queries before the incomplete frontier", async () => {
  const { result, events, rootCalls } = await recordConstraintPkVector("1");
  if (result.ok) throw new Error("incomplete catalogue unexpectedly succeeded"); ownedError(result.error, "ORM_OWNED_STORE_DRIFT");
  expect(events.some(sql => sql.includes("constraint_type_code"))).toBe(true);
  for (const native of ["conkey", "confkey", "confdelsetcols", "conpfeqop", "conppeqop", "conffeqop"]) expect(events.some(sql => sql.includes(`pg_catalog.unnest(c.${native})`))).toBe(true);
  expect(rootCalls).toBe(0);
});

test("actual PostgresProvider Catalogue PK vector recorder maps a numeric nonnullable attribute number to LOCK", async () => {
  const { result, events, rootCalls } = await recordConstraintPkVector(1);
  if (result.ok) throw new Error("numeric vector unexpectedly succeeded"); ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(events.some(sql => sql.includes("pg_catalog.unnest(c.conkey)"))).toBe(true);
  for (const native of ["confkey", "confdelsetcols", "conpfeqop", "conppeqop", "conffeqop"]) expect(events.some(sql => sql.includes(`pg_catalog.unnest(c.${native})`))).toBe(false);
  expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(events.filter(event => event === "release")).toHaveLength(1); expect(events).not.toContain("COMMIT"); expect(rootCalls).toBe(0);
});

for (const alias of ["delete_action_code", "update_action_code", "match_type_code"] as const) test(`actual PostgresProvider Catalogue rejects numeric non-FK ${alias} before constraint vectors`, async () => {
  const { result, events, rootCalls } = await recordConstraintPkVector("1", { [alias]: 1 });
  if (result.ok) throw new Error("numeric constraint parent alias unexpectedly succeeded"); ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(events.some(sql => sql.includes("constraint_type_code"))).toBe(true);
  expect(events.some(sql => sql.includes("pg_catalog.unnest(c.conkey)"))).toBe(false);
  expect(events.some(sql => sql.includes("FROM pg_catalog.pg_trigger"))).toBe(false);
  expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(events.filter(event => event === "release")).toHaveLength(1); expect(events).not.toContain("COMMIT"); expect(rootCalls).toBe(0);
});

async function recordForeignKeySupport(options: { readonly targetPkRows?: readonly Record<string, unknown>[]; readonly amopRows?: readonly Record<string, unknown>[]; readonly triggerRows?: readonly Record<string, unknown>[]; readonly ruleRows?: readonly Record<string, unknown>[]; readonly policyRows?: readonly Record<string, unknown>[]; readonly policyRoles?: readonly Record<string, unknown>[]; readonly inheritanceRows?: readonly Record<string, unknown>[] } = {}): Promise<{ readonly result: Awaited<ReturnType<typeof admissionResult>>; readonly events: readonly string[]; readonly rootCalls: number }> {
  const events: string[] = []; let rootCalls = 0;
  const provider = new PostgresProvider({ options: {} });
  const session = { unsafe: async (sql: string) => {
    events.push(sql);
    if (sql.includes("max_identifier_length")) return [{ max_identifier_length: "63" }];
    if (sql.startsWith("SELECT EXISTS")) return [{ public_schema_exists: true }];
    if (sql.includes("__osnv_orm_owned_stores_v1")) return [];
    if (sql.includes("SELECT n.nspname AS schema_name")) return [{ schema_name: "public" }];
    if (sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid") && sql.includes("table_prefix")) return [{ relation_oid: "100" }];
    if (sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")) return [{ oid: "100", namespace_oid: "2200", schema_name: "public", relation_name: "owned_child", relkind: "r", relpersistence: "p", relispartition: false, relrowsecurity: false, relforcerowsecurity: false, relreplident: "d", tablespace_oid: "0", access_method: "heap", row_type_oid: "101", toast_relation_oid: "0" }];
    if (sql.includes("option_count")) return [{ relation_oid: "100", option_count: "0" }];
    if (sql.includes("AS row_type_oid")) return [{ row_type_oid: "101", relation_oid: "100", schema_name: "public", type_name: "owned_child", typtype: "c", array_type_oid: "102", array_relation_oid: "0", array_schema_name: "public", array_type_name: "_owned_child", array_typtype: "b", array_typcategory: "A", array_element_oid: "101", array_array_oid: "0" }];
    if (sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class")) return [];
    if (sql.includes("constraint_type_code")) return [{ constraint_oid: "300", relation_oid: "100", referenced_relation_oid: "110", constraint_name: "owned_child_parent_fkey", constraint_type_code: "f", backing_index_oid: "201", delete_action_code: "a", update_action_code: "a", match_type_code: "s", is_deferrable: false, is_initially_deferred: false, is_validated: true, parent_constraint_oid: "0", inheritance_count: "0", is_no_inherit: true, conkey_count: "2", confkey_count: "2", confdelsetcols_count: "0", conpfeqop_count: "2", conppeqop_count: "2", conffeqop_count: "2", check_definition: null }];
    if (sql.includes("pg_catalog.unnest(c.conkey)")) return [{ request_ordinality: "1", constraint_oid: "300", element_ordinality: "1", attribute_number: "2", resolved_attribute_number: "2", column_name: "parent_b" }, { request_ordinality: "1", constraint_oid: "300", element_ordinality: "2", attribute_number: "3", resolved_attribute_number: "3", column_name: "parent_a" }];
    if (sql.includes("pg_catalog.unnest(c.confkey)")) return [{ request_ordinality: "1", constraint_oid: "300", element_ordinality: "1", attribute_number: "2", resolved_attribute_number: "2", column_name: "b" }, { request_ordinality: "1", constraint_oid: "300", element_ordinality: "2", attribute_number: "1", resolved_attribute_number: "1", column_name: "a" }];
    if (sql.includes("pg_catalog.unnest(c.confdelsetcols)")) return [];
    if (sql.includes("pg_catalog.unnest(c.conpfeqop)") || sql.includes("pg_catalog.unnest(c.conppeqop)") || sql.includes("pg_catalog.unnest(c.conffeqop)")) return [{ request_ordinality: "1", constraint_oid: "300", element_ordinality: "1", operator_oid: "96" }, { request_ordinality: "1", constraint_oid: "300", element_ordinality: "2", operator_oid: "97" }];
    if (sql.includes("fk_input AS")) return [{ request_ordinality: "1", fk_oid: "300", fk_position: "1", source_attnum: "2", referenced_attnum: "2", target_pk_constraint_oid: "301", target_pk_key_count: "2", target_pk_position: "2", target_index_oid: "201", target_index_key_count: "2", target_index_position: "2", actual_opclass_oid: "401", opfamily_oid: "1977", opclass_method_oid: "403", opfamily_method_oid: "403", index_method_oid: "403", referenced_type_oid: "23" }, { request_ordinality: "1", fk_oid: "300", fk_position: "2", source_attnum: "3", referenced_attnum: "1", target_pk_constraint_oid: "301", target_pk_key_count: "2", target_pk_position: "1", target_index_oid: "201", target_index_key_count: "2", target_index_position: "1", actual_opclass_oid: "400", opfamily_oid: "1976", opclass_method_oid: "403", opfamily_method_oid: "403", index_method_oid: "403", referenced_type_oid: "20" }];
    if (sql.includes("target_pk_constraint_oid")) return options.targetPkRows ?? [{ request_ordinality: "1", fk_oid: "300", referenced_relation_oid: "110", referenced_supporting_index_oid: "201", target_pk_constraint_oid: "301", target_pk_backing_index_oid: "201" }];
    if (sql.includes("amop_oid")) return options.amopRows ?? [{ request_ordinality: "1", requested_family_oid: "1977", requested_method_oid: "403", requested_type_oid: "23", amop_oid: "1001", amop_family_oid: "1977", amop_method_oid: "403", amop_left_type_oid: "23", amop_right_type_oid: "23", amop_purpose: "s", amop_strategy: "3", operator_oid: "97", operator_left_type_oid: "23", operator_right_type_oid: "23" }, { request_ordinality: "2", requested_family_oid: "1976", requested_method_oid: "403", requested_type_oid: "20", amop_oid: "1000", amop_family_oid: "1976", amop_method_oid: "403", amop_left_type_oid: "20", amop_right_type_oid: "20", amop_purpose: "s", amop_strategy: "3", operator_oid: "96", operator_left_type_oid: "20", operator_right_type_oid: "20" }];
    if (sql.includes("FROM pg_catalog.pg_trigger")) return options.triggerRows ?? [];
    if (sql.includes("FROM pg_catalog.pg_rewrite")) return options.ruleRows ?? [];
    if (sql.includes("FROM pg_catalog.pg_policy") && sql.includes("role_count")) return options.policyRows ?? [];
    if (sql.includes("pg_catalog.unnest(p.polroles)")) return options.policyRoles ?? [];
    if (sql.includes("FROM pg_catalog.pg_inherits")) return options.inheritanceRows ?? [];
    if (sql.includes("FROM pg_catalog.pg_attribute")) return [];
    return [];
  }, release: async () => { events.push("release"); } };
  Object.defineProperty(provider, "sql", { configurable: true, value: { close: async () => {}, unsafe: async () => { rootCalls++; throw new Error("root"); }, reserve: async () => session } });
  const capability = postgresOwnedStoreCapability(provider); if (!capability) throw new Error("missing capability");
  const result = await admissionResult(() => capability.withOwnedStoreAdmission(undefined, async registry => (await registry.lockSecondary(durablePlan)).inspectCatalog([{ schema: "public", tablePrefix: "owned_" }])));
  return { result, events, rootCalls };
}

test("actual PostgresProvider Catalogue FK recorder preserves reversed composite FK order through target PK, index family and amop", async () => {
  const { result, events, rootCalls } = await recordForeignKeySupport();
  if (result.ok) throw new Error("incomplete catalogue unexpectedly succeeded"); ownedError(result.error, "ORM_OWNED_STORE_DRIFT");
  expect(events.some(sql => sql.includes("target_pk_constraint_oid"))).toBe(true);
  expect(events.some(sql => sql.includes("fk_input AS"))).toBe(true);
  expect(events.some(sql => sql.includes("amop_oid"))).toBe(true);
  expect(rootCalls).toBe(0);
});

for (const [name, rows, expected] of [
  ["missing target PK", [{ request_ordinality: "1", fk_oid: "300", referenced_relation_oid: "110", referenced_supporting_index_oid: "201", target_pk_constraint_oid: null, target_pk_backing_index_oid: null }], "ORM_OWNED_STORE_DRIFT"],
  ["ambiguous target PK", [{ request_ordinality: "1", fk_oid: "300", referenced_relation_oid: "110", referenced_supporting_index_oid: "201", target_pk_constraint_oid: "301", target_pk_backing_index_oid: "201" }, { request_ordinality: "1", fk_oid: "300", referenced_relation_oid: "110", referenced_supporting_index_oid: "201", target_pk_constraint_oid: "302", target_pk_backing_index_oid: "201" }], "ORM_OWNED_STORE_DRIFT"],
  ["numeric target PK field", [{ request_ordinality: 1, fk_oid: "300", referenced_relation_oid: "110", referenced_supporting_index_oid: "201", target_pk_constraint_oid: "301", target_pk_backing_index_oid: "201" }], "ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
] as const) test(`actual PostgresProvider Catalogue FK recorder rejects ${name}`, async () => {
  const { result, events, rootCalls } = await recordForeignKeySupport({ targetPkRows: rows });
  if (result.ok) throw new Error("unexpected FK outcome"); ownedError(result.error, expected);
  expect(events.some(sql => sql.includes("target_pk_constraint_oid"))).toBe(true); expect(events.some(sql => sql.includes("fk_input AS"))).toBe(false); expect(events.some(sql => sql.includes("amop_oid"))).toBe(false); expect(events.some(sql => sql.includes("pg_catalog.pg_trigger"))).toBe(false);
  expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(events.filter(event => event === "release")).toHaveLength(1); expect(events).not.toContain("COMMIT"); expect(rootCalls).toBe(0);
});

test("actual PostgresProvider Catalogue FK recorder rejects missing amop before trigger capture", async () => {
  const { result, events, rootCalls } = await recordForeignKeySupport({ amopRows: [] });
  if (result.ok) throw new Error("unexpected FK outcome"); ownedError(result.error, "ORM_OWNED_STORE_DRIFT");
  expect(events.some(sql => sql.includes("amop_oid"))).toBe(true); expect(events.some(sql => sql.includes("pg_catalog.pg_trigger"))).toBe(false); expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(events.filter(event => event === "release")).toHaveLength(1); expect(events).not.toContain("COMMIT"); expect(rootCalls).toBe(0);
});

test("actual PostgresProvider Catalogue FK recorder rejects nullable missing amop candidate before trigger capture", async () => {
  const row = { request_ordinality: "1", requested_family_oid: "1977", requested_method_oid: "403", requested_type_oid: "23", amop_oid: null, amop_family_oid: null, amop_method_oid: null, amop_left_type_oid: null, amop_right_type_oid: null, amop_purpose: null, amop_strategy: null, operator_oid: null, operator_left_type_oid: null, operator_right_type_oid: null };
  const { result, events } = await recordForeignKeySupport({ amopRows: [row] });
  if (result.ok) throw new Error("unexpected FK outcome"); ownedError(result.error, "ORM_OWNED_STORE_DRIFT"); expect(events.some(sql => sql.includes("pg_catalog.pg_trigger"))).toBe(false);
});

test("actual PostgresProvider Catalogue FK recorder maps numeric amop request ordinal to LOCK before trigger capture", async () => {
  const row = { request_ordinality: 1, requested_family_oid: "1977", requested_method_oid: "403", requested_type_oid: "23", amop_oid: "1001", amop_family_oid: "1977", amop_method_oid: "403", amop_left_type_oid: "23", amop_right_type_oid: "23", amop_purpose: "s", amop_strategy: "3", operator_oid: "97", operator_left_type_oid: "23", operator_right_type_oid: "23" };
  const { result, events, rootCalls } = await recordForeignKeySupport({ amopRows: [row] });
  if (result.ok) throw new Error("unexpected FK outcome"); ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(events.some(sql => sql.includes("amop_oid"))).toBe(true); expect(events.some(sql => sql.includes("pg_catalog.pg_trigger"))).toBe(false); expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(events.filter(event => event === "release")).toHaveLength(1); expect(events).not.toContain("COMMIT"); expect(rootCalls).toBe(0);
});

test("actual PostgresProvider Catalogue FK recorder rejects ambiguous amop before trigger capture", async () => {
  const row = { request_ordinality: "1", requested_family_oid: "1977", requested_method_oid: "403", requested_type_oid: "23", amop_oid: "1001", amop_family_oid: "1977", amop_method_oid: "403", amop_left_type_oid: "23", amop_right_type_oid: "23", amop_purpose: "s", amop_strategy: "3", operator_oid: "97", operator_left_type_oid: "23", operator_right_type_oid: "23" };
  const { result, events } = await recordForeignKeySupport({ amopRows: [row, row] });
  if (result.ok) throw new Error("unexpected FK outcome"); ownedError(result.error, "ORM_OWNED_STORE_DRIFT"); expect(events.some(sql => sql.includes("pg_catalog.pg_trigger"))).toBe(false);
});

const validTrigger = { trigger_oid: "500", relation_oid: "100", trigger_name: "owned_trigger", is_internal: true, constraint_oid: "0", parent_trigger_oid: "0", enabled_code: "O", function_oid: "501", function_schema: "public", function_name: "owned_fn", type_bits: "5" };
for (const [name, rows, expected] of [
  ["internal primitive", [{ ...validTrigger, is_internal: "true" }], "ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
  ["function name primitive", [{ ...validTrigger, function_name: 1 }], "ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
  ["missing joined function", [{ ...validTrigger, function_schema: null, function_name: null }], "ORM_OWNED_STORE_DRIFT"],
  ["zero type bits", [{ ...validTrigger, type_bits: "0" }], "ORM_OWNED_STORE_DRIFT"],
  ["out of range type bits", [{ ...validTrigger, type_bits: "32768" }], "ORM_OWNED_STORE_DRIFT"],
] as const) test(`actual PostgresProvider Catalogue trigger recorder rejects ${name}`, async () => {
  const { result, events, rootCalls } = await recordForeignKeySupport({ triggerRows: rows });
  if (result.ok) throw new Error("unexpected trigger outcome"); ownedError(result.error, expected); expect(events.some(sql => sql.includes("pg_catalog.pg_trigger"))).toBe(true); expect(events.some(sql => sql.includes("pg_catalog.pg_rewrite"))).toBe(false); expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(events.filter(event => event === "release")).toHaveLength(1); expect(events).not.toContain("COMMIT"); expect(rootCalls).toBe(0);
});

test("actual PostgresProvider Catalogue trigger recorder admits bounded positive type bits before the intentional frontier", async () => {
  const { result, events } = await recordForeignKeySupport({ triggerRows: [validTrigger] });
  if (result.ok) throw new Error("incomplete catalogue unexpectedly succeeded"); ownedError(result.error, "ORM_OWNED_STORE_DRIFT"); expect(events.some(sql => sql.includes("pg_catalog.pg_trigger"))).toBe(true); expect(events.some(sql => sql.includes("pg_catalog.pg_rewrite"))).toBe(true);
});

const validRule = { rule_oid: "510", relation_oid: "100", rule_name: "r", event_code: "1", enabled_code: "O", is_instead: false };
const validPolicy = { policy_oid: "511", relation_oid: "100", policy_name: "p", permissive: true, command_code: "r", using_expression: null, check_expression: null, role_count: "1" };
const validRole = { request_ordinality: "1", policy_oid: "511", element_ordinality: "1", role_oid: "0" };
const validInheritance = { child_relation_oid: "100", parent_relation_oid: "110", sequence: "1" };
const validCatalogueTail = { triggerRows: [validTrigger], ruleRows: [validRule], policyRows: [validPolicy], policyRoles: [validRole], inheritanceRows: [validInheritance] };

test("actual PostgresProvider Catalogue rule policy inheritance recorder reaches every family before the frontier", async () => {
  const { result, events, rootCalls } = await recordForeignKeySupport(validCatalogueTail);
  if (result.ok) throw new Error("incomplete catalogue unexpectedly succeeded"); ownedError(result.error, "ORM_OWNED_STORE_DRIFT"); for (const marker of ["pg_catalog.pg_trigger", "pg_catalog.pg_rewrite", "pg_catalog.pg_policy", "pg_catalog.unnest(p.polroles)", "pg_catalog.pg_inherits"]) expect(events.some(sql => sql.includes(marker))).toBe(true); expect(rootCalls).toBe(0);
});

for (const [name, options, expected, absent] of [
  ["rule boolean primitive", { ...validCatalogueTail, ruleRows: [{ ...validRule, is_instead: 0 }] }, "ORM_OWNED_STORE_LOCK_UNAVAILABLE", "pg_catalog.pg_policy"],
  ["policy boolean primitive", { ...validCatalogueTail, policyRows: [{ ...validPolicy, permissive: 0 }] }, "ORM_OWNED_STORE_LOCK_UNAVAILABLE", "pg_catalog.unnest(p.polroles)"],
  ["policy role ordinal gap", { ...validCatalogueTail, policyRoles: [{ ...validRole, element_ordinality: "2" }] }, "ORM_OWNED_STORE_DRIFT", "pg_catalog.pg_inherits"],
  ["policy role noncanonical ordinal", { ...validCatalogueTail, policyRoles: [{ ...validRole, element_ordinality: "01" }] }, "ORM_OWNED_STORE_DRIFT", "pg_catalog.pg_inherits"],
  ["policy role primitive", { ...validCatalogueTail, policyRoles: [{ ...validRole, role_oid: 0 }] }, "ORM_OWNED_STORE_LOCK_UNAVAILABLE", "pg_catalog.pg_inherits"],
  ["inheritance sequence primitive", { ...validCatalogueTail, inheritanceRows: [{ ...validInheritance, sequence: 1 }] }, "ORM_OWNED_STORE_LOCK_UNAVAILABLE", "next-sequence-phase"],
] as const) test(`actual PostgresProvider Catalogue rejects ${name}`, async () => {
  const { result, events, rootCalls } = await recordForeignKeySupport(options);
  if (result.ok) throw new Error("unexpected catalogue outcome"); ownedError(result.error, expected); if (absent !== "next-sequence-phase") expect(events.some(sql => sql.includes(absent))).toBe(false); expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(events.filter(event => event === "release")).toHaveLength(1); expect(events).not.toContain("COMMIT"); expect(rootCalls).toBe(0);
});

async function recordDeclaredToast(kind: "t" | "r" | "missing" = "t"): Promise<{ readonly result: Awaited<ReturnType<typeof admissionResult>>; readonly events: readonly string[]; readonly rootCalls: number }> {
  const events:string[]=[];let rootCalls=0,relations=0,options=0;const provider=new PostgresProvider({options:{}});const session={unsafe:async(sql:string)=>{events.push(sql);if(sql.includes("max_identifier_length"))return[{max_identifier_length:"63"}];if(sql.startsWith("SELECT EXISTS"))return[{public_schema_exists:true}];if(sql.includes("__osnv_orm_owned_stores_v1"))return[];if(sql.includes("SELECT n.nspname AS schema_name"))return[{schema_name:"public"}];if(sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid")&&sql.includes("table_prefix"))return[{relation_oid:"100"}];if(sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")){relations++;if(relations===1)return[{oid:"100",namespace_oid:"2200",schema_name:"public",relation_name:"owned_table",relkind:"r",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"d",tablespace_oid:"0",access_method:"heap",row_type_oid:"101",toast_relation_oid:"120"}];if(kind==="missing")return[];return[{oid:"120",namespace_oid:"99",schema_name:"pg_toast",relation_name:"pg_toast_100",relkind:kind,relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"n",tablespace_oid:"0",access_method:"heap",row_type_oid:"0",toast_relation_oid:"0"}];}if(sql.includes("option_count"))return[{relation_oid:options++===0?"100":"120",option_count:"0"}];if(sql.includes("AS row_type_oid"))return[{row_type_oid:"101",relation_oid:"100",schema_name:"public",type_name:"owned_table",typtype:"c",array_type_oid:"102",array_relation_oid:"0",array_schema_name:"public",array_type_name:"_owned_table",array_typtype:"b",array_typcategory:"A",array_element_oid:"101",array_array_oid:"0"}];if(sql.includes("FROM pg_catalog.pg_attribute"))return[{relation_oid:"100",attnum:"1",column_name:"id",dropped:false,local:true,inheritance_count:"0",physical_type:"bigint",type_oid:"20",not_null:true,default_object_oid:null,default_expression:null,identity_code:"",generated_code:"",collation_oid:"0",type_default_collation_oid:"0",storage_code:"p",type_default_storage_code:"p",compression_code:"",has_default:false}];return[];},release:async()=>{events.push("release");}};Object.defineProperty(provider,"sql",{configurable:true,value:{close:async()=>{},unsafe:async()=>{rootCalls++;throw new Error("root");},reserve:async()=>session}});const capability=postgresOwnedStoreCapability(provider);if(!capability)throw new Error("missing capability");const result=await admissionResult(()=>capability.withOwnedStoreAdmission(undefined,async registry=>(await registry.lockSecondary(durablePlan)).inspectCatalog([{schema:"public",tablePrefix:"owned_"}])));return{result,events,rootCalls};
}

test("actual PostgresProvider Catalogue reads declared TOAST relation without guessing its name",async()=>{const {result,events,rootCalls}=await recordDeclaredToast();if(result.ok)throw new Error("incomplete catalogue unexpectedly succeeded");ownedError(result.error,"ORM_OWNED_STORE_DRIFT");expect(events.filter(sql=>sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))).toHaveLength(2);expect(events.some(sql=>sql.includes("FROM pg_catalog.pg_attribute"))).toBe(true);expect(events.filter(event=>event==="ROLLBACK")).toHaveLength(1);expect(events.filter(event=>event==="release")).toHaveLength(1);expect(events).not.toContain("COMMIT");expect(rootCalls).toBe(0);});
for(const [name,kind] of [["missing","missing"],["wrong kind","r"]] as const)test(`actual PostgresProvider Catalogue rejects ${name} declared TOAST relation`,async()=>{const {result,events,rootCalls}=await recordDeclaredToast(kind);if(result.ok)throw new Error("unexpected TOAST outcome");ownedError(result.error,"ORM_OWNED_STORE_DRIFT");expect(events.some(sql=>sql.includes("FROM pg_catalog.pg_attribute"))).toBe(false);expect(events.filter(event=>event==="ROLLBACK")).toHaveLength(1);expect(events.filter(event=>event==="release")).toHaveLength(1);expect(events).not.toContain("COMMIT");expect(rootCalls).toBe(0);});

async function recordIdentitySequence(options: { readonly ownershipRows?: readonly Record<string, unknown>[]; readonly relation?: "missing" | "wrong-kind" } = {}): Promise<{ readonly result: Awaited<ReturnType<typeof admissionResult>>; readonly events: readonly string[]; readonly rootCalls: number }> {
  const events:string[]=[];let rootCalls=0,relationReads=0,optionReads=0;const validOwnership={dependent_class_oid:"555",sequence_oid:"110",dependent_sub_id:"0",referenced_class_oid:"555",owner_relation_oid:"100",owner_attnum:"1",dependency_type:"i"};const provider=new PostgresProvider({options:{}});const session={unsafe:async(sql:string)=>{events.push(sql);if(sql.includes("max_identifier_length"))return[{max_identifier_length:"63"}];if(sql.startsWith("SELECT EXISTS"))return[{public_schema_exists:true}];if(sql.includes("__osnv_orm_owned_stores_v1"))return[];if(sql.includes("SELECT n.nspname AS schema_name"))return[{schema_name:"public"}];if(sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid")&&sql.includes("table_prefix"))return[{relation_oid:"100"}];if(sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid")){relationReads++;if(relationReads===1)return[{oid:"100",namespace_oid:"2200",schema_name:"public",relation_name:"owned_table",relkind:"r",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"d",tablespace_oid:"0",access_method:"heap",row_type_oid:"101",toast_relation_oid:"0"}];if(options.relation==="missing")return[];return[{oid:"110",namespace_oid:"2200",schema_name:"public",relation_name:"not_owned_prefix_sequence",relkind:options.relation==="wrong-kind"?"r":"S",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"n",tablespace_oid:"0",access_method:null,row_type_oid:"0",toast_relation_oid:"0"}];}if(sql.includes("option_count")){optionReads++;return[{relation_oid:optionReads===1?"100":"110",option_count:"0"}];}if(sql.includes("AS row_type_oid"))return[{row_type_oid:"101",relation_oid:"100",schema_name:"public",type_name:"owned_table",typtype:"c",array_type_oid:"102",array_relation_oid:"0",array_schema_name:"public",array_type_name:"_owned_table",array_typtype:"b",array_typcategory:"A",array_element_oid:"101",array_array_oid:"0"}];if(sql.includes("FROM pg_catalog.pg_attribute")&&!sql.includes("FROM pg_catalog.pg_depend"))return[{relation_oid:"100",attnum:"1",column_name:"id",dropped:false,local:true,inheritance_count:"0",physical_type:"bigint",type_oid:"20",not_null:true,default_object_oid:null,default_expression:null,identity_code:"a",generated_code:"",collation_oid:"0",type_default_collation_oid:"0",storage_code:"p",type_default_storage_code:"p",compression_code:"",has_default:false}];if(sql.includes("FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class"))return[];if(sql.includes("catalog_class_oid"))return[{catalog_class_oid:"555"}];if(sql.includes("FROM pg_catalog.pg_depend"))return options.ownershipRows??[validOwnership];if(sql.includes("pg_catalog.pg_sequence"))return[{relation_oid:"110",sequence_type_oid:"20",resolved_type_oid:"20",type_schema:"pg_catalog",type_name:"int8",start_value:"1",increment_value:"1",minimum_value:"1",maximum_value:"9223372036854775807",cache_value:"1",cycle:false}];return[];},release:async()=>{events.push("release");}};Object.defineProperty(provider,"sql",{configurable:true,value:{close:async()=>{},unsafe:async()=>{rootCalls++;throw new Error("root");},reserve:async()=>session}});const capability=postgresOwnedStoreCapability(provider);if(!capability)throw new Error("missing capability");const result=await admissionResult(()=>capability.withOwnedStoreAdmission(undefined,async registry=>(await registry.lockSecondary(durablePlan)).inspectCatalog([{schema:"public",tablePrefix:"owned_"}])));return{result,events,rootCalls};
}

test("actual PostgresProvider Catalogue identity sequence discovery reads an unprefixed owned sequence",async()=>{const {result,events,rootCalls}=await recordIdentitySequence();if(result.ok)throw new Error("incomplete catalogue unexpectedly succeeded");ownedError(result.error,"ORM_OWNED_STORE_DRIFT");expect(events.some(sql=>sql.includes("catalog_class_oid"))).toBe(true);expect(events.some(sql=>sql.includes("FROM pg_catalog.pg_depend"))).toBe(true);expect(events.filter(sql=>sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))).toHaveLength(2);expect(events.some(sql=>sql.includes("pg_catalog.pg_sequence"))).toBe(true);expect(events.filter(event=>event==="ROLLBACK")).toHaveLength(1);expect(events.filter(event=>event==="release")).toHaveLength(1);expect(events).not.toContain("COMMIT");expect(rootCalls).toBe(0);});

for(const [name,options,expected] of [
  ["missing ownership",{ownershipRows:[]},"ORM_OWNED_STORE_DRIFT"],
  ["duplicate ownership",{ownershipRows:[{dependent_class_oid:"555",sequence_oid:"110",dependent_sub_id:"0",referenced_class_oid:"555",owner_relation_oid:"100",owner_attnum:"1",dependency_type:"i"},{dependent_class_oid:"555",sequence_oid:"110",dependent_sub_id:"0",referenced_class_oid:"555",owner_relation_oid:"100",owner_attnum:"1",dependency_type:"i"}]},"ORM_OWNED_STORE_DRIFT"],
  ["wrong ownership class",{ownershipRows:[{dependent_class_oid:"556",sequence_oid:"110",dependent_sub_id:"0",referenced_class_oid:"555",owner_relation_oid:"100",owner_attnum:"1",dependency_type:"i"}]},"ORM_OWNED_STORE_DRIFT"],
  ["numeric ownership attnum",{ownershipRows:[{dependent_class_oid:"555",sequence_oid:"110",dependent_sub_id:"0",referenced_class_oid:"555",owner_relation_oid:"100",owner_attnum:1,dependency_type:"i"}]},"ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
  ["missing sequence relation",{relation:"missing"},"ORM_OWNED_STORE_DRIFT"],
  ["wrong kind sequence relation",{relation:"wrong-kind"},"ORM_OWNED_STORE_DRIFT"],
] as const)test(`actual PostgresProvider Catalogue identity sequence rejects ${name}`,async()=>{const {result,events,rootCalls}=await recordIdentitySequence(options);if(result.ok)throw new Error("unexpected identity outcome");ownedError(result.error,expected);expect(events.some(sql=>sql.includes("FROM pg_catalog.pg_depend"))).toBe(true);expect(events.some(sql=>sql.includes("pg_catalog.pg_sequence"))).toBe(false);expect(events.filter(event=>event==="ROLLBACK")).toHaveLength(1);expect(events.filter(event=>event==="release")).toHaveLength(1);expect(events).not.toContain("COMMIT");expect(rootCalls).toBe(0);});

async function recordRootDiscoveryRows(rows: unknown): Promise<{ readonly result: Awaited<ReturnType<typeof admissionResult>>; readonly events: readonly string[]; readonly rootCalls: number }> {
  const events:string[]=[];let rootCalls=0;const provider=new PostgresProvider({options:{}});const session={unsafe:async(sql:string)=>{events.push(sql);if(sql==="BEGIN"||sql==="ROLLBACK"||sql==="COMMIT"||sql.startsWith("SET LOCAL search_path")||sql.includes("pg_catalog.pg_advisory_xact_lock"))return[];if(sql.includes("max_identifier_length"))return[{max_identifier_length:"63"}];if(sql.startsWith("SELECT EXISTS"))return[{public_schema_exists:true}];if(sql.includes("__osnv_orm_owned_stores_v1"))return[];if(sql.includes("SELECT n.nspname AS schema_name"))return[{schema_name:"public"}];if(sql.includes("pg_catalog.left(c.relname"))return rows;throw new Error("ReadRelations must not be reached");},release:async()=>{events.push("release");}};Object.defineProperty(provider,"sql",{configurable:true,value:{close:async()=>{},unsafe:async()=>{rootCalls++;throw new Error("root");},reserve:async()=>session}});const capability=postgresOwnedStoreCapability(provider);if(!capability)throw new Error("missing capability");const result=await admissionResult(()=>capability.withOwnedStoreAdmission(undefined,async registry=>(await registry.lockSecondary(durablePlan)).inspectCatalog([{schema:"public",tablePrefix:"owned_"}])));return{result,events,rootCalls};
}

for(const [name,rows,expected] of [
  ["zero OID",[{relation_oid:"0"}],"ORM_OWNED_STORE_DRIFT"],
  ["noncanonical OID",[{relation_oid:"01"}],"ORM_OWNED_STORE_DRIFT"],
  ["signed OID",[{relation_oid:"+1"}],"ORM_OWNED_STORE_DRIFT"],
  ["negative OID",[{relation_oid:"-1"}],"ORM_OWNED_STORE_DRIFT"],
  ["whitespace OID",[{relation_oid:" 1"}],"ORM_OWNED_STORE_DRIFT"],
  ["delimiter OID",[{relation_oid:"1,2"}],"ORM_OWNED_STORE_DRIFT"],
  ["braced OID",[{relation_oid:"{1}"}],"ORM_OWNED_STORE_DRIFT"],
  ["quoted OID",[{relation_oid:"'1'"}],"ORM_OWNED_STORE_DRIFT"],
  ["backslash OID",[{relation_oid:"\\1"}],"ORM_OWNED_STORE_DRIFT"],
  ["empty OID",[{relation_oid:""}],"ORM_OWNED_STORE_DRIFT"],
  ["overflow OID",[{relation_oid:"4294967296"}],"ORM_OWNED_STORE_DRIFT"],
  ["numeric OID",[{relation_oid:100}],"ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
  ["sentinel numeric primitive",Array.from({length:65537},(_,index)=>({relation_oid:index===65536?100:"100"})),"ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
  ["sentinel all-string rows",Array.from({length:65537},()=>({relation_oid:"100"})),"ORM_OWNED_STORE_DRIFT"],
  ["over hard bound",Array.from({length:65538},()=>({relation_oid:"100"})),"ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
] as const)test(`actual PostgresProvider Catalogue root discovery rejects ${name}`,async()=>{const {result,events,rootCalls}=await recordRootDiscoveryRows(rows);if(result.ok)throw new Error("unexpected root discovery outcome");ownedError(result.error,expected);expect(events.some(sql=>sql.includes("pg_catalog.left(c.relname"))).toBe(true);expect(events.some(sql=>sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))).toBe(false);expect(events.filter(event=>event==="ROLLBACK")).toHaveLength(1);expect(events.filter(event=>event==="release")).toHaveLength(1);expect(events).not.toContain("COMMIT");expect(rootCalls).toBe(0);});

test("actual PostgresProvider Catalogue root discovery rejects coercible OID without coercion", async () => {
  let calls = 0;
  const coercible = {
    toString: () => { calls++; return "100"; },
    valueOf: () => { calls++; return 100; },
    [Symbol.toPrimitive]: () => { calls++; return "100"; },
  };
  const { result, events, rootCalls } = await recordRootDiscoveryRows([{ relation_oid: coercible }]);
  if (result.ok) throw new Error("coercible OID unexpectedly succeeded");
  ownedError(result.error, "ORM_OWNED_STORE_LOCK_UNAVAILABLE");
  expect(calls).toBe(0); expect(events.some(sql => sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))).toBe(false);
  expect(events.filter(event => event === "ROLLBACK")).toHaveLength(1); expect(events.filter(event => event === "release")).toHaveLength(1); expect(events).not.toContain("COMMIT"); expect(rootCalls).toBe(0);
});

async function recordSequenceRoot(maximum: unknown, optionalRows?: readonly Record<string, unknown>[]): Promise<{ readonly result: Awaited<ReturnType<typeof admissionResult>>; readonly events: readonly string[]; readonly rootCalls: number }> {
  const events:string[]=[];let rootCalls=0;const provider=new PostgresProvider({options:{}});const session={unsafe:async(sql:string)=>{events.push(sql);if(sql.includes("max_identifier_length"))return[{max_identifier_length:"63"}];if(sql.startsWith("SELECT EXISTS"))return[{public_schema_exists:true}];if(sql.includes("__osnv_orm_owned_stores_v1"))return[];if(sql.includes("SELECT n.nspname AS schema_name"))return[{schema_name:"public"}];if(sql.includes("SELECT c.oid::pg_catalog.text AS relation_oid")&&sql.includes("table_prefix"))return[{relation_oid:"100"}];if(sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))return[{oid:"100",namespace_oid:"2200",schema_name:"public",relation_name:"owned_seq",relkind:"S",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"n",tablespace_oid:"0",access_method:null,row_type_oid:"0",toast_relation_oid:"0"}];if(sql.includes("option_count"))return[{relation_oid:"100",option_count:"0"}];if(sql.includes("pg_catalog.pg_sequence"))return optionalRows??[{relation_oid:"100",sequence_type_oid:"20",resolved_type_oid:"20",type_schema:"pg_catalog",type_name:"int8",start_value:"1",increment_value:"1",minimum_value:"1",maximum_value:maximum,cache_value:"1",cycle:false}];return[];},release:async()=>{events.push("release");}};Object.defineProperty(provider,"sql",{configurable:true,value:{close:async()=>{},unsafe:async()=>{rootCalls++;throw new Error("root");},reserve:async()=>session}});const capability=postgresOwnedStoreCapability(provider);if(!capability)throw new Error("missing capability");const result=await admissionResult(()=>capability.withOwnedStoreAdmission(undefined,async registry=>(await registry.lockSecondary(durablePlan)).inspectCatalog([{schema:"public",tablePrefix:"owned_"}])));return{result,events,rootCalls};
}

test("actual PostgresProvider Catalogue sequence root recorder reaches sequence facts before the frontier",async()=>{const {result,events,rootCalls}=await recordSequenceRoot("9223372036854775807");if(result.ok)throw new Error("incomplete catalogue unexpectedly succeeded");ownedError(result.error,"ORM_OWNED_STORE_DRIFT");expect(events.some(sql=>sql.includes("pg_catalog.pg_sequence"))).toBe(true);expect(rootCalls).toBe(0);});

test("actual PostgresProvider projects an empty raw Catalogue with its minimal class set",async()=>{const events:string[]=[];let rootCalls=0;const names=["pg_class","pg_type","pg_constraint","pg_proc","pg_rewrite","pg_namespace","pg_attrdef","pg_trigger","pg_policy"];const provider=new PostgresProvider({options:{}});const session={unsafe:async(sql:string)=>{events.push(sql);if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL search_path")||sql.includes("pg_catalog.pg_advisory_xact_lock"))return[];if(sql.includes("max_identifier_length"))return[{max_identifier_length:"63"}];if(sql.startsWith("SELECT EXISTS"))return[{public_schema_exists:true}];if(sql.includes("__osnv_orm_owned_stores_v1"))return[];if(sql.includes("AS class_oid"))return names.map((name,index)=>({class_oid:String(index+1),class_schema:"pg_catalog",class_name:name}));if(sql.includes("pg_catalog.pg_depend"))throw new Error("empty Catalogue must not read dependencies");throw new Error(`unexpected SQL: ${sql}`);},release:async()=>{events.push("release");}};Object.defineProperty(provider,"sql",{configurable:true,value:{close:async()=>{},unsafe:async()=>{rootCalls++;throw new Error("root");},reserve:async()=>session}});const capability=postgresOwnedStoreCapability(provider);if(!capability)throw new Error("missing capability");const snapshot=await capability.withOwnedStoreAdmission(undefined,async registry=>(await registry.lockSecondary(durablePlan)).inspectCatalog([]));expect(snapshot.contract).toBe("osnv.orm-owned-store-catalog-snapshot/v1");expect(snapshot.requestedScopes).toEqual([]);expect(snapshot.existingSchemas).toEqual([]);expect(snapshot.catalogClasses.map(value=>value.name)).toEqual(["pg_class","pg_type","pg_constraint","pg_namespace","pg_attrdef"]);for(const value of [snapshot,snapshot.requestedScopes,snapshot.existingSchemas,snapshot.catalogClasses,snapshot.dependencies,snapshot.relations,snapshot.rowTypes,snapshot.arrayTypes,snapshot.columns,snapshot.indexes,snapshot.constraints,snapshot.triggers,snapshot.rules,snapshot.policies,snapshot.inheritance,snapshot.sequences])expect(Object.isFrozen(value)).toBe(true);expect(events.filter(value=>value==="COMMIT")).toHaveLength(1);expect(events.filter(value=>value==="ROLLBACK")).toHaveLength(0);expect(events.filter(value=>value==="release")).toHaveLength(1);expect(rootCalls).toBe(0);});

async function recordCatalogueBudget(edges:number){const events:string[]=[];let rootCalls=0;const names=["pg_class","pg_type","pg_constraint","pg_proc","pg_rewrite","pg_namespace","pg_attrdef","pg_trigger","pg_policy"];const provider=new PostgresProvider({options:{}});const session={unsafe:async(sql:string)=>{events.push(sql);if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.startsWith("SET LOCAL search_path")||sql.includes("pg_catalog.pg_advisory_xact_lock"))return[];if(sql.includes("max_identifier_length"))return[{max_identifier_length:"63"}];if(sql.startsWith("SELECT EXISTS"))return[{public_schema_exists:true}];if(sql.includes("__osnv_orm_owned_stores_v1"))return[];if(sql.includes("SELECT n.nspname AS schema_name"))return[{schema_name:"public"}];if(sql.includes("pg_catalog.left(c.relname"))return[{relation_oid:"100"}];if(sql.includes("AS oid,n.oid::pg_catalog.text AS namespace_oid"))return[{oid:"100",namespace_oid:"2200",schema_name:"public",relation_name:"provider_durable_probe",relkind:"?",relpersistence:"p",relispartition:false,relrowsecurity:false,relforcerowsecurity:false,relreplident:"d",tablespace_oid:"0",access_method:null,row_type_oid:"0",toast_relation_oid:"0"}];if(sql.includes("option_count"))return[{relation_oid:"100",option_count:"0"}];if(sql.includes("AS class_oid"))return names.map((name,index)=>({class_oid:String(index+1),class_schema:"pg_catalog",class_name:name}));if(sql.includes("pg_catalog.pg_index")||sql.includes("pg_catalog.pg_constraint")||sql.includes("pg_catalog.pg_trigger")||sql.includes("pg_catalog.pg_rewrite")||sql.includes("pg_catalog.pg_policy")||sql.includes("pg_catalog.pg_inherits"))return[];if(sql.includes("pg_catalog.pg_depend"))return Array.from({length:edges},(_,i)=>({dependent_class_oid:"1",dependent_oid:"100",dependent_sub_id:String(i),referenced_class_oid:"1",referenced_oid:"100",referenced_sub_id:"0",dependency_type:"n"}));throw new Error(`unexpected SQL: ${sql}`);},release:async()=>{events.push("release");}};Object.defineProperty(provider,"sql",{configurable:true,value:{close:async()=>{},unsafe:async()=>{rootCalls++;throw new Error("root");},reserve:async()=>session}});const capability=postgresOwnedStoreCapability(provider);if(!capability)throw new Error("missing");const result=await admissionResult(()=>capability.withOwnedStoreAdmission(undefined,async registry=>(await registry.lockSecondary(durablePlan)).inspectCatalog([durableDefinition.ownedScope])));return{result,events,rootCalls};}
for(const [edges,code] of [[65530,undefined],[65531,"ORM_OWNED_STORE_DRIFT"],[65532,"ORM_OWNED_STORE_LOCK_UNAVAILABLE"]] as const)test(`actual PostgresProvider Catalogue budget boundary ${edges}`,async()=>{const {result,events,rootCalls}=await recordCatalogueBudget(edges);expect(events.some(sql=>sql.includes("pg_catalog.pg_depend"))).toBe(true);expect(rootCalls).toBe(0);if(code){if(result.ok)throw new Error("expected failure");ownedError(result.error,code);expect(events.filter(value=>value==="ROLLBACK")).toHaveLength(1);expect(events).not.toContain("COMMIT");}else{if(!result.ok)throw result.error;const snapshot=result.value as OwnedStoreCatalogSnapshotV1;expect(snapshot.relations).toHaveLength(1);expect(snapshot.catalogClasses).toHaveLength(5);expect(snapshot.dependencies).toHaveLength(65530);expect(Object.isFrozen(snapshot.dependencies)).toBe(true);expect(Object.isFrozen(snapshot.dependencies[0]!)).toBe(true);expect(events.some(sql=>sql.endsWith("LIMIT 65531"))).toBe(true);expect(events).toContain("COMMIT");}expect(events).toContain("release");});
test("actual PostgresProvider Catalogue sequence root recorder maps numeric maximum to LOCK",async()=>{const {result,events,rootCalls}=await recordSequenceRoot(1);if(result.ok)throw new Error("unexpected sequence outcome");ownedError(result.error,"ORM_OWNED_STORE_LOCK_UNAVAILABLE");expect(events.some(sql=>sql.includes("pg_catalog.pg_sequence"))).toBe(true);expect(events.filter(event=>event==="ROLLBACK")).toHaveLength(1);expect(events.filter(event=>event==="release")).toHaveLength(1);expect(events).not.toContain("COMMIT");expect(rootCalls).toBe(0);});

const validSequenceWire={relation_oid:"100",sequence_type_oid:"20",resolved_type_oid:"20",type_schema:"pg_catalog",type_name:"int8",start_value:"1",increment_value:"1",minimum_value:"1",maximum_value:"9223372036854775807",cache_value:"1",cycle:false};
for(const [name,rows,expected] of [
  ["sentinel numeric alias",[{...validSequenceWire},{...validSequenceWire,maximum_value:1}],"ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
  ["sentinel duplicate wire rows",[{...validSequenceWire},{...validSequenceWire}],"ORM_OWNED_STORE_DRIFT"],
  ["over issued limit",[{...validSequenceWire},{...validSequenceWire},{...validSequenceWire}],"ORM_OWNED_STORE_LOCK_UNAVAILABLE"],
] as const)test(`actual PostgresProvider Catalogue sequence recorder rejects ${name}`,async()=>{const {result,events,rootCalls}=await recordSequenceRoot("9223372036854775807",rows);if(result.ok)throw new Error("unexpected sequence sentinel outcome");ownedError(result.error,expected);expect(events.some(sql=>sql.includes("pg_catalog.pg_sequence"))).toBe(true);expect(events.filter(event=>event==="ROLLBACK")).toHaveLength(1);expect(events.filter(event=>event==="release")).toHaveLength(1);expect(events).not.toContain("COMMIT");expect(rootCalls).toBe(0);});
