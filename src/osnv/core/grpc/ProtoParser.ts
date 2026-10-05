import type { ProtoSchema, ProtoMessage, ProtoField, ProtoRpc } from "./ProtoSchema";

/** Bounded proto3 parser. Unsupported dialects fail instead of changing the wire contract. */
export class ProtoParser {
  private readonly tokens: string[] = [];
  private cursor = 0;
  private packageName = "";
  readonly imports: string[] = [];

  constructor(source: string, private readonly schema: ProtoSchema, private readonly filename: string) {
    if (source.length > 4 * 1024 * 1024) this.fail("Schema exceeds 4 MiB.");
    const lexer = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z_0-9]*|0[xX][0-9a-fA-F]+|\d+|[{}()[\];=.,<>:+-]/gy;
    let offset = 0;
    while (offset < source.length) {
      lexer.lastIndex = offset;
      const match = lexer.exec(source);
      if (!match) this.fail("Unexpected character at offset " + offset + ".");
      const token = match![0];
      offset = lexer.lastIndex;
      if (!/^\s|^\/\//.test(token) && !token.startsWith("/*")) this.tokens.push(token);
    }
  }

  parse(): void {
    this.expect("syntax"); this.expect("=");
    if (this.string() !== "proto3") this.fail("Only syntax = proto3 is supported.");
    this.expect(";");
    while (this.peek() !== undefined) {
      switch (this.take()) {
        case "package": this.packageName = this.type(); this.expect(";"); break;
        case "import":
          if (this.peek() === "public") this.take();
          if (this.peek() === "weak") this.fail("Weak imports are not supported.");
          this.imports.push(this.string()); this.expect(";"); break;
        case "message": this.message(this.packageName, 0); break;
        case "enum": this.enumeration(this.packageName); break;
        case "service": this.service(); break;
        case "option": this.skipStatement(); break;
        case ";": break;
        default: this.fail("Unsupported top-level declaration.");
      }
    }
  }
  private message(parent: string, depth: number): void {
    if (depth >= 64) this.fail("Schema nesting exceeds 64.");
    const name = qualify(parent, this.identifier());
    this.unique(name);
    const message: ProtoMessage = { name, fields: [] };
    this.schema.messages.set(name, message);
    this.expect("{");
    while (!this.accept("}")) {
      if (this.accept("message")) this.message(name, depth + 1);
      else if (this.accept("enum")) this.enumeration(name);
      else if (this.accept("option") || this.accept("reserved")) this.skipStatement();
      else if (this.accept("oneof")) {
        const oneof = this.identifier(); this.expect("{");
        while (!this.accept("}")) {
          if (this.accept("option")) this.skipStatement();
          else message.fields.push(this.field(oneof));
        }
      } else if (!this.accept(";")) message.fields.push(this.field());
    }
    const numbers = new Set<number>(), names = new Set<string>();
    for (const field of message.fields) {
      if (numbers.has(field.number) || names.has(field.name)) this.fail("Duplicate field in " + name + ".");
      numbers.add(field.number); names.add(field.name);
      if (field.oneof && message.fields.some((entry) => entry.name === field.oneof)) this.fail("oneof name collides with a field.");
    }
  }
  private field(oneof?: string): ProtoField {
    const repeated = this.accept("repeated");
    const optional = this.accept("optional");
    if (repeated && optional) this.fail("A field cannot be both repeated and optional.");
    if (oneof && (repeated || optional)) this.fail("oneof fields cannot have labels.");
    let type: string, mapKey: string | undefined;
    if (this.accept("map")) {
      if (repeated || optional || oneof) this.fail("Invalid map field label.");
      this.expect("<"); mapKey = this.type(); this.expect(","); type = this.type(); this.expect(">");
      if (!/^(?:u?int(?:32|64)|sint(?:32|64)|s?fixed(?:32|64)|bool|string)$/.test(mapKey)) this.fail("Invalid map key type.");
    } else type = this.type();
    const name = this.identifier(); this.expect("=");
    const number = this.number();
    if (number < 1 || number > 536870911 || number >= 19000 && number <= 19999) this.fail("Invalid protobuf field number.");
    let packed = true;
    if (this.accept("[")) {
      while (!this.accept("]")) {
        if (this.accept("packed")) {
          this.expect("=");
          const value = this.take();
          if (value !== "true" && value !== "false") this.fail("Invalid packed option.");
          packed = value === "true";
        } else this.skipFieldOption();
        if (this.peek() !== "]") this.expect(",");
      }
    }
    this.expect(";");
    return { name, number, type, repeated, optional, oneof, mapKey, packed };
  }
  private enumeration(parent: string): void {
    const name = qualify(parent, this.identifier());
    this.unique(name);
    const values: Record<string, number> = Object.create(null);
    this.expect("{");
    while (!this.accept("}")) {
      if (this.accept("option") || this.accept("reserved")) { this.skipStatement(); continue; }
      if (this.accept(";")) continue;
      const key = this.identifier(); this.expect("="); const value = this.number();
      if (value < -2147483648 || value > 2147483647 || Object.hasOwn(values, key)) this.fail("Invalid enum entry.");
      if (Object.keys(values).length === 0 && value !== 0) this.fail("The first proto3 enum value must be zero.");
      values[key] = value;
      if (this.accept("[")) { while (!this.accept("]")) this.take(); }
      this.expect(";");
    }
    if (Object.keys(values).length === 0) this.fail("Empty protobuf enum.");
    this.schema.enums.set(name, { name, values });
  }
  private service(): void {
    const name = qualify(this.packageName, this.identifier());
    this.unique(name);
    const methods: ProtoRpc[] = [];
    this.expect("{");
    while (!this.accept("}")) {
      if (this.accept("option")) { this.skipStatement(); continue; }
      if (this.accept(";")) continue;
      this.expect("rpc");
      const method = this.identifier();
      if (methods.some((entry) => entry.name === method)) this.fail("Duplicate RPC method.");
      this.expect("("); const requestStream = this.accept("stream"); const input = this.type(); this.expect(")");
      this.expect("returns"); this.expect("("); const responseStream = this.accept("stream"); const output = this.type(); this.expect(")");
      if (this.accept("{")) {
        while (!this.accept("}")) { this.expect("option"); this.skipStatement(); }
      } else this.expect(";");
      methods.push({ name: method, input, output, requestStream, responseStream });
    }
    this.schema.services.set(name, methods);
  }
  private skipStatement(): void {
    let depth = 0;
    while (true) {
      const token = this.take();
      if (token === ";" && depth === 0) return;
      if (["{", "(", "["].includes(token)) depth++;
      if (["}", ")", "]"].includes(token) && --depth < 0) this.fail("Unbalanced option.");
      if (depth > 64) this.fail("Option nesting exceeds 64.");
    }
  }
  private skipFieldOption(): void {
    let depth = 0;
    while (depth > 0 || this.peek() !== "," && this.peek() !== "]") {
      const token = this.take();
      if (["{", "(", "["].includes(token)) depth++;
      if (["}", ")", "]"].includes(token) && --depth < 0) this.fail("Unbalanced field option.");
    }
  }
  private unique(name: string): void {
    if (this.schema.messages.has(name) || this.schema.enums.has(name) || this.schema.services.has(name)) this.fail("Duplicate protobuf symbol " + name + ".");
  }
  private type(): string {
    let value = this.accept(".") ? "." : "";
    value += this.identifier();
    while (this.accept(".")) value += "." + this.identifier();
    return value;
  }
  private identifier(): string {
    const value = this.take();
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value)) this.fail("Expected identifier.");
    return value;
  }
  private number(): number {
    const sign = this.accept("-") ? -1 : 1;
    const text = this.take();
    if (!/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(text)) this.fail("Expected integer.");
    const value = sign * Number(text);
    if (!Number.isSafeInteger(value)) this.fail("Integer out of range.");
    return value;
  }
  private string(): string {
    const value = this.take();
    if (!value.startsWith('"')) this.fail("Expected double-quoted string.");
    try { return JSON.parse(value) as string; } catch { return this.fail("Invalid quoted string."); }
  }
  private peek(): string | undefined { return this.tokens[this.cursor]; }
  private take(): string {
    const value = this.tokens[this.cursor++];
    if (value === undefined) this.fail("Unexpected end of schema.");
    return value!;
  }
  private accept(value: string): boolean { if (this.peek() !== value) return false; this.cursor++; return true; }
  private expect(value: string): void { if (!this.accept(value)) this.fail("Expected " + value + ", got " + String(this.peek()) + "."); }
  private fail(message: string): never { throw new TypeError(this.filename + ": " + message); }
}
function qualify(parent: string, name: string): string { return parent ? parent + "." + name : name; }
