import ts from "typescript";

export interface ToolCodegenSource {
  readonly filePath: string;
  /** Program-owned AST; codegen never reparses application source. */
  readonly sourceFile?: ts.SourceFile;
  /** Test fixture input; project generation always supplies sourceFile. */
  readonly content?: string;
}

export interface ToolCodegenResult {
  readonly warnings: readonly string[];
  readonly toolCount: number;
  /** `input`/`output` classes of `@Tool` declarations: they get JSON schemas in the OpenAPI registry. */
  readonly schemaNames: readonly string[];
  /** Program-owned declarations of those classes, for nominal schema bindings. */
  readonly schemaModels: readonly ts.ClassDeclaration[];
}

export interface ToolCodegenOptions {
  /** Use the same naming policy as the project's OpenAPI analyzer. */
  readonly schemaNameForDeclaration?: (name: string, declaration: ts.ClassDeclaration) => string;
}

/**
 * Finds `@Tool({ input, output })` classes. Tool metadata itself is read at
 * runtime from the decorator; codegen only makes sure the contract classes
 * have generated JSON schemas for the model and for validation.
 */
export function collectToolSchemaModels(
  sources: readonly ToolCodegenSource[],
  options: ToolCodegenOptions = {},
): ToolCodegenResult {
  const warnings: string[] = [];
  const declarations = new Map<string, ts.ClassDeclaration>();
  const files = new Map<string, string>();
  const ambiguous = new Set<string>();
  const parsed = sources.map((source) =>
    source.sourceFile ?? ts.createSourceFile(source.filePath, source.content ?? "", ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS));

  for (const source of parsed) {
    visitClasses(source, (node) => {
      const name = node.name!.text;
      const existing = files.get(name);
      if (existing === undefined) files.set(name, source.fileName);
      else if (existing !== source.fileName) ambiguous.add(name);
      declarations.set(name, node);
    });
  }

  const contractNames = new Set<string>();
  let toolCount = 0;
  for (const source of parsed) {
    visitClasses(source, (node) => {
      const call = toolDecoratorCall(node);
      if (call === undefined) return;
      const className = node.name!.text;
      const where = sourceLocation(source, node);
      if (!isNamedExportedClass(node)) {
        warnings.push(`@Tool class "${className}" (${where}) is not a named export; codegen can only import named-export classes.`);
        return;
      }
      toolCount += 1;
      const options = call.arguments[0];
      if (options === undefined || !ts.isObjectLiteralExpression(options)) return;
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
        if (key !== "input" && key !== "output") continue;
        if (!ts.isIdentifier(property.initializer)) {
          warnings.push(`@Tool ${className} (${where}): ${key} must be a class identifier.`);
          continue;
        }
        const contract = property.initializer.text;
        if (ambiguous.has(contract)) {
          warnings.push(`@Tool ${className} (${where}): ${key} class "${contract}" is declared in more than one file.`);
          continue;
        }
        contractNames.add(contract);
      }
    });
  }

  const schemaModels = [...contractNames]
    .map((name) => declarations.get(name))
    .filter((declaration): declaration is ts.ClassDeclaration => declaration !== undefined);
  return {
    warnings: Object.freeze(warnings),
    toolCount,
    schemaNames: Object.freeze(schemaModels
      .map((declaration) => options.schemaNameForDeclaration?.(declaration.name!.text, declaration) ?? declaration.name!.text)
      .sort((left, right) => left.localeCompare(right))),
    schemaModels: Object.freeze(schemaModels),
  };
}

function visitClasses(source: ts.SourceFile, onClass: (node: ts.ClassDeclaration) => void): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) onClass(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function toolDecoratorCall(node: ts.ClassDeclaration): ts.CallExpression | undefined {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const expression = decorator.expression;
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "Tool") return expression;
  }
  return undefined;
}

function isNamedExportedClass(node: ts.ClassDeclaration): boolean {
  const modifiers = ts.getModifiers(node) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    && !modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function sourceLocation(source: ts.SourceFile, node: ts.Node): string {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${source.fileName}:${position.line + 1}:${position.character + 1}`;
}
