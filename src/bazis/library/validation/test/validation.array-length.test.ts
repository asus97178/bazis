import { afterEach, expect, test } from "bun:test";
import { MessageRegistry, RU_VALIDATION_MESSAGES, Validator } from "../index";

// notEmpty / minLength / maxLength / length count array items; before, any of
// them on an array failed with a misleading "must be of type string" error.
afterEach(() => MessageRegistry.reset());

class Item {
  @Validator({ required: true, min: 1 }) qty = 0;
}

class Order {
  @Validator({ required: true, notEmpty: true }) items: Item[] = [];
  @Validator({ minLength: 2, maxLength: 3 }) tags?: string[];
  @Validator({ length: [1, 2] }) codes?: string[];
  @Validator({ minLength: 2 }) title?: string;
  @Validator({ pattern: /^[a-z]+$/ }) slug?: unknown;
}

function issues(order: Partial<Order>) {
  return Validator.validate(Object.assign(new Order(), order)).errors.map((e) => ({ property: e.property, code: e.code, message: e.message }));
}

const item = (qty: number) => Object.assign(new Item(), { qty });

test("length rules count array items with their own codes", () => {
  expect(issues({ items: [item(1)], tags: ["a", "b"], codes: ["x"] })).toEqual([]);
  expect(issues({ items: [], tags: ["a"], codes: [] })).toEqual([
    { property: "items", code: "notEmpty", message: 'Field "items" must not be empty' },
    { property: "tags", code: "minItems", message: 'Field "tags" must contain at least 2 items' },
    { property: "codes", code: "itemCount", message: 'Field "codes" must contain 1 to 2 items' },
  ]);
  expect(issues({ items: [item(1)], tags: ["a", "b", "c", "d"] })).toEqual([
    { property: "tags", code: "maxItems", message: 'Field "tags" must contain at most 3 items' },
  ]);
});

test("array items are still validated as nested models", () => {
  expect(issues({ items: [item(1), item(0)] })).toEqual([
    { property: "items[1].qty", code: "min", message: 'Field "items[1].qty" must be at least 1' },
  ]);
});

test("strings keep their character-length rules", () => {
  expect(issues({ items: [item(1)], title: "a" })).toEqual([
    { property: "title", code: "minLength", message: 'Field "title" must be at least 2 characters long' },
  ]);
});

test("a string-only rule on an array names the array type", () => {
  expect(issues({ items: [item(1)], slug: ["a"] })).toEqual([
    { property: "slug", code: "type", message: 'Field "slug" must be of type string, got: array' },
  ]);
});

test("the Russian set has the array texts", () => {
  MessageRegistry.setDefaults(RU_VALIDATION_MESSAGES);
  expect(issues({ items: [item(1)], tags: ["a"] })[0]?.message).toBe('Поле "tags" должно содержать не менее 2 элементов');
});
