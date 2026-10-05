import { canonicalJsonHashV1 } from "../serialization/canonicalJsonV1";
import { BOUNDARY_SCHEMA_V1_DOMAIN, type BoundarySchemaV1 } from "./types-v1";

export function boundarySchemaHashV1(schema: BoundarySchemaV1): string {
  return canonicalJsonHashV1(BOUNDARY_SCHEMA_V1_DOMAIN, schema);
}
