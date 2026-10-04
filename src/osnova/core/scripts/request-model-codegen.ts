import ts from "typescript";

export interface RequestModelHydrationField {
  readonly property: string;
  readonly model: ts.ClassDeclaration;
  readonly array: boolean;
  readonly nullable: boolean;
  readonly elementNullable: boolean;
}

export interface RequestModelHydration {
  readonly declarations: readonly ts.ClassDeclaration[];
  readonly fields: ReadonlyMap<ts.ClassDeclaration, readonly RequestModelHydrationField[]>;
  readonly errors: readonly string[];
}

export interface RequestModelHydrationAnalyzerOptions {
  readonly checker: ts.TypeChecker;
  /** Every class whose transitive request shape should be inspected. */
  readonly roots: readonly ts.ClassDeclaration[];
  /** Roots that must be imported even when they have no nested fields. */
  readonly requiredRoots?: readonly ts.ClassDeclaration[];
  readonly isProjectDeclaration: (declaration: ts.ClassDeclaration) => boolean;
  readonly isExcludedDeclaration: (declaration: ts.ClassDeclaration) => boolean;
  readonly isNamedExportedTopLevelClass: (declaration: ts.ClassDeclaration) => boolean;
  readonly sourcePathForDeclaration: (declaration: ts.ClassDeclaration) => string;
  readonly sourceLocation: (node: ts.Node) => string;
}

interface UnwrappedModelType {
  readonly model?: ts.ClassDeclaration;
  readonly array: boolean;
  readonly nullable: boolean;
  readonly elementNullable: boolean;
  readonly ambiguous: boolean;
}

/**
 * Pure TypeScript-source analyzer for generated nested request DTO hydration.
 * It has no filesystem/global-generator state and is therefore directly
 * regression-testable without introducing app fixtures.
 */
export function analyzeRequestModelHydration(
  options: RequestModelHydrationAnalyzerOptions,
): RequestModelHydration {
  const { checker } = options;
  const queue = [...new Set(options.roots)];
  const visited = new Set<ts.ClassDeclaration>();
  const requiredDeclarations = new Set<ts.ClassDeclaration>(options.requiredRoots ?? []);
  const fields = new Map<ts.ClassDeclaration, RequestModelHydrationField[]>();
  const errors: string[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const owner = queue[index] as ts.ClassDeclaration;
    if (visited.has(owner)) {
      continue;
    }
    visited.add(owner);

    const ownerFields: RequestModelHydrationField[] = [];
    for (const member of owner.members) {
      if (
        !ts.isPropertyDeclaration(member) ||
        !ts.isIdentifier(member.name) ||
        hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
        hasModifier(member, ts.SyntaxKind.PrivateKeyword)
      ) {
        continue;
      }
      const nested = modelTypeForProperty(checker, member);
      const explicitNested = hasExplicitNestedValidator(member);
      if (nested.model === undefined) {
        if (explicitNested && nested.ambiguous) {
          errors.push(
            `${options.sourceLocation(member)}: @Validator({ nested: true }) field "${member.name.text}" ` +
              `must have one concrete class type or class-array element type so HTTP binding can hydrate it safely.`,
          );
        }
        continue;
      }
      if (!options.isProjectDeclaration(nested.model)) {
        if (explicitNested) {
          errors.push(
            `${options.sourceLocation(member)}: nested request model "${nested.model.name?.text ?? "<anonymous>"}" ` +
              `is not declared in project source and cannot be hydrated by Osnova codegen.`,
          );
        }
        continue;
      }
      if (options.isExcludedDeclaration(nested.model)) {
        errors.push(
          `${options.sourceLocation(member)}: nested request model "${nested.model.name?.text ?? "<anonymous>"}" ` +
            `belongs to an excluded source layer and cannot be imported into generated runtime metadata.`,
        );
        continue;
      }
      ownerFields.push({
        property: member.name.text,
        model: nested.model,
        array: nested.array,
        nullable: nested.nullable,
        elementNullable: nested.elementNullable,
      });
      requiredDeclarations.add(owner);
      requiredDeclarations.add(nested.model);
      queue.push(nested.model);
    }
    if (ownerFields.length > 0) {
      ownerFields.sort((left, right) => left.property.localeCompare(right.property));
      fields.set(owner, ownerFields);
    }

    for (const clause of owner.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
        continue;
      }
      for (const baseType of clause.types) {
        const base = classDeclarationForExpression(checker, baseType.expression);
        if (base !== undefined && !options.isExcludedDeclaration(base)) {
          queue.push(base);
        }
      }
    }
  }

  for (const declaration of requiredDeclarations) {
    if (!options.isNamedExportedTopLevelClass(declaration)) {
      errors.push(
        `${options.sourceLocation(declaration)}: request model "${declaration.name?.text ?? "<anonymous>"}" must be a named ` +
          `top-level export so generated nested DTO hydration metadata can import it.`,
      );
    }
  }

  const declarations = [...requiredDeclarations].sort((left, right) => {
    const byFile = options.sourcePathForDeclaration(left).localeCompare(options.sourcePathForDeclaration(right));
    return byFile !== 0 ? byFile : (left.name?.text ?? "").localeCompare(right.name?.text ?? "");
  });
  return { declarations, fields, errors };
}

/** Renders only the generated `registerRequestModelShape(...)` calls. */
export function renderRequestModelShapeRegistrations(
  hydration: Pick<RequestModelHydration, "declarations" | "fields">,
  aliasFor: (declaration: ts.ClassDeclaration) => string | undefined,
): string[] {
  const lines: string[] = [];
  for (const owner of hydration.declarations) {
    const ownerFields = hydration.fields.get(owner);
    const ownerAlias = aliasFor(owner);
    if (ownerFields === undefined || ownerFields.length === 0 || ownerAlias === undefined) {
      continue;
    }
    lines.push(`registerRequestModelShape(${ownerAlias}, {`);
    for (const field of ownerFields) {
      const modelAlias = aliasFor(field.model);
      if (modelAlias === undefined) {
        continue;
      }
      const values: string[] = [`model: ${modelAlias}`];
      if (field.array) {
        values.push("array: true");
      }
      if (field.nullable) {
        values.push("nullable: true");
      }
      if (field.elementNullable) {
        values.push("elementNullable: true");
      }
      lines.push(`  ${JSON.stringify(field.property)}: { ${values.join(", ")} },`);
    }
    lines.push("});");
  }
  return lines;
}

function modelTypeForProperty(checker: ts.TypeChecker, member: ts.PropertyDeclaration): UnwrappedModelType {
  const outer = unwrapNullableType(checker.getTypeAtLocation(member));
  if (outer.type === undefined) {
    return { array: false, nullable: outer.nullable, elementNullable: false, ambiguous: true };
  }
  if (isArrayModelType(checker, outer.type)) {
    const elementType = checker.getIndexTypeOfType(outer.type, ts.IndexKind.Number);
    if (elementType === undefined) {
      return { array: true, nullable: outer.nullable, elementNullable: false, ambiguous: true };
    }
    const element = unwrapNullableType(elementType);
    const model = element.type === undefined ? undefined : classDeclarationForType(element.type);
    return {
      model,
      array: true,
      nullable: outer.nullable,
      elementNullable: element.nullable,
      ambiguous: element.type === undefined || model === undefined,
    };
  }
  const model = classDeclarationForType(outer.type);
  return {
    model,
    array: false,
    nullable: outer.nullable,
    elementNullable: false,
    ambiguous: model === undefined,
  };
}

function unwrapNullableType(input: ts.Type): { readonly type?: ts.Type; readonly nullable: boolean } {
  const candidates = input.isUnion() ? input.types : [input];
  let nullable = false;
  const concrete: ts.Type[] = [];
  for (const candidate of candidates) {
    if ((candidate.flags & ts.TypeFlags.Null) !== 0) {
      nullable = true;
    } else if ((candidate.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0) {
      concrete.push(candidate);
    }
  }
  return concrete.length === 1 ? { type: concrete[0], nullable } : { nullable };
}

function isArrayModelType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return true;
  }
  const symbolName = type.getSymbol()?.getName();
  return symbolName === "ReadonlyArray" || symbolName === "Array";
}

function classDeclarationForType(type: ts.Type): ts.ClassDeclaration | undefined {
  return classDeclarationForSymbol(type.getSymbol() ?? type.aliasSymbol);
}

function classDeclarationForExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.ClassDeclaration | undefined {
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return classDeclarationForSymbol(symbol);
}

function classDeclarationForSymbol(symbol: ts.Symbol | undefined): ts.ClassDeclaration | undefined {
  return symbol?.declarations?.find(ts.isClassDeclaration);
}

function hasExplicitNestedValidator(member: ts.PropertyDeclaration): boolean {
  for (const decorator of ts.getDecorators(member) ?? []) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== "Validator") {
      continue;
    }
    const options = expression.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) {
      continue;
    }
    for (const property of options.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === "nested") ||
          (ts.isStringLiteralLike(property.name) && property.name.text === "nested")) &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false;
}
