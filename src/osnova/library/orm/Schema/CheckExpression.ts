import { ModelBuildError } from "../errors";
import type { PropertyModel } from "../Metadata/types";

export type CheckScalar = null | boolean | number | string;
export type CheckAst = { readonly kind: "compare"; readonly op: "=" | "<>" | ">" | ">=" | "<" | "<="; readonly left: string; readonly right: string | CheckScalar } | { readonly kind: "in"; readonly left: string; readonly values: readonly CheckScalar[] } | { readonly kind: "null"; readonly left: string; readonly not: boolean } | { readonly kind: "and" | "or"; readonly left: CheckAst; readonly right: CheckAst } | { readonly kind: "not"; readonly inner: CheckAst };
export interface CheckExpression { readonly ast: CheckAst; and(other: CheckExpression): CheckExpression; or(other: CheckExpression): CheckExpression; not(): CheckExpression }
export interface CheckOperand<T = unknown> { eq(value: CheckOperand<T> | T | null): CheckExpression; ne(value: CheckOperand<T> | T | null): CheckExpression; gt(value: CheckOperand<T> | T): CheckExpression; gte(value: CheckOperand<T> | T): CheckExpression; lt(value: CheckOperand<T> | T): CheckExpression; lte(value: CheckOperand<T> | T): CheckExpression; in(values: readonly T[]): CheckExpression; isNull(): CheckExpression; isNotNull(): CheckExpression }
export type CheckField<T extends object> = { readonly [K in Extract<keyof T, string>]-?: CheckOperand<T[K]> };
export type CheckPredicate<T extends object> = (fields: CheckField<T>) => CheckExpression;
const MAX_CHECK_IN_VALUES = 100;
class Expr implements CheckExpression { constructor(readonly ast: CheckAst) {} and(other: CheckExpression) { return new Expr({ kind: "and", left: this.ast, right: other.ast }); } or(other: CheckExpression) { return new Expr({ kind: "or", left: this.ast, right: other.ast }); } not() { return new Expr({ kind: "not", inner: this.ast }); } }
class Field implements CheckOperand { constructor(readonly name: string) {} private compare(op: "=" | "<>" | ">" | ">=" | "<" | "<=", value: unknown) { return new Expr({ kind: "compare", op, left: this.name, right: operand(value) }); } eq(value: unknown) { return this.compare("=", value); } ne(value: unknown) { return this.compare("<>", value); } gt(value: unknown) { return this.compare(">", value); } gte(value: unknown) { return this.compare(">=", value); } lt(value: unknown) { return this.compare("<", value); } lte(value: unknown) { return this.compare("<=", value); } in(values: readonly unknown[]) { if (!values.length || values.length > MAX_CHECK_IN_VALUES) throw new ModelBuildError(`CHECK IN requires between 1 and ${MAX_CHECK_IN_VALUES} literals.`); return new Expr({ kind: "in", left: this.name, values: values.map(literal) }); } isNull() { return new Expr({ kind: "null", left: this.name, not: false }); } isNotNull() { return new Expr({ kind: "null", left: this.name, not: true }); } }
function operand(value: unknown): string | CheckScalar { return value instanceof Field ? `\u0000${value.name}` : literal(value); }
function literal(value: unknown): CheckScalar { if (value === null || typeof value === "boolean") return value; if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) return value; if (typeof value === "string" && value.length <= 1024) return value; throw new ModelBuildError("CHECK literal must be a bounded scalar literal."); }
export function compileCheck<T extends object>(predicate: CheckPredicate<T>): CheckAst { const proxy = new Proxy({}, { get: (_target, name) => typeof name === "string" ? new Field(name) : undefined }) as CheckField<T>; return predicate(proxy).ast; }
/** Projects a property-keyed CHECK AST into a physical identifier domain. */
export function projectCheckAstIdentifiers(ast: CheckAst, resolve: (propertyName: string) => string): CheckAst {
  switch (ast.kind) {
    case "compare": return { ...ast, left: resolve(ast.left), right: typeof ast.right === "string" && ast.right.startsWith("\0") ? `\0${resolve(ast.right.slice(1))}` : ast.right };
    case "in": return { ...ast, left: resolve(ast.left), values: [...ast.values] };
    case "null": return { ...ast, left: resolve(ast.left) };
    case "and": case "or": return { ...ast, left: projectCheckAstIdentifiers(ast.left, resolve), right: projectCheckAstIdentifiers(ast.right, resolve) };
    case "not": return { ...ast, inner: projectCheckAstIdentifiers(ast.inner, resolve) };
  }
}
/** Validates the complete closed AST against the compiled entity columns before DDL/snapshot rendering. */
export function validateCheckAst(ast: CheckAst, properties: readonly PropertyModel[]): void {
  const byName = new Map(properties.map((property) => [property.propertyName, property]));
  const property = (name: string): PropertyModel => {
    const value = byName.get(name);
    if (!value) throw new ModelBuildError(`CHECK references unknown property "${name}".`);
    return value;
  };
  const validateLiteral = (column: PropertyModel, value: CheckScalar): void => {
    if (value === null) throw new ModelBuildError(`CHECK comparison for "${column.propertyName}" must use isNull()/isNotNull().`);
    const compatible = (column.type === "integer" || column.type === "real")
      ? typeof value === "number"
      : (column.type === "text" || column.type === "datetime")
        ? typeof value === "string"
        : column.type === "boolean"
          ? typeof value === "boolean"
          : false;
    if (!compatible) throw new ModelBuildError(`CHECK literal is incompatible with property "${column.propertyName}".`);
  };
  const visit = (node: CheckAst): void => {
    switch (node.kind) {
      case "and": case "or": visit(node.left); visit(node.right); return;
      case "not": visit(node.inner); return;
      case "null": property(node.left); return;
      case "in": {
        const left = property(node.left);
        if (!node.values.length || node.values.length > MAX_CHECK_IN_VALUES) throw new ModelBuildError(`CHECK IN requires between 1 and ${MAX_CHECK_IN_VALUES} literals.`);
        for (const value of node.values) validateLiteral(left, value);
        return;
      }
      case "compare": {
        const left = property(node.left);
        const rightName = typeof node.right === "string" && node.right.startsWith("\0") ? node.right.slice(1) : undefined;
        if (rightName !== undefined) {
          const right = property(rightName);
          if (left.type !== right.type) throw new ModelBuildError(`CHECK column comparison requires identical column types ("${left.propertyName}", "${right.propertyName}").`);
        } else {
          validateLiteral(left, node.right as CheckScalar);
        }
        if ([">", ">=", "<", "<="].includes(node.op) && !["integer", "real", "text", "datetime"].includes(left.type)) {
          throw new ModelBuildError(`CHECK ordered comparison is not supported for property "${left.propertyName}".`);
        }
      }
    }
  };
  visit(ast);
}
export function renderCheck(ast: CheckAst, quote: (name: string) => string): string { switch (ast.kind) { case "compare": return `${quote(ast.left)} ${ast.op} ${typeof ast.right === "string" && ast.right.startsWith("\0") ? quote(ast.right.slice(1)) : sqlLiteral(ast.right as CheckScalar)}`; case "in": return `${quote(ast.left)} IN (${ast.values.map(sqlLiteral).join(", ")})`; case "null": return `${quote(ast.left)} IS ${ast.not ? "NOT " : ""}NULL`; case "and": return `(${renderCheck(ast.left, quote)} AND ${renderCheck(ast.right, quote)})`; case "or": return `(${renderCheck(ast.left, quote)} OR ${renderCheck(ast.right, quote)})`; case "not": return `(NOT ${renderCheck(ast.inner, quote)})`; } }
/** Closed parser for SQL emitted by `renderCheck`; unknown catalog syntax returns undefined. */
export function parseRenderedCheck(value: string): CheckAst | undefined {
  const source = stripOuter(value.trim());
  const logical = splitTopLevel(source, " AND ") ?? splitTopLevel(source, " OR ");
  if (logical) { const left = parseRenderedCheck(logical.left); const right = parseRenderedCheck(logical.right); return left && right ? { kind: logical.operator === " AND " ? "and" : "or", left, right } : undefined; }
  const negated = source.match(/^NOT\s+(.+)$/isu); if (negated) { const inner = parseRenderedCheck(negated[1]!); return inner ? { kind: "not", inner } : undefined; }
  const nullable = source.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/isu); if (nullable) { const left = parseIdentifier(nullable[1]!); return left ? { kind: "null", left, not: Boolean(nullable[2]) } : undefined; }
  const inMatch = source.match(/^(.+?)\s+IN\s*\((.*)\)$/isu); if (inMatch) { const left = parseIdentifier(inMatch[1]!); const values = splitLiterals(inMatch[2]!); return left && values ? { kind: "in", left, values } : undefined; }
  const comparison = source.match(/^(.+?)\s*(=|<>|>=|<=|>|<)\s*(.+)$/su); if (!comparison) return undefined;
  const left = parseIdentifier(comparison[1]!); const right = parseOperand(comparison[3]!);
  return left && right !== undefined ? { kind: "compare", left, op: comparison[2]! as "=" | "<>" | ">" | ">=" | "<" | "<=", right } : undefined;
}
function stripOuter(value: string): string { while (value.startsWith("(") && value.endsWith(")") && balancedOuter(value)) value = value.slice(1, -1).trim(); return value; }
function balancedOuter(value: string): boolean { let depth = 0; let quoted = false; for (let i = 0; i < value.length; i++) { const char = value[i]!; if (char === "'" && value[i - 1] !== "'") quoted = !quoted; if (!quoted) { if (char === "(") depth++; if (char === ")") depth--; if (depth === 0 && i < value.length - 1) return false; } } return depth === 0 && !quoted; }
function splitTopLevel(value: string, separator: " AND " | " OR "): { left: string; right: string; operator: typeof separator } | undefined { let depth = 0; let quoted = false; for (let i = 0; i <= value.length - separator.length; i++) { const char = value[i]!; if (char === "'" && value[i - 1] !== "'") quoted = !quoted; if (!quoted) { if (char === "(") depth++; else if (char === ")") depth--; else if (depth === 0 && value.slice(i, i + separator.length).toUpperCase() === separator) return { left: value.slice(0, i), right: value.slice(i + separator.length), operator: separator }; } } return undefined; }
function parseIdentifier(value: string): string | undefined { const identifier = value.trim(); const quoted = identifier.match(/^"((?:""|[^"])*)"$/u); return quoted ? quoted[1]!.replaceAll('""', '"') : /^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier) ? identifier : undefined; }
function parseOperand(value: string): string | CheckScalar | undefined { const raw = value.trim(); if (/^(TRUE|FALSE)$/i.test(raw)) return /^TRUE$/i.test(raw); const identifier = parseIdentifier(raw); if (identifier) return `\0${identifier}`; return parseLiteral(raw); }
function splitLiterals(value: string): CheckScalar[] | undefined { const parts: string[] = []; let start = 0; let quoted = false; for (let i = 0; i < value.length; i++) { if (value[i] === "'" && value[i - 1] !== "'") quoted = !quoted; if (value[i] === "," && !quoted) { parts.push(value.slice(start, i)); start = i + 1; } } if (quoted) return undefined; parts.push(value.slice(start)); const parsed = parts.map(parseLiteral); return parsed.some((item) => item === undefined) ? undefined : parsed as CheckScalar[]; }
function parseLiteral(value: string): CheckScalar | undefined { const raw = value.trim(); if (/^NULL$/i.test(raw)) return null; if (/^(TRUE|FALSE)$/i.test(raw)) return /^TRUE$/i.test(raw); if (/^-?\d+$/u.test(raw)) return Number(raw); const quoted = raw.match(/^'((?:''|[^'])*)'$/su); return quoted ? quoted[1]!.replaceAll("''", "'") : undefined; }
function sqlLiteral(value: CheckScalar): string { if (value === null) return "NULL"; if (typeof value === "boolean") return value ? "TRUE" : "FALSE"; if (typeof value === "number") return String(value); return `'${value.replaceAll("'", "''")}'`; }
