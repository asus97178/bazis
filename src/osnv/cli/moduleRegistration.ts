import path from "node:path";
import ts from "typescript";

interface Edit { readonly at: number; readonly text: string }

export function moduleImportPath(fromFile: string, moduleFile: string): string {
  const relative = path.relative(path.dirname(fromFile), moduleFile).split(path.sep).join("/").replace(/\.ts$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** Edits only the import and the selected @Module metadata, preserving other source text. */
export function registerModuleInSource(content: string, appFile: string, moduleFile: string, moduleClass: string): string {
  const diagnostics = ts.transpileModule(content, { fileName: appFile, reportDiagnostics: true }).diagnostics ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error(`Cannot register a module in invalid TypeScript: ${appFile}`);
  }
  const source = ts.createSourceFile(appFile, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importPath = moduleImportPath(appFile, moduleFile);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const imports = source.statements.filter(ts.isImportDeclaration);
  const decoratorNames = new Set(["Module"]);
  const decoratorNamespaces = new Set<string>();
  let binding = moduleClass;
  let imported = false;
  const otherBindings = new Set<string>();
  for (const declaration of imports) {
    const clause = declaration.importClause;
    if (!clause || !ts.isStringLiteral(declaration.moduleSpecifier)) continue;
    const specifier = declaration.moduleSpecifier.text;
    const isDI = /(?:osnv|osnv|@)\/core\/di$/.test(specifier);
    if (clause.name) otherBindings.add(clause.name.text);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      otherBindings.add(named.name.text);
      if (isDI) decoratorNamespaces.add(named.name.text);
    }
    if (!named || !ts.isNamedImports(named)) continue;
    for (const item of named.elements) {
      const exported = item.propertyName?.text ?? item.name.text;
      if (isDI && exported === "Module") decoratorNames.add(item.name.text);
      const sameFile = specifier.startsWith(".") && path.resolve(path.dirname(appFile), specifier.replace(/\.(?:ts|js)$/, "")) === moduleFile.replace(/\.ts$/, "");
      if (sameFile && exported === moduleClass) {
        if (clause.isTypeOnly || item.isTypeOnly) throw new Error(`${moduleClass} has a type-only import; use a value import before registration.`);
        binding = item.name.text;
        imported = true;
      } else {
        otherBindings.add(item.name.text);
      }
    }
  }
  for (const statement of source.statements) {
    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      otherBindings.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) otherBindings.add(declaration.name.text);
      }
    }
  }
  if (otherBindings.has(binding)) throw new Error(`Cannot register ${moduleClass}: local name ${binding} is already in use.`);

  const candidates: { name?: string; metadata: ts.ObjectLiteralExpression }[] = [];
  for (const statement of source.statements.filter(ts.isClassDeclaration)) {
    for (const decorator of ts.getDecorators(statement) ?? []) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call)) continue;
      const expression = call.expression;
      const isModule = (ts.isIdentifier(expression) && decoratorNames.has(expression.text))
        || (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
          && decoratorNamespaces.has(expression.expression.text) && expression.name.text === "Module");
      if (!isModule) continue;
      const metadata = call.arguments[0];
      if (!metadata || !ts.isObjectLiteralExpression(metadata)) throw new Error("@Module metadata must be an object literal for automatic registration.");
      candidates.push({ name: statement.name?.text, metadata });
    }
  }
  const candidate = candidates.find((item) => item.name === "AppModule") ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!candidate) throw new Error("Could not select a unique @Module class for registration in App.module.ts.");
  const metadata = candidate.metadata;
  if (metadata.properties.some(ts.isSpreadAssignment)) throw new Error("Automatic registration does not support spread @Module metadata; register the module explicitly.");
  if (metadata.properties.some((property) => property.name && ts.isComputedPropertyName(property.name))) throw new Error("Automatic registration does not support computed @Module properties; register the module explicitly.");
  const importProperties = metadata.properties.filter((property) => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "imports");
  if (importProperties.length > 1) throw new Error("Duplicate imports properties in @Module metadata.");
  const property = importProperties[0];
  const edits: Edit[] = [];
  if (property) {
    if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) {
      throw new Error("@Module imports must be an array literal for automatic registration.");
    }
    const array = property.initializer;
    if (array.elements.some(ts.isOmittedExpression)) throw new Error("@Module imports contains an empty element; fix the array before registration.");
    if (!array.elements.some((element) => ts.isIdentifier(element) && element.text === binding)) {
      appendMember(content, array, array.elements, binding, edits, eol);
    }
  } else {
    appendMember(content, metadata, metadata.properties, `imports: [${binding}]`, edits, eol);
  }
  if (!imported) {
    const lastImport = imports.at(-1);
    const end = lastImport?.end ?? 0;
    const nextLine = content.indexOf("\n", end);
    const hasLineEnd = lastImport && nextLine >= 0 && /^\s*(?:\/\/.*)?$/.test(content.slice(end, nextLine));
    const at = hasLineEnd ? nextLine + 1 : end;
    edits.push({ at, text: `${at > 0 && content[at - 1] !== "\n" ? eol : ""}import { ${moduleClass} } from "${importPath}";${eol}` });
  }
  return edits.reverse().sort((left, right) => right.at - left.at).reduce((text, edit) => text.slice(0, edit.at) + edit.text + text.slice(edit.at), content);
}

function appendMember(content: string, node: ts.Node, members: ts.NodeArray<ts.Node>, member: string, edits: Edit[], eol: string): void {
  const close = node.end - 1;
  const last = members.at(-1);
  if (last && !members.hasTrailingComma) edits.push({ at: last.end, text: "," });
  const inner = content.slice(node.getStart() + 1, close);
  if (!inner.includes("\n")) {
    edits.push({ at: close, text: `${last || inner.trim() ? " " : ""}${member}${members.hasTrailingComma ? "," : ""}` });
    return;
  }
  const lineStart = content.lastIndexOf("\n", close) + 1;
  const closingIndent = content.slice(lineStart, close);
  if (/^\s*$/.test(closingIndent)) {
    edits.push({ at: lineStart, text: `${closingIndent}  ${member},${eol}` });
  } else {
    const indent = content.slice(content.lastIndexOf("\n", node.getStart()) + 1, node.getStart()).match(/^\s*/)?.[0] ?? "";
    edits.push({ at: close, text: `${eol}${indent}  ${member},${eol}${indent}` });
  }
}
