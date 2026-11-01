import { expect, test } from "bun:test";
import ts from "typescript";
import { createOpenApiCodegenAnalyzer } from "../codegen";

test("OpenAPI follows imported DTO base classes and keeps inherited validation", () => {
  const texts = new Map([
    ["/virtual/base.ts", `export class Fields {
      @Validator({ required: true, minLength: 1, maxLength: 120 }) name!: string;
      @Validator({ maxLength: 2000 }) description = "";
      toolNames: string[] = [];
      private internal = "hidden";
    }
    export class CreateInput extends Fields {
      @Validator({ required: true, pattern: "^[a-z]+$" }) id!: string;
    }`],
    ["/virtual/http.ts", `import { CreateInput as Input } from "./base";
      export class CreateRequest extends Input {}
      export interface BaseResponse { id: string; }
      export interface Response extends BaseResponse { name: string; }
    `],
  ]);
  const options: ts.CompilerOptions = { noLib: true, target: ts.ScriptTarget.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.fileExists = file => texts.has(file);
  host.readFile = file => texts.get(file);
  host.directoryExists = directory => directory === "/virtual" || directory === "/";
  host.getSourceFile = (file, languageVersion) => texts.has(file) ? ts.createSourceFile(file, texts.get(file)!, languageVersion, true) : undefined;
  const program = ts.createProgram([...texts.keys()], options, host);
  const analyzer = createOpenApiCodegenAnalyzer({ checker: program.getTypeChecker(), sourceFiles: program.getSourceFiles() });
  const source = program.getSourceFile("/virtual/http.ts")!;
  const request = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "CreateRequest") as ts.ClassDeclaration;
  expect(analyzer.schemaFromDeclaration(request)).toEqual({
    type: "object", required: ["id", "name"], properties: {
      id: { type: "string", pattern: "^[a-z]+$" },
      name: { type: "string", minLength: 1, maxLength: 120 },
      description: { type: "string", maxLength: 2000 },
      toolNames: { type: "array", items: { type: "string" } },
    },
  });
  const response = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === "Response") as ts.InterfaceDeclaration;
  expect(analyzer.schemaFromDeclaration(response)).toMatchObject({ required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } });
});

test("references of a Tool input go to the schema as x-ref", () => {
  const text = `export class RecordUpdate {
    @Validator({ required: true, ref: "dm.table" }) table!: string;
    @Validator({ refKeys: "dm.field", refScope: "/table" }) values: Record<string, unknown> = {};
    /** Whose record. */
    @Validator({ ref: "dm.field", refScope: "/table" }) owner = "";
  }`;
  const options: ts.CompilerOptions = { noLib: true, target: ts.ScriptTarget.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.fileExists = file => file === "/virtual/input.ts";
  host.readFile = file => file === "/virtual/input.ts" ? text : undefined;
  host.getSourceFile = (file, languageVersion) => file === "/virtual/input.ts" ? ts.createSourceFile(file, text, languageVersion, true) : undefined;
  const program = ts.createProgram(["/virtual/input.ts"], options, host);
  const analyzer = createOpenApiCodegenAnalyzer({ checker: program.getTypeChecker(), sourceFiles: program.getSourceFiles() });
  const input = program.getSourceFile("/virtual/input.ts")!.statements[0] as ts.ClassDeclaration;
  expect(analyzer.schemaFromDeclaration(input)).toMatchObject({
    required: ["table"],
    properties: {
      table: { type: "string", "x-ref": "dm.table" },
      values: { "x-ref-keys": "dm.field", "x-ref-scope": "/table" },
      owner: { "x-ref": "dm.field", "x-ref-scope": "/table" },
    },
  });
});
