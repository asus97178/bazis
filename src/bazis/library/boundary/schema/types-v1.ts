import type { BoundaryJsonValue } from "../json/types-v1";

export const BOUNDARY_SCHEMA_V1_DOMAIN = "bazis.boundary-schema/v1" as const;
export const BOUNDARY_SCHEMA_MAX_DEPTH_V1 = 32;
export const BOUNDARY_SCHEMA_MAX_NODES_V1 = 2_048;
export const BOUNDARY_SCHEMA_MAX_ENUM_VALUES_V1 = 256;

export type BoundarySchemaTypeV1 =
  | "null"
  | "boolean"
  | "string"
  | "number"
  | "integer"
  | "array"
  | "object";

export type BoundaryStringFormatV1 =
  | "date"
  | "time"
  | "date-time"
  | "uuid"
  | "email"
  | "decimal"
  | "int64-string";

export interface BoundarySchemaCommonV1 {
  readonly title?: string;
  readonly description?: string;
  readonly nullable?: boolean;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly secret?: boolean;
  readonly default?: BoundaryJsonValue;
}

export interface BoundaryNullSchemaV1 extends BoundarySchemaCommonV1 {
  readonly type: "null";
  readonly enum?: readonly null[];
}

export interface BoundaryBooleanSchemaV1 extends BoundarySchemaCommonV1 {
  readonly type: "boolean";
  readonly enum?: readonly boolean[];
}

export interface BoundaryStringSchemaV1 extends BoundarySchemaCommonV1 {
  readonly type: "string";
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly format?: BoundaryStringFormatV1;
}

export interface BoundaryNumberSchemaV1 extends BoundarySchemaCommonV1 {
  readonly type: "number";
  readonly enum?: readonly number[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
}

export interface BoundaryIntegerSchemaV1 extends BoundarySchemaCommonV1 {
  readonly type: "integer";
  readonly enum?: readonly number[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
}

export interface BoundaryArraySchemaV1 extends BoundarySchemaCommonV1 {
  readonly type: "array";
  readonly items: BoundarySchemaV1;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: true;
}

export interface BoundaryObjectSchemaV1 extends BoundarySchemaCommonV1 {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, BoundarySchemaV1>>;
  readonly required?: readonly string[];
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly additionalProperties?: false | BoundarySchemaV1;
}

export type BoundaryScalarSchemaV1 =
  | BoundaryNullSchemaV1
  | BoundaryBooleanSchemaV1
  | BoundaryStringSchemaV1
  | BoundaryNumberSchemaV1
  | BoundaryIntegerSchemaV1;

export type BoundarySchemaV1 =
  | BoundaryScalarSchemaV1
  | BoundaryArraySchemaV1
  | BoundaryObjectSchemaV1;
