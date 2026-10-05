import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";
import { analyzeOrmPredicates } from "../orm-predicate-codegen";

function analyze(body: string) {
  const file = path.resolve("src/orm-predicate-probe.ts");
  const content = `import type { FieldSelector, PredicateFn } from "./osnv/library/orm/Query/conditions";
interface User { tenantId: string; age: number; name: string | null; active: boolean; createdAt: Date; }
declare const u: FieldSelector<User>;
${body}`;
  const options: ts.CompilerOptions = { strict: true, skipLibCheck: true, noEmit: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => name === file
    ? ts.createSourceFile(file, content, options.target!, true) : read(name, ...args);
  const program = ts.createProgram([file], options, host);
  return {
    logic: analyzeOrmPredicates(program.getTypeChecker(), program.getSourceFile(file)!),
    types: ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  };
}

test("ORM fields retain value types and operator restrictions", () => {
  const result = analyze(`
u.age.eq(18); u.age.in([18, 20]); u.name.eq(null); u.name.contains("Ann");
u.createdAt.gte(new Date()); u.active.eq(true);
// @ts-expect-error numeric fields reject text equality
u.age.eq("eighteen");
// @ts-expect-error numeric fields reject text operators
u.age.contains("18");
// @ts-expect-error the list has the field's value type
u.age.in(["18"]);
// @ts-expect-error ordered comparison is not defined for booleans
u.active.gt(true);
// @ts-expect-error non-nullable fields reject null equality
u.age.eq(null);
`);
  expect(result.types).toEqual([]);
  expect(result.logic).toEqual([]);
});

test("ORM truthiness is diagnosed for inline and named predicates", () => {
  const result = analyze(`
const unsafe: PredicateFn<User> = x => x.tenantId.eq("a") && x.age.gte(18);
const choice = u.name.eq("Ann") || u.age.gte(18);
const negated = !u.active.eq(true);
const conditional = u.active.eq(true) ? u.age.gt(20) : u.age.lt(20);
if (u.active.eq(true)) { console.log("unsafe"); }
`);
  expect(result.types).toEqual([]);
  expect(result.logic).toHaveLength(5);
  expect(result.logic.every(message => message.includes("OSNV_ORM_PREDICATE_LOGIC") && message.includes(".and()"))).toBe(true);
});

test("explicit ORM combinators and ordinary boolean logic stay valid", () => {
  const result = analyze(`
const safe: PredicateFn<User> = x => x.tenantId.eq("a").and(x.age.gte(18)).or(x.name.isNull()).not();
const enabled = true;
const chosen: PredicateFn<User> = x => enabled ? x.age.gte(18) : x.age.lt(18);
if (enabled && Math.random() > 0.5) console.log("ordinary logic");
class Predicate { value = true; }
const ordinary = new Predicate() && new Predicate();
`);
  expect(result.types).toEqual([]);
  expect(result.logic).toEqual([]);
});
