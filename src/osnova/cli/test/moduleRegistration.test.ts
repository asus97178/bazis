import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { registerModuleInSource } from "../moduleRegistration";

const app = "/project/src/host/App.module.ts";
const feature = "/project/src/features/task/Task.module.ts";
const update = (content: string) => registerModuleInSource(content, app, feature, "TaskModule");

function assertValid(content: string): void {
  expect(ts.transpileModule(content, { fileName: app, reportDiagnostics: true }).diagnostics).toEqual([]);
  const source = ts.createSourceFile(app, content, ts.ScriptTarget.Latest, true);
  const omitted: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isOmittedExpression(node)) omitted.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(omitted).toHaveLength(0);
}

describe("host registration", () => {
  test.each(["[]", "[Other]", "[Other,]", "[Other, /* ] keep */]", "[\n  Other, // ] keep\n]", "[\n  Other // keep\n]"])("handles commas and comments in %s", (array) => {
    const content = `import { Module } from "@osnova/core/di";\nconst Other = class {};\n@Module({ imports: ${array} })\nexport class AppModule {}\n`;
    const result = update(content);
    assertValid(result);
    expect(result).toContain('from "../features/task/Task.module"');
    expect(result.match(/\bTaskModule\b/g)).toHaveLength(2);
    expect(update(result)).toBe(result);
    if (array.includes("keep")) expect(result).toContain(array.includes("/*") ? "/* ] keep */" : "//");
  });

  test("uses the imported class alias and completes missing metadata registration", () => {
    const content = 'import { Module as Feature } from "@osnova/core/di";\nimport {\n TaskModule as Tasks\n} from "../features/task/Task.module";\n@Feature({ imports: [] })\nexport class AppModule {}';
    const result = update(content);
    expect(result).toContain("imports: [Tasks]");
    expect(result.match(/TaskModule/g)).toHaveLength(1);
    assertValid(result);
  });

  test("ignores unrelated imports arrays and mentions in comments", () => {
    const content = 'import * as di from "@osnova/core/di";\nconst unrelated = { imports: [] };\n// TaskModule is planned\n@di.Module({ exports: [] })\nexport class AppModule {}';
    const result = update(content);
    expect(result).toContain("const unrelated = { imports: [] }");
    expect(result).toContain("// TaskModule is planned");
    expect(result).toContain("imports: [TaskModule]");
    assertValid(result);
  });

  test("supports multiline imports without semicolons and preserves CRLF", () => {
    const content = 'import {\r\n Module\r\n} from "@osnova/core/di"\r\n\r\n@Module({\r\n exports: [],\r\n})\r\nexport class AppModule {}\r\n';
    const result = update(content);
    expect(result.replaceAll("\r\n", "")).not.toContain("\n");
    assertValid(result);
  });

  test.each([
    '@Module({imports: modules}) class AppModule {}',
    '@Module({...options, imports: []}) class AppModule {}',
    '@Module({[field]: [], imports: []}) class AppModule {}',
    '@Module({imports: [Other,,]}) class AppModule {}',
    '@Module({imports: [], imports: []}) class AppModule {}',
    '@Module({}) class First {}\n@Module({}) class Second {}',
    'const TaskModule = class {};\n@Module({imports: []}) class AppModule {}',
    'import type { TaskModule } from "../features/task/Task.module";\n@Module({imports: []}) class AppModule {}',
  ])("rejects unsafe automatic registration: %s", (content) => {
    expect(() => update(content)).toThrow();
  });
});
