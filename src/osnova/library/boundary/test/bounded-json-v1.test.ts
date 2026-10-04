import { describe, expect, test } from "bun:test";
import {
  canonicalBoundaryJsonV1,
  decodeBoundedJsonV1,
  normalizeBoundedJsonV1,
} from "@/library/boundary";

describe("bounded JSON v1", () => {
  test("decodes null-prototype frozen JSON without losing source-level duplicates", () => {
    const decoded = decodeBoundedJsonV1('{"b":2,"a":{"value":true}}');

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Object.getPrototypeOf(decoded.value)).toBeNull();
    expect(Object.isFrozen(decoded.value)).toBe(true);
    const nested = (decoded.value as Record<string, unknown>).a as object;
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.isFrozen(nested)).toBe(true);
  });

  test("rejects exact, escaped and nested duplicate property names", () => {
    for (const source of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"outer":{"a":1,"a":2}}',
    ]) {
      const decoded = decodeBoundedJsonV1(source);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.diagnostics[0]?.code).toBe("WF_JSON_DUPLICATE_PROPERTY");
    }

    expect(decodeBoundedJsonV1('{"left":{"a":1},"right":{"a":2}}').ok).toBe(true);
  });

  test("rejects forbidden keys after unescaping at every depth", () => {
    for (const source of [
      '{"__proto__":1}',
      '{"nested":{"prototype":1}}',
      '{"constr\\u0075ctor":1}',
    ]) {
      const decoded = decodeBoundedJsonV1(source);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.diagnostics[0]?.code).toBe("WF_JSON_FORBIDDEN_PROPERTY");
    }
  });

  test("rejects invalid UTF-8, BOM, lone surrogates and malformed JSON", () => {
    const cases: readonly [string | Uint8Array, string][] = [
      [new Uint8Array([0xc3, 0x28]), "WF_JSON_INVALID_UTF8"],
      [new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), "WF_JSON_BOM_NOT_ALLOWED"],
      ['"\\ud800"', "WF_JSON_INVALID_UNICODE"],
      ['"\\udc00"', "WF_JSON_INVALID_UNICODE"],
      ['"\\ud800\udc00"', "WF_JSON_INVALID_UNICODE"],
      ['{"a":01}', "WF_JSON_MALFORMED"],
      ['{"a":"\\x20"}', "WF_JSON_MALFORMED"],
    ];

    for (const [source, code] of cases) {
      const decoded = decodeBoundedJsonV1(source);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.diagnostics[0]?.code).toBe(code);
    }
  });

  test("accepts every exact ceiling and rejects the next raw JSON unit", () => {
    const cases = [
      {
        name: "encoded bytes",
        exact: "[]",
        exceeded: "[ ]",
        limits: { maxEncodedBytes: 2 },
        code: "WF_JSON_TOO_LARGE",
      },
      {
        name: "depth",
        exact: "[0]",
        exceeded: "[[0]]",
        limits: { maxDepth: 2 },
        code: "WF_JSON_DEPTH_LIMIT",
      },
      {
        name: "values",
        exact: "[0,0]",
        exceeded: "[0,0,0]",
        limits: { maxValues: 3 },
        code: "WF_JSON_VALUE_LIMIT",
      },
      {
        name: "members per object",
        exact: '{"a":0,"b":0}',
        exceeded: '{"a":0,"b":0,"c":0}',
        limits: { maxMembersPerObject: 2 },
        code: "WF_JSON_OBJECT_LIMIT",
      },
      {
        name: "total object members",
        exact: '{"a":{"b":0}}',
        exceeded: '{"a":{"b":0},"c":0}',
        limits: { maxObjectMembers: 2 },
        code: "WF_JSON_OBJECT_LIMIT",
      },
      {
        name: "items per array",
        exact: "[0,0]",
        exceeded: "[0,0,0]",
        limits: { maxItemsPerArray: 2 },
        code: "WF_JSON_ARRAY_LIMIT",
      },
      {
        name: "total array items",
        exact: "[[0]]",
        exceeded: "[[0],0]",
        limits: { maxArrayItems: 2 },
        code: "WF_JSON_ARRAY_LIMIT",
      },
      {
        name: "key bytes",
        exact: '{"é":0}',
        exceeded: '{"€":0}',
        limits: { maxKeyBytes: 2 },
        code: "WF_JSON_KEY_LIMIT",
      },
      {
        name: "string bytes",
        exact: '"é"',
        exceeded: '"€"',
        limits: { maxStringBytes: 2 },
        code: "WF_JSON_STRING_LIMIT",
      },
      {
        name: "total string bytes",
        exact: '["abc"]',
        exceeded: '["abcd"]',
        limits: { maxTotalStringBytes: 3 },
        code: "WF_JSON_STRING_LIMIT",
      },
      {
        name: "number token bytes",
        exact: "123",
        exceeded: "1234",
        limits: { maxNumberTokenBytes: 3 },
        code: "WF_JSON_NUMBER_OUT_OF_RANGE",
      },
    ] as const;

    for (const testCase of cases) {
      const exact = decodeBoundedJsonV1(testCase.exact, { limits: testCase.limits });
      expect([testCase.name, exact.ok]).toEqual([testCase.name, true]);

      const exceeded = decodeBoundedJsonV1(testCase.exceeded, { limits: testCase.limits });
      expect([testCase.name, exceeded.ok]).toEqual([testCase.name, false]);
      if (!exceeded.ok) {
        expect([testCase.name, exceeded.diagnostics[0]?.code]).toEqual([
          testCase.name,
          testCase.code,
        ]);
      }
    }
  });

  test("rejects unsafe numeric values and canonicalizes negative zero", () => {
    for (const source of ["9007199254740992", "1e400", "1e-324"] as const) {
      const decoded = decodeBoundedJsonV1(source);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.diagnostics[0]?.code).toBe("WF_JSON_NUMBER_OUT_OF_RANGE");
    }

    const negativeZero = decodeBoundedJsonV1("-0");
    expect(negativeZero.ok).toBe(true);
    if (negativeZero.ok) expect(Object.is(negativeZero.value, -0)).toBe(false);
  });

  test("normalizes agent objects without invoking accessors", () => {
    let invoked = false;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    const normalized = normalizeBoundedJsonV1(accessor);
    expect(normalized.ok).toBe(false);
    expect(invoked).toBe(false);

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(normalizeBoundedJsonV1(sparse).ok).toBe(false);
    expect(normalizeBoundedJsonV1(new Date()).ok).toBe(false);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(normalizeBoundedJsonV1(cyclic).ok).toBe(false);

    let proxyTrapInvoked = false;
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        proxyTrapInvoked = true;
        return Object.prototype;
      },
      ownKeys() {
        proxyTrapInvoked = true;
        return [];
      },
    });
    expect(normalizeBoundedJsonV1(proxy).ok).toBe(false);
    expect(proxyTrapInvoked).toBe(false);
  });

  test("produces RFC 8785-compatible key and accepted number serialization", () => {
    const value = {
      numbers: [333333333.33333329, 4.50, 2e-3, 1e-27],
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };

    expect(canonicalBoundaryJsonV1(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","numbers":[333333333.3333333,4.5,0.002,1e-27],"\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  test("does not normalize Unicode and preserves array order", () => {
    expect(canonicalBoundaryJsonV1({ value: "\u00e9" })).not.toBe(
      canonicalBoundaryJsonV1({ value: "e\u0301" }),
    );
    expect(canonicalBoundaryJsonV1([1, 2])).not.toBe(canonicalBoundaryJsonV1([2, 1]));
  });
});
