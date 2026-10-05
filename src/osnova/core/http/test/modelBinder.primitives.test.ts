import { expect, test } from "bun:test";
import { ModelValidationError } from "../Errors/HttpError";
import { bindModel } from "../Binding/modelBinder";
import { registerRequestModelShape } from "../Binding/requestModelRegistry";

class TaskUpdate {
  title?: string;
  done?: boolean;
  estimate?: number | null;
  tags?: string[];
}
registerRequestModelShape(TaskUpdate, {
  title: { primitive: "string" },
  done: { primitive: "boolean" },
  estimate: { primitive: "number", nullable: true },
  tags: { primitive: "string", array: true },
});

const http = { primitiveTypes: true } as const;

function typeError(body: Record<string, unknown>): unknown {
  try {
    bindModel(TaskUpdate, body, undefined, http);
  } catch (error) {
    return error instanceof ModelValidationError ? error.errors : error;
  }
  return "bound";
}

test("HTTP binding accepts declared JSON types, null where declared and absent fields", () => {
  const bound = bindModel(TaskUpdate, { title: "x", done: false, estimate: null, tags: ["a"] }, undefined, http);
  expect(bound).toMatchObject({ title: "x", done: false, estimate: null, tags: ["a"] });
  expect(bindModel(TaskUpdate, {}, undefined, http).done).toBeUndefined();
});

test("HTTP binding rejects a JSON value of another type with a 400 type error", () => {
  expect(typeError({ done: "yes" })).toEqual([{ property: "done", message: 'Field "done" must be a boolean', code: "type" }]);
  expect(typeError({ title: 5 })).toEqual([{ property: "title", message: 'Field "title" must be a string', code: "type" }]);
  expect(typeError({ estimate: "5" })).toEqual([{ property: "estimate", message: 'Field "estimate" must be a number', code: "type" }]);
  expect(typeError({ title: null })).toEqual([{ property: "title", message: 'Field "title" must be a string', code: "type" }]);
  expect(typeError({ tags: "a" })).toEqual([{ property: "tags", message: 'Field "tags" must be a array', code: "type" }]);
  expect(typeError({ tags: ["a", 1] })).toEqual([{ property: "tags[1]", message: 'Field "tags[1]" must be a string', code: "type" }]);
});

test("without primitiveTypes (gRPC, agents) values pass through as before", () => {
  expect(bindModel(TaskUpdate, { done: "yes", estimate: "5" }).done as unknown).toBe("yes");
});

test("a malformed primitive shape is rejected at registration", () => {
  class Broken { value = ""; }
  expect(() => registerRequestModelShape(Broken, { value: { primitive: "date" } as never })).toThrow(TypeError);
  expect(() => registerRequestModelShape(Broken, { value: { primitive: "string", model: Broken } as never })).toThrow(TypeError);
});
