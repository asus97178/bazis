/** Проект формата jsonb. Только типы документации, без runtime и ORM-регистраций. */
import type {
  BoundarySchemaV1,
  BoundaryObjectSchemaV1,
} from "../../src/osnova/library/boundary/schema/types-v1";
import type {
  BoundaryJsonValue,
  BoundaryJsonObject,
} from "../../src/osnova/library/boundary/json/types-v1";

export type JsonValue = BoundaryJsonValue;
export type JsonObject = BoundaryJsonObject;
/** 1..128 символов, не только пробелы. */
export type Key = string;
/** Целое 0..9007199254740991; локальные ограничения могут требовать минимум 1. */
export type Counter = number;
export type ValueContract = BoundarySchemaV1;

/** Корни входа и переменных всегда закрытые ненулевые объекты. */
export type FieldsContract = Omit<
  BoundaryObjectSchemaV1,
  "nullable" | "properties" | "required" | "additionalProperties" | "default"
> & {
  readonly nullable?: false;
  readonly properties: Readonly<Record<Key, ValueContract>>;
  readonly required: readonly Key[];
  readonly additionalProperties: false;
};

/** У каждой переменной есть явный default; required содержит все ключи properties. */
export type VariablesContract = Omit<FieldsContract, "properties"> & {
  readonly properties: Readonly<Record<Key, ValueContract & { readonly default: JsonValue }>>;
};

export interface ProcessConstant {
  readonly contract: ValueContract;
  readonly value: JsonValue;
}

export type ValueRef =
  | { readonly source: "literal"; readonly value: JsonValue }
  | { readonly source: "input" | "variables" | "constants" | "event"; readonly path: readonly string[] }
  | { readonly source: "globalVariables" | "globalConstants"; readonly key: Key; readonly path: readonly string[] };

export type Condition =
  | { readonly kind: "compare"; readonly left: ValueRef;
      readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; readonly right: ValueRef }
  | { readonly kind: "all" | "any"; readonly items: readonly [Condition, ...Condition[]] };

/** Ключ — имя параметра зарегистрированного метода либо входного поля процесса. */
export type InputBindings = Readonly<Record<Key, ValueRef>>;

interface NodeBase {
  readonly id: Key;
  readonly name: string; // 1..200 символов
}

export type WorkflowNode = NodeBase & (
  | { readonly kind: "start"; readonly nextNodeId: Key }
  | { readonly kind: "activity"; readonly activityId: Key; readonly inputBindings: InputBindings;
      readonly resultVariable: Key | null; readonly nextNodeId: Key }
  | { readonly kind: "condition"; readonly condition: Condition; readonly trueNodeId: Key; readonly falseNodeId: Key }
  | { readonly kind: "loop"; readonly condition: Condition; readonly bodyNodeId: Key; readonly exitNodeId: Key }
  | { readonly kind: "delay"; readonly durationMs: Counter; readonly nextNodeId: Key } // durationMs > 0
  | { readonly kind: "wait"; readonly eventType: Key; readonly subjectKey: ValueRef;
      readonly condition: Condition | null; readonly resultVariable: Key | null; readonly nextNodeId: Key }
  | { readonly kind: "end" }
);

export interface WorkflowDocument {
  readonly formatVersion: 1;
  readonly entryNodeId: Key;
  readonly inputContract: FieldsContract;
  readonly variablesContract: VariablesContract;
  readonly constants: Readonly<Record<Key, ProcessConstant>>;
  readonly nodes: readonly [WorkflowNode, ...WorkflowNode[]];
  readonly layout: readonly { readonly nodeId: Key; readonly x: number; readonly y: number }[];
}

export interface LoopFrame {
  readonly nodeId: Key;
  readonly iteration: Counter; // >= 1
}
export type LoopStack = readonly LoopFrame[];

/** В сохранённом wait все ссылки, кроме текущего event, уже заменены literal. */
export type WaitValueRef =
  | { readonly source: "literal"; readonly value: JsonValue }
  | { readonly source: "event"; readonly path: readonly string[] };

export type WaitCondition =
  | { readonly kind: "compare"; readonly left: WaitValueRef;
      readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; readonly right: WaitValueRef }
  | { readonly kind: "all" | "any"; readonly items: readonly [WaitCondition, ...WaitCondition[]] };

/** У condition/loop все ссылки разрешены до исполнения шага. */
export type LiteralValueRef = { readonly source: "literal"; readonly value: JsonValue };
export type ResolvedCondition =
  | { readonly kind: "compare"; readonly left: LiteralValueRef;
      readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; readonly right: LiteralValueRef }
  | { readonly kind: "all" | "any"; readonly items: readonly [ResolvedCondition, ...ResolvedCondition[]] };

/** Точный формат Step.input выбирается по колонке Step.kind. */
export interface StepInputsByKind {
  readonly start: Readonly<Record<string, never>>;
  readonly activity: JsonObject; // Именованные параметры метода по автоматически выведенной схеме.
  readonly condition: { readonly condition: ResolvedCondition };
  readonly loop: { readonly condition: ResolvedCondition };
  readonly delay: { readonly durationMs: Counter };
  readonly wait: { readonly eventType: Key; readonly subjectKey: string; readonly condition: WaitCondition | null };
  readonly end: Readonly<Record<string, never>>;
}

/** Значение внутри output после completed; SQL NULL в этот тип не входит. */
export interface StepOutputsByKind {
  readonly start: null;
  readonly activity: JsonValue; // Результат метода; void нормализуется в JSON null.
  readonly condition: null;
  readonly loop: null;
  readonly delay: null;
  readonly wait: JsonObject; // payload события, указанного в matched_event_id.
  readonly end: null;
}
