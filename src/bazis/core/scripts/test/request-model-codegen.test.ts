import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  analyzeRequestModelHydration,
  renderRequestModelShapeRegistrations,
} from "../request-model-codegen";

const PROBE_FILE = "/virtual/nested-request-model-probe.ts";

describe("nested request-model codegen", () => {
  test("analyzes and renders object plus readonly nullable DTO-array shapes", () => {
    const program = programFor(`
      declare function Validator(options: unknown): PropertyDecorator;

      export class ProbeChild {
        value!: string;
      }

      export class ProbeRequest {
        @Validator({ nested: true })
        child!: ProbeChild;

        @Validator({ nested: true })
        children!: readonly (ProbeChild | null)[];
      }
    `);
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(PROBE_FILE)!;
    const child = classNamed(source, "ProbeChild");
    const request = classNamed(source, "ProbeRequest");

    const hydration = analyzeRequestModelHydration({
      checker,
      roots: [request],
      requiredRoots: [request],
      isProjectDeclaration: () => true,
      isExcludedDeclaration: () => false,
      isNamedExportedTopLevelClass: isNamedExport,
      sourcePathForDeclaration: (declaration) => declaration.getSourceFile().fileName,
      sourceLocation: (node) => `${node.getSourceFile().fileName}:1`,
    });

    expect(hydration.errors).toEqual([]);
    expect(hydration.declarations).toEqual([child, request]);
    expect(hydration.fields.get(request)?.map((field) => ({
      property: field.property,
      model: field.model?.name?.text,
      array: field.array,
      nullable: field.nullable,
      elementNullable: field.elementNullable,
    }))).toEqual([
      { property: "child", model: "ProbeChild", array: false, nullable: false, elementNullable: false },
      { property: "children", model: "ProbeChild", array: true, nullable: false, elementNullable: true },
    ]);

    const aliases = new Map<ts.ClassDeclaration, string>([
      [child, "RequestModel_0"],
      [request, "RequestModel_1"],
    ]);
    expect(renderRequestModelShapeRegistrations(hydration, (declaration) => aliases.get(declaration))).toEqual([
      "registerRequestModelShape(RequestModel_0, {",
      '  "value": { primitive: "string" },',
      "});",
      "registerRequestModelShape(RequestModel_1, {",
      '  "child": { model: RequestModel_0 },',
      '  "children": { model: RequestModel_0, array: true, elementNullable: true },',
      "});",
    ]);
  });

  test("records exactly string, number and boolean fields; leaves other types unchecked", () => {
    const program = programFor(`
      enum Color { Red = "red" }
      export class PrimitiveRequest {
        name!: string;
        count?: number;
        done!: boolean | null;
        tags!: readonly string[];
        scores!: (number | null)[] | null;
        mode!: "a" | "b";
        color!: Color;
        when!: Date;
        pair!: [string, number];
        mixed!: string | number;
        any!: unknown;
        private secret = "";
        static version = "";
      }
      class HiddenRequest {
        name!: string;
      }
      export class Holder {
        hidden!: HiddenRequest;
      }
    `);
    const source = program.getSourceFile(PROBE_FILE)!;
    const request = classNamed(source, "PrimitiveRequest");
    const hidden = classNamed(source, "HiddenRequest");
    const hydration = analyzeRequestModelHydration({
      checker: program.getTypeChecker(),
      roots: [request, hidden],
      isProjectDeclaration: () => true,
      isExcludedDeclaration: () => false,
      isNamedExportedTopLevelClass: isNamedExport,
      sourcePathForDeclaration: (declaration) => declaration.getSourceFile().fileName,
      sourceLocation: (node) => `${node.getSourceFile().fileName}:1`,
    });

    expect(hydration.errors).toEqual([]);
    expect(hydration.fields.get(request)).toEqual([
      { property: "count", primitive: "number", array: false, nullable: false, elementNullable: false },
      { property: "done", primitive: "boolean", array: false, nullable: true, elementNullable: false },
      { property: "name", primitive: "string", array: false, nullable: false, elementNullable: false },
      { property: "scores", primitive: "number", array: true, nullable: true, elementNullable: true },
      { property: "tags", primitive: "string", array: true, nullable: false, elementNullable: false },
    ]);
    // Not importable by generated code: binding stays as before, no new error.
    expect(hydration.fields.get(hidden)).toBeUndefined();
    expect(hydration.declarations).toEqual([request]);
  });

  test("fails closed for an explicit nested union of multiple DTO classes", () => {
    const program = programFor(`
      declare function Validator(options: unknown): PropertyDecorator;
      export class LeftDto {}
      export class RightDto {}
      export class UnionRequest {
        @Validator({ nested: true })
        value!: LeftDto | RightDto;
      }
    `);
    const source = program.getSourceFile(PROBE_FILE)!;
    const request = classNamed(source, "UnionRequest");
    const hydration = analyzeRequestModelHydration({
      checker: program.getTypeChecker(),
      roots: [request],
      requiredRoots: [request],
      isProjectDeclaration: () => true,
      isExcludedDeclaration: () => false,
      isNamedExportedTopLevelClass: isNamedExport,
      sourcePathForDeclaration: (declaration) => declaration.getSourceFile().fileName,
      sourceLocation: () => `${PROBE_FILE}:1`,
    });

    expect(hydration.errors).toHaveLength(1);
    expect(hydration.errors[0]).toContain("must have one concrete class type");
  });
});

function programFor(content: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noEmit: true,
  };
  const source = ts.createSourceFile(PROBE_FILE, content, options.target!, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost(options);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => fileName === PROBE_FILE || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => fileName === PROBE_FILE ? content : ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === PROBE_FILE
      ? source
      : defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  return ts.createProgram([PROBE_FILE], options, host);
}

function classNamed(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  const declaration = source.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === name,
  );
  if (declaration === undefined) {
    throw new Error(`Missing test class ${name}`);
  }
  return declaration;
}

function isNamedExport(declaration: ts.ClassDeclaration): boolean {
  return ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
