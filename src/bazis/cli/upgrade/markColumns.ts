import ts from "typescript";

/** What {@link markColumns} did to one file. */
export interface MarkColumnsResult {
  readonly text: string;
  /** Columns that got `@Nullable()`. */
  readonly nullable: number;
  /** Columns that got `@Required()`. */
  readonly required: number;
  /** What needs a look: options not written in place, a mark that could not be imported. */
  readonly skipped: readonly string[];
}

/** Decorators of a field that make it a column. */
const COLUMN_DECORATORS = new Set(["Column", "Index", "ForeignKey", "HasConversion"]);
/** Decorators that make a column NOT NULL whatever else is said. */
const ALWAYS_REQUIRED = new Set(["Key", "UUID", "CreatedAt", "UpdatedAt"]);
/** A `uuid` column is NOT NULL only as a key; as a plain column it was nullable. */
const REQUIRED_TYPES = new Set(["createdAt", "updatedAt"]);
/** Names an ORM import is recognised by. */
const ORM_NAMES = new Set(["Column", "Entity", "Index", "Key", "UUID", "ForeignKey"]);

interface Edit { readonly start: number; readonly end: number; readonly text: string }

function decoratorCall(decorator: ts.Decorator): { readonly name: string; readonly call: ts.CallExpression } | undefined {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
  return { name: expression.expression.text, call: expression };
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  const name = node.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

/**
 * Brings the entities of a file to 0.137.0, where every column says whether it
 * may be empty: `@Required()` or `@Nullable()`. A column gets the mark of what it
 * was, so the schema of the application stays as it is: `@Nullable()` for one
 * that allowed NULL by silence or by `nullable: true`, `@Required()` for
 * `nullable: false`. The `nullable` option, which no longer exists, is removed.
 * Keys and timestamps are left alone: they were always NOT NULL. Works on the
 * text of one file and changes nothing else in it.
 */
export function markColumns(source: string, fileName = "file.ts"): MarkColumnsResult {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const skipped: string[] = [];
  const marks = { Nullable: 0, Required: 0 };

  /** `, nullable: true` out of the options; an object left empty goes away whole. */
  const dropOption = (options: ts.ObjectLiteralExpression, index: number): void => {
    const property = options.properties[index]!;
    if (options.properties.length === 1) {
      edits.push({ start: options.getStart(file), end: options.end, text: "" });
    } else if (index > 0) {
      edits.push({ start: options.properties[index - 1]!.end, end: property.end, text: "" });
    } else {
      edits.push({ start: property.getStart(file), end: options.properties[1]!.getStart(file), text: "" });
    }
  };

  /** The mark before a decorator: on its own line when the decorator has one. */
  const addMark = (mark: "Nullable" | "Required", before: ts.Decorator): void => {
    const start = before.getStart(file);
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const indent = source.slice(lineStart, start);
    const ownLine = /^[ \t]*$/.test(indent) && /^[ \t]*\r?\n/.test(source.slice(before.end));
    edits.push({ start, end: start, text: ownLine ? `@${mark}()\n${indent}` : `@${mark}() ` });
    marks[mark] += 1;
  };

  const visitClass = (node: ts.ClassLikeDeclaration): void => {
    // `@Key(["shopId", "code"])` on the class: these properties are the key.
    const keyed = new Set<string>();
    for (const decorator of ts.getDecorators(node) ?? []) {
      const found = decoratorCall(decorator);
      const list = found?.name === "Key" ? found.call.arguments[0] : undefined;
      if (list && ts.isArrayLiteralExpression(list)) for (const item of list.elements) if (ts.isStringLiteralLike(item)) keyed.add(item.text);
    }
    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member)) continue;
      const decorators = (ts.getDecorators(member) ?? []).map((decorator) => ({ decorator, found: decoratorCall(decorator) }));
      const has = (name: string) => decorators.some(({ found }) => found?.name === name);
      const anchor = decorators.find(({ found }) => found?.name === "Column") ?? decorators.find(({ found }) => found !== undefined && COLUMN_DECORATORS.has(found.name));
      if (!anchor?.found) continue;
      const name = member.name.getText(file);
      const where = `${fileName}: ${node.name?.text ?? "class"}.${name}`;

      const column = decorators.find(({ found }) => found?.name === "Column")?.found?.call;
      const options = column?.arguments[0];
      let declared: boolean | undefined;
      let type: string | undefined;
      if (options !== undefined) {
        if (!ts.isObjectLiteralExpression(options) || options.properties.some(ts.isSpreadAssignment)) {
          skipped.push(`${where}: the options of @Column are not written in place; mark the column @Required() or @Nullable() by hand`);
          continue;
        }
        const typeProperty = options.properties.find((property) => propertyName(property) === "type");
        if (typeProperty && ts.isPropertyAssignment(typeProperty) && ts.isStringLiteralLike(typeProperty.initializer)) type = typeProperty.initializer.text;
        const index = options.properties.findIndex((property) => propertyName(property) === "nullable");
        if (index >= 0) {
          const property = options.properties[index]!;
          const value = ts.isPropertyAssignment(property) ? property.initializer.kind : undefined;
          if (value !== ts.SyntaxKind.TrueKeyword && value !== ts.SyntaxKind.FalseKeyword) {
            skipped.push(`${where}: nullable is not true or false here; mark the column @Required() or @Nullable() by hand`);
            continue;
          }
          declared = value === ts.SyntaxKind.TrueKeyword;
          dropOption(options, index);
        }
      }

      // A soft-delete column is nullable by its own decorator; keys and timestamps are always NOT NULL.
      if (has("SoftDelete") || keyed.has(name) || decorators.some(({ found }) => found !== undefined && ALWAYS_REQUIRED.has(found.name)) || (type !== undefined && REQUIRED_TYPES.has(type))) continue;
      if (has("Required") || has("Nullable")) continue;
      addMark(declared === false ? "Required" : "Nullable", anchor.decorator);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node)) visitClass(node);
    ts.forEachChild(node, visit);
  };
  visit(file);

  const wanted = (["Nullable", "Required"] as const).filter((mark) => marks[mark] > 0);
  if (wanted.length > 0) {
    const problem = importEdits(file, wanted, edits);
    if (problem !== undefined) skipped.push(`${fileName}: ${problem}`);
  }
  let text = source;
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { text, nullable: marks.Nullable, required: marks.Required, skipped };
}

/** The marks join the import the other ORM decorators of the file come from. */
function importEdits(file: ts.SourceFile, marks: readonly string[], edits: Edit[]): string | undefined {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const names = new Set(bindings.elements.map((element) => (element.propertyName ?? element.name).text));
    if (![...names].some((name) => ORM_NAMES.has(name))) continue;
    const missing = marks.filter((mark) => !names.has(mark));
    const last = bindings.elements.at(-1);
    if (missing.length > 0 && last) edits.push({ start: last.end, end: last.end, text: `, ${missing.join(", ")}` });
    return undefined;
  }
  return `import ${marks.join(" and ")} from the ORM by hand: the file has no import of its decorators to add them to`;
}
