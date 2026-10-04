import {
  appendJsonPointerV1,
  finalizeOsnovaDiagnosticsV1,
  osnovaDiagnosticV1,
  type OsnovaDiagnosticsV1,
  type OsnovaDiagnosticSourceV1,
  type OsnovaDiagnosticV1,
} from "../diagnostics-v1";
import {
  boundaryJsonLimitsV1,
  type BoundaryJsonLimitOverridesV1,
  type BoundaryJsonLimitsV1,
} from "./limits-v1";
import type { BoundaryJsonObject, BoundaryJsonValue } from "./types-v1";

export interface DecodeBoundedJsonV1Options {
  readonly limits?: BoundaryJsonLimitOverridesV1;
}

export type DecodeBoundedJsonV1Result =
  | ({ readonly ok: true; readonly value: BoundaryJsonValue } & OsnovaDiagnosticsV1)
  | ({ readonly ok: false } & OsnovaDiagnosticsV1);

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UTF8 = new TextEncoder();

export function decodeBoundedJsonV1(
  input: string | Uint8Array,
  options: DecodeBoundedJsonV1Options = {},
): DecodeBoundedJsonV1Result {
  const limits = boundaryJsonLimitsV1(options.limits);
  const decoded = decodeInput(input, limits);
  if (!decoded.ok) {
    return failure(decoded.diagnostic);
  }

  try {
    const parser = new StrictJsonParserV1(decoded.text, limits);
    return Object.freeze({
      ok: true,
      value: parser.parse(),
      diagnostics: Object.freeze([]),
      truncated: false,
    });
  } catch (error) {
    if (error instanceof JsonDecodeFailureV1) {
      return failure(error.diagnostic);
    }
    throw error;
  }
}

interface InputDecodeSuccess {
  readonly ok: true;
  readonly text: string;
}

interface InputDecodeFailure {
  readonly ok: false;
  readonly diagnostic: OsnovaDiagnosticV1;
}

function decodeInput(
  input: string | Uint8Array,
  limits: BoundaryJsonLimitsV1,
): InputDecodeSuccess | InputDecodeFailure {
  if (typeof input === "string" && input.length > limits.maxEncodedBytes) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "WF_JSON_TOO_LARGE",
        "JSON input exceeds the encoded byte ceiling.",
        "",
        { byteOffset: 0, line: 1, column: 1 },
      ),
    };
  }
  const bytes = typeof input === "string" ? UTF8.encode(input) : input;
  if (bytes.byteLength > limits.maxEncodedBytes) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "WF_JSON_TOO_LARGE",
        "JSON input exceeds the encoded byte ceiling.",
        "",
        { byteOffset: 0, line: 1, column: 1 },
      ),
    };
  }

  if (
    bytes.byteLength >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "WF_JSON_BOM_NOT_ALLOWED",
        "A UTF-8 byte-order mark is not allowed.",
        "",
        { byteOffset: 0, line: 1, column: 1 },
      ),
    };
  }

  if (typeof input === "string") {
    if (input.charCodeAt(0) === 0xfeff) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "WF_JSON_BOM_NOT_ALLOWED",
          "A Unicode byte-order mark is not allowed.",
          "",
          { byteOffset: 0, line: 1, column: 1 },
        ),
      };
    }
    const invalidUnicodeIndex = firstLoneSurrogate(input);
    if (invalidUnicodeIndex >= 0) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "WF_JSON_INVALID_UNICODE",
          "JSON text must contain Unicode scalar values.",
          "",
          sourceFor(input, invalidUnicodeIndex),
        ),
      };
    }
    return { ok: true, text: input };
  }

  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(input) };
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        "WF_JSON_INVALID_UTF8",
        "JSON input is not valid UTF-8.",
        "",
        { byteOffset: 0, line: 1, column: 1 },
      ),
    };
  }
}

class StrictJsonParserV1 {
  private index = 0;
  private values = 0;
  private objectMembers = 0;
  private arrayItems = 0;
  private totalStringBytes = 0;

  constructor(
    private readonly text: string,
    private readonly limits: BoundaryJsonLimitsV1,
  ) {}

  parse(): BoundaryJsonValue {
    this.skipWhitespace();
    const value = this.parseValue("", 1);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.fail("WF_JSON_MALFORMED", "Unexpected content follows the root JSON value.", "");
    }
    return value;
  }

  private parseValue(pointer: string, depth: number): BoundaryJsonValue {
    if (depth > this.limits.maxDepth) {
      this.fail("WF_JSON_DEPTH_LIMIT", "JSON nesting depth exceeds the framework ceiling.", pointer);
    }
    this.values += 1;
    if (this.values > this.limits.maxValues) {
      this.fail("WF_JSON_VALUE_LIMIT", "JSON value count exceeds the framework ceiling.", pointer);
    }

    const character = this.text[this.index];
    if (character === "{") return this.parseObject(pointer, depth);
    if (character === "[") return this.parseArray(pointer, depth);
    if (character === "\"") return this.parseString(pointer, false);
    if (character === "t") return this.parseKeyword("true", true, pointer);
    if (character === "f") return this.parseKeyword("false", false, pointer);
    if (character === "n") return this.parseKeyword("null", null, pointer);
    if (character === "-" || isDigit(character)) return this.parseNumber(pointer);
    this.fail("WF_JSON_MALFORMED", "Expected a JSON value.", pointer);
  }

  private parseObject(pointer: string, depth: number): BoundaryJsonObject {
    this.index += 1;
    this.skipWhitespace();
    const output = Object.create(null) as Record<string, BoundaryJsonValue>;
    const keys = new Set<string>();
    let memberCount = 0;

    if (this.consume("}")) {
      return Object.freeze(output);
    }

    while (true) {
      if (this.text[this.index] !== "\"") {
        this.fail("WF_JSON_MALFORMED", "Expected a quoted JSON property name.", pointer);
      }
      const keyStart = this.index;
      const key = this.parseString(pointer, true);
      const propertyPointer = appendJsonPointerV1(pointer, key);
      if (FORBIDDEN_KEYS.has(key)) {
        this.failAt(
          "WF_JSON_FORBIDDEN_PROPERTY",
          "The JSON property name is forbidden at every nesting level.",
          propertyPointer,
          keyStart,
        );
      }
      if (keys.has(key)) {
        this.failAt(
          "WF_JSON_DUPLICATE_PROPERTY",
          "Duplicate JSON property names are not allowed.",
          propertyPointer,
          keyStart,
        );
      }
      keys.add(key);

      memberCount += 1;
      this.objectMembers += 1;
      if (
        memberCount > this.limits.maxMembersPerObject
        || this.objectMembers > this.limits.maxObjectMembers
      ) {
        this.fail("WF_JSON_OBJECT_LIMIT", "JSON object member count exceeds the framework ceiling.", pointer);
      }

      this.skipWhitespace();
      if (!this.consume(":")) {
        this.fail("WF_JSON_MALFORMED", "Expected ':' after the JSON property name.", propertyPointer);
      }
      this.skipWhitespace();
      output[key] = this.parseValue(propertyPointer, depth + 1);
      this.skipWhitespace();

      if (this.consume("}")) {
        return Object.freeze(output);
      }
      if (!this.consume(",")) {
        this.fail("WF_JSON_MALFORMED", "Expected ',' or '}' in the JSON object.", pointer);
      }
      this.skipWhitespace();
    }
  }

  private parseArray(pointer: string, depth: number): readonly BoundaryJsonValue[] {
    this.index += 1;
    this.skipWhitespace();
    const output: BoundaryJsonValue[] = [];

    if (this.consume("]")) {
      return Object.freeze(output);
    }

    while (true) {
      const itemPointer = appendJsonPointerV1(pointer, output.length);
      this.arrayItems += 1;
      if (
        output.length >= this.limits.maxItemsPerArray
        || this.arrayItems > this.limits.maxArrayItems
      ) {
        this.fail("WF_JSON_ARRAY_LIMIT", "JSON array item count exceeds the framework ceiling.", pointer);
      }
      output.push(this.parseValue(itemPointer, depth + 1));
      this.skipWhitespace();

      if (this.consume("]")) {
        return Object.freeze(output);
      }
      if (!this.consume(",")) {
        this.fail("WF_JSON_MALFORMED", "Expected ',' or ']' in the JSON array.", pointer);
      }
      this.skipWhitespace();
    }
  }

  private parseString(pointer: string, key: boolean): string {
    this.index += 1;
    const parts: string[] = [];

    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === "\"") {
        this.index += 1;
        const value = parts.join("");
        const invalidIndex = firstLoneSurrogate(value);
        if (invalidIndex >= 0) {
          this.fail("WF_JSON_INVALID_UNICODE", "JSON strings must contain Unicode scalar values.", pointer);
        }
        const byteLength = UTF8.encode(value).byteLength;
        if (byteLength > (key ? this.limits.maxKeyBytes : this.limits.maxStringBytes)) {
          this.fail(
            key ? "WF_JSON_KEY_LIMIT" : "WF_JSON_STRING_LIMIT",
            key
              ? "JSON property name exceeds the framework byte ceiling."
              : "JSON string exceeds the framework byte ceiling.",
            pointer,
          );
        }
        this.totalStringBytes += byteLength;
        if (this.totalStringBytes > this.limits.maxTotalStringBytes) {
          this.fail("WF_JSON_STRING_LIMIT", "Total decoded JSON string bytes exceed the framework ceiling.", pointer);
        }
        return value;
      }

      if (character === "\\") {
        this.index += 1;
        parts.push(this.parseEscape(pointer));
        continue;
      }

      if (character === undefined || character.charCodeAt(0) < 0x20) {
        this.fail("WF_JSON_MALFORMED", "JSON strings cannot contain unescaped control characters.", pointer);
      }
      parts.push(character);
      this.index += 1;
    }

    this.fail("WF_JSON_MALFORMED", "Unterminated JSON string.", pointer);
  }

  private parseEscape(pointer: string): string {
    const escaped = this.text[this.index];
    this.index += 1;
    switch (escaped) {
      case "\"": return "\"";
      case "\\": return "\\";
      case "/": return "/";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "u": {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
          this.fail("WF_JSON_MALFORMED", "Invalid Unicode escape in JSON string.", pointer);
        }
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        this.fail("WF_JSON_MALFORMED", "Invalid escape in JSON string.", pointer);
    }
  }

  private parseNumber(pointer: string): number {
    const start = this.index;
    this.consume("-");

    if (this.consume("0")) {
      if (isDigit(this.text[this.index])) {
        this.fail("WF_JSON_MALFORMED", "Leading zeroes are not allowed in JSON numbers.", pointer);
      }
    } else {
      if (!isNonZeroDigit(this.text[this.index])) {
        this.fail("WF_JSON_MALFORMED", "Invalid JSON number.", pointer);
      }
      while (isDigit(this.text[this.index])) this.index += 1;
    }

    if (this.consume(".")) {
      if (!isDigit(this.text[this.index])) {
        this.fail("WF_JSON_MALFORMED", "A JSON fraction requires at least one digit.", pointer);
      }
      while (isDigit(this.text[this.index])) this.index += 1;
    }

    const exponent = this.text[this.index];
    if (exponent === "e" || exponent === "E") {
      this.index += 1;
      const sign = this.text[this.index];
      if (sign === "+" || sign === "-") this.index += 1;
      if (!isDigit(this.text[this.index])) {
        this.fail("WF_JSON_MALFORMED", "A JSON exponent requires at least one digit.", pointer);
      }
      while (isDigit(this.text[this.index])) this.index += 1;
    }

    const token = this.text.slice(start, this.index);
    if (token.length > this.limits.maxNumberTokenBytes) {
      this.failAt("WF_JSON_NUMBER_OUT_OF_RANGE", "JSON number token exceeds the framework ceiling.", pointer, start);
    }
    const value = Number(token);
    if (
      !Number.isFinite(value)
      || isNonZeroUnderflow(token, value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      this.failAt(
        "WF_JSON_NUMBER_OUT_OF_RANGE",
        "JSON number is outside the supported finite safe range.",
        pointer,
        start,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }

  private parseKeyword<T extends boolean | null>(token: string, value: T, pointer: string): T {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      this.fail("WF_JSON_MALFORMED", "Invalid JSON literal.", pointer);
    }
    this.index += token.length;
    return value;
  }

  private skipWhitespace(): void {
    while (true) {
      const character = this.text[this.index];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
        return;
      }
      this.index += 1;
    }
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private fail(code: string, message: string, pointer: string): never {
    this.failAt(code, message, pointer, this.index);
  }

  private failAt(code: string, message: string, pointer: string, index: number): never {
    throw new JsonDecodeFailureV1(diagnostic(code, message, pointer, sourceFor(this.text, index)));
  }
}

class JsonDecodeFailureV1 extends Error {
  constructor(readonly diagnostic: OsnovaDiagnosticV1) {
    super(diagnostic.message);
    this.name = "JsonDecodeFailureV1";
  }
}

function failure(diagnosticValue: OsnovaDiagnosticV1): DecodeBoundedJsonV1Result {
  const finalized = finalizeOsnovaDiagnosticsV1([diagnosticValue]);
  return Object.freeze({ ok: false, ...finalized });
}

function diagnostic(
  code: string,
  message: string,
  pointer: string,
  source: OsnovaDiagnosticSourceV1,
): OsnovaDiagnosticV1 {
  return osnovaDiagnosticV1({
    severity: "error",
    stage: "decode",
    code,
    message,
    pointer,
    source,
  });
}

function sourceFor(text: string, index: number): OsnovaDiagnosticSourceV1 {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return {
    byteOffset: UTF8.encode(text.slice(0, index)).byteLength,
    line,
    column,
  };
}

function firstLoneSurrogate(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return index;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return index;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return index;
  }
  return -1;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isNonZeroDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "1" && value <= "9";
}

function isNonZeroUnderflow(token: string, value: number): boolean {
  if (value !== 0) return false;
  const significand = token.split(/[eE]/, 1)[0] ?? "";
  return /[1-9]/.test(significand);
}
