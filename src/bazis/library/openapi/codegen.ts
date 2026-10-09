import ts from "typescript";
import type { OpenApiSchema } from "./types";

export type OpenApiCodegenSchema = Record<string, unknown>;

export interface OpenApiCodegenOperationSpec {
  readonly response?: OpenApiCodegenSchema;
  /** Success status when every success return uses the same result helper (`Created` -> 201). */
  readonly status?: number;
  /** Error statuses returned (`NotFound(...)`) or thrown (`throw new NotFoundError()`) in the method body. */
  readonly errors?: readonly number[];
  /** First line of the method's JSDoc. */
  readonly summary?: string;
  /** The rest of the method's JSDoc. */
  readonly description?: string;
}

export interface OpenApiCodegenAnalyzer {
  schemaFromMembers(
    members: readonly (ts.ClassElement | ts.TypeElement)[],
    ownerKind: "class" | "interface",
  ): OpenApiCodegenSchema;
  schemaFromDeclaration(declaration: ts.ClassDeclaration | ts.InterfaceDeclaration): OpenApiCodegenSchema;
  schemaNameForDeclaration(name: string, declaration: ts.Declaration | undefined): string;
  responseSchemaFromMethod(method: ts.MethodDeclaration): OpenApiCodegenSchema | undefined;
  /** Response schema, statuses and JSDoc of a controller method. */
  operationFromMethod(method: ts.MethodDeclaration): OpenApiCodegenOperationSpec;
}

export interface OpenApiCodegenAnalyzerInput {
  readonly checker: ts.TypeChecker;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly schemaNameForDuplicate?: (input: OpenApiDuplicateSchemaNameInput) => string;
}

export interface OpenApiDuplicateSchemaNameInput {
  readonly name: string;
  readonly filePath: string;
}

const SUCCESS_RESULT_HELPERS = new Set(["Ok", "Accepted"]);
const CREATED_RESULT_HELPERS = new Set(["Created"]);
const EMPTY_SUCCESS_RESULT_HELPERS = new Set(["NoContent", "Redirect", "File"]);
const ERROR_RESULT_HELPERS = new Set(["BadRequest", "Unauthorized", "Forbidden", "NotFound", "Conflict", "InternalServerError"]);
const SUCCESS_HELPER_STATUS: Readonly<Record<string, number>> = { Ok: 200, Accepted: 202, Created: 201, NoContent: 204 };
const ERROR_HELPER_STATUS: Readonly<Record<string, number>> = {
  BadRequest: 400, Unauthorized: 401, Forbidden: 403, NotFound: 404, Conflict: 409,
};
const ERROR_CLASS_STATUS: Readonly<Record<string, number>> = {
  BadRequestError: 400, UnauthorizedError: 401, ForbiddenError: 403, NotFoundError: 404,
  PayloadTooLargeError: 413, UnsupportedMediaTypeError: 415, TooManyRequestsError: 429,
};
const OPENAPI_EMPTY_TYPE_NAMES = new Set(["HttpResult", "Response", "Blob", "ReadableStream", "Uint8Array"]);
const OPENAPI_BUILTIN_TYPE_NAMES = new Set([
  "Array",
  "Map",
  "Partial",
  "Promise",
  "Readonly",
  "ReadonlyArray",
  "ReadonlyMap",
  "Record",
  "Required",
  "Set",
]);

export function createOpenApiCodegenAnalyzer(input: OpenApiCodegenAnalyzerInput): OpenApiCodegenAnalyzer {
  const checker = input.checker;
  const schemaFilesByName = collectSchemaNameIndex(input.sourceFiles);

  const schemaNameForDeclaration = (name: string, declaration: ts.Declaration | undefined): string => {
    const files = schemaFilesByName.get(name);
    if (files === undefined || files.size <= 1 || declaration === undefined) {
      return name;
    }
    const filePath = declaration.getSourceFile().fileName;
    return input.schemaNameForDuplicate?.({ name, filePath }) ?? defaultDuplicateSchemaName(name, filePath);
  };

  const schemaFromMembers = (
    members: readonly (ts.ClassElement | ts.TypeElement)[],
    ownerKind: "class" | "interface",
  ): OpenApiCodegenSchema => {
    const properties: Record<string, OpenApiCodegenSchema> = {};
    const required: string[] = [];
    for (const member of members) {
      if (!isSchemaProperty(member)) {
        continue;
      }
      const name = propertyNameText(member.name);
      if (!name || isPrivateMember(member)) {
        continue;
      }
      const typeNode = "type" in member ? member.type : undefined;
      const baseSchema = typeNode ? schemaFromTypeNode(typeNode) : schemaFromInitializer(schemaInitializer(member));
      const validators = validatorOptionsOf(member);
      const schema = validators.reduce((current, options) => applyValidatorOptions(current, options), baseSchema);
      const description = documentationOf(member.name);
      properties[name] = description === undefined ? schema : { ...schema, description };
      if (isRequiredProperty(member, ownerKind, validators)) {
        required.push(name);
      }
    }
    const schema: OpenApiCodegenSchema = { type: "object", properties };
    if (required.length > 0) {
      schema.required = required.sort((a, b) => a.localeCompare(b));
    }
    return schema;
  };

  /** JSDoc text of a declaration name, without tags; undefined when there is none. */
  const documentationOf = (name: ts.Node): string | undefined => {
    const symbol = checker.getSymbolAtLocation(name);
    const text = symbol === undefined ? "" : ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
    return text.length > 0 ? text : undefined;
  };

  const operationFromMethod = (method: ts.MethodDeclaration): OpenApiCodegenOperationSpec => {
    const response = responseSchemaFromMethod(method);
    const { status, errors } = statusesFromMethod(method);
    const documentation = documentationOf(method.name);
    const [summary, ...rest] = documentation?.split(/\r?\n/) ?? [];
    const description = rest.join("\n").trim();
    return {
      ...(response !== undefined ? { response } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(summary !== undefined && summary.trim().length > 0 ? { summary: summary.trim() } : {}),
      ...(description.length > 0 ? { description } : {}),
    };
  };

  /**
   * Success and error statuses visible in the method body: result helpers in
   * `return` statements and `throw new <HttpError subclass>`. Errors thrown
   * by called services are not visible here.
   */
  const statusesFromMethod = (method: ts.MethodDeclaration): { status?: number; errors: number[] } => {
    const success = new Set<number>();
    const errors = new Set<number>();
    const addReturn = (expression: ts.Expression): void => {
      const unwrapped = unwrapExpression(expression);
      if (ts.isConditionalExpression(unwrapped)) {
        addReturn(unwrapped.whenTrue);
        addReturn(unwrapped.whenFalse);
        return;
      }
      const name = ts.isCallExpression(unwrapped) ? callExpressionName(unwrapped) : undefined;
      if (name !== undefined && SUCCESS_HELPER_STATUS[name] !== undefined) {
        success.add(SUCCESS_HELPER_STATUS[name]);
      } else if (name !== undefined && ERROR_HELPER_STATUS[name] !== undefined) {
        errors.add(ERROR_HELPER_STATUS[name]);
      } else if (name === "StatusCode" && ts.isCallExpression(unwrapped)) {
        const status = numericLiteralValue(unwrapped.arguments[0]);
        if (status === undefined) success.add(-1);
        else if (status >= 400 && status < 500) errors.add(status);
        else if (status >= 200 && status < 300) success.add(status);
      } else if (name === undefined || !EMPTY_SUCCESS_RESULT_HELPERS.has(name) && !ERROR_RESULT_HELPERS.has(name)) {
        success.add(200);
      } else {
        success.add(-1);
      }
    };
    const visit = (node: ts.Node): void => {
      if (node !== method.body && isNestedFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        if (node.expression !== undefined) addReturn(node.expression);
        return;
      }
      if (ts.isThrowStatement(node) && ts.isNewExpression(unwrapExpression(node.expression))) {
        const status = httpErrorStatus(checker.getTypeAtLocation(node.expression));
        if (status !== undefined) errors.add(status);
      }
      ts.forEachChild(node, visit);
    };
    if (method.body !== undefined) ts.forEachChild(method.body, visit);
    const [only] = success;
    return {
      ...(success.size === 1 && only !== undefined && only !== 200 && only !== -1 ? { status: only } : {}),
      errors: [...errors].sort((a, b) => a - b),
    };
  };

  /** Status of an HttpError subclass by its class chain (`class TaskNotFound extends NotFoundError`). */
  const httpErrorStatus = (type: ts.Type): number | undefined => {
    let current: ts.Type | undefined = type;
    for (let depth = 0; current !== undefined && depth < 16; depth += 1) {
      const name = current.getSymbol()?.getName();
      if (name !== undefined && ERROR_CLASS_STATUS[name] !== undefined) return ERROR_CLASS_STATUS[name];
      current = current.isClass() ? checker.getBaseTypes(current)[0] : undefined;
    }
    return undefined;
  };

  const responseSchemaFromMethod = (method: ts.MethodDeclaration): OpenApiCodegenSchema | undefined => {
    // A declared return type is the contract; result-helper types
    // (HttpResult, Response) carry no schema and fall back to the returns.
    const declared = method.type ? responseSchemaFromType(method.type) : undefined;
    return declared ?? responseSchemaFromReturnExpressions(method);
  };

  const schemaFromTypeNode = (node: ts.TypeNode): OpenApiCodegenSchema => {
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { type: "string" };
      case ts.SyntaxKind.NumberKeyword:
        return { type: "number" };
      case ts.SyntaxKind.BooleanKeyword:
        return { type: "boolean" };
      case ts.SyntaxKind.ObjectKeyword:
        return { type: "object" };
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
      case ts.SyntaxKind.VoidKeyword:
      case ts.SyntaxKind.NeverKeyword:
      case ts.SyntaxKind.UndefinedKeyword:
        return {};
    }
    if (ts.isArrayTypeNode(node)) {
      return { type: "array", items: schemaFromTypeNode(node.elementType) };
    }
    if (ts.isTypeReferenceNode(node)) {
      return schemaFromTypeReference(node);
    }
    if (ts.isUnionTypeNode(node)) {
      return schemaFromUnion(node);
    }
    if (ts.isLiteralTypeNode(node)) {
      return schemaFromLiteralType(node);
    }
    if (ts.isTypeLiteralNode(node)) {
      return schemaFromMembers(node.members, "interface");
    }
    if (ts.isParenthesizedTypeNode(node)) {
      return schemaFromTypeNode(node.type);
    }
    return {};
  };

  const schemaFromTypeReference = (node: ts.TypeReferenceNode): OpenApiCodegenSchema => {
    const name = getTypeReferenceName(node);
    if (name === "Array" || name === "ReadonlyArray") {
      const inner = node.typeArguments?.[0];
      return { type: "array", items: inner ? schemaFromTypeNode(inner) : {} };
    }
    if (name === "ListDocument") {
      const inner = node.typeArguments?.[0];
      return listDocumentSchema(inner ? schemaFromTypeNode(inner) : {});
    }
    if (name === "Record" || name === "Readonly" || name === "Partial" || name === "Required") {
      if ((name === "Readonly" || name === "Partial" || name === "Required") && node.typeArguments?.[0]) {
        return schemaFromTypeNode(node.typeArguments[0] as ts.TypeNode);
      }
      return { type: "object" };
    }
    if (name === "Date") {
      return { type: "string", format: "date-time" };
    }
    if (name === "Promise" && node.typeArguments?.[0]) {
      return schemaFromTypeNode(node.typeArguments[0] as ts.TypeNode);
    }
    if (!name || OPENAPI_BUILTIN_TYPE_NAMES.has(name) || OPENAPI_EMPTY_TYPE_NAMES.has(name)) {
      return {};
    }
    return { $ref: `#/components/schemas/${schemaNameForTypeReference(node, name)}` };
  };

  const schemaFromUnion = (node: ts.UnionTypeNode): OpenApiCodegenSchema => {
    const schemas: OpenApiCodegenSchema[] = [];
    let nullable = false;
    for (const part of node.types) {
      if (part.kind === ts.SyntaxKind.UndefinedKeyword) {
        continue;
      }
      if (part.kind === ts.SyntaxKind.NullKeyword) {
        nullable = true;
        continue;
      }
      const schema = schemaFromTypeNode(part);
      if (Object.keys(schema).length > 0) {
        schemas.push(schema);
      }
    }
    if (schemas.length === 0) {
      return nullable ? { type: "null" } : {};
    }
    if (schemas.length === 1) {
      const single = schemas[0];
      return single === undefined ? {} : nullable ? { ...single, nullable: true } : single;
    }
    return nullable ? { anyOf: [...schemas, { type: "null" }] } : { anyOf: schemas };
  };

  const responseSchemaFromType = (node: ts.TypeNode): OpenApiCodegenSchema | undefined => {
    const schema = schemaFromTypeNode(unwrapPromiseType(node));
    return Object.keys(schema).length === 0 ? undefined : schema;
  };

  const responseSchemaFromReturnExpressions = (method: ts.MethodDeclaration): OpenApiCodegenSchema | undefined => {
    if (method.body === undefined) {
      return undefined;
    }
    const schemas: OpenApiCodegenSchema[] = [];
    const visit = (node: ts.Node): void => {
      if (node !== method.body && isNestedFunctionLike(node)) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        const schema = schemaFromReturnExpression(node.expression);
        if (schema !== undefined && Object.keys(schema).length > 0) {
          schemas.push(schema);
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(method.body, visit);
    return mergeResponseSchemas(schemas);
  };

  const schemaFromReturnExpression = (expression: ts.Expression): OpenApiCodegenSchema | undefined => {
    const unwrapped = unwrapExpression(expression);
    if (ts.isConditionalExpression(unwrapped)) {
      return mergeResponseSchemas([
        schemaFromReturnExpression(unwrapped.whenTrue),
        schemaFromReturnExpression(unwrapped.whenFalse),
      ].filter((schema): schema is OpenApiCodegenSchema => schema !== undefined));
    }
    if (ts.isCallExpression(unwrapped)) {
      const name = callExpressionName(unwrapped);
      if (name !== undefined) {
        if (SUCCESS_RESULT_HELPERS.has(name)) {
          return schemaFromOptionalExpression(unwrapped.arguments[0]);
        }
        if (CREATED_RESULT_HELPERS.has(name)) {
          return schemaFromOptionalExpression(unwrapped.arguments[1]);
        }
        if (name === "StatusCode") {
          return schemaFromStatusCodeCall(unwrapped);
        }
        if (EMPTY_SUCCESS_RESULT_HELPERS.has(name) || ERROR_RESULT_HELPERS.has(name)) {
          return undefined;
        }
      }
    }
    return schemaFromExpressionType(unwrapped);
  };

  const schemaFromStatusCodeCall = (call: ts.CallExpression): OpenApiCodegenSchema | undefined => {
    const status = numericLiteralValue(call.arguments[0]);
    if (status === undefined || status < 200 || status >= 300 || status === 204) {
      return undefined;
    }
    return schemaFromOptionalExpression(call.arguments[1]);
  };

  const schemaFromOptionalExpression = (expression: ts.Expression | undefined): OpenApiCodegenSchema | undefined => {
    if (expression === undefined) {
      return undefined;
    }
    return schemaFromExpressionType(expression);
  };

  const schemaFromExpressionType = (expression: ts.Expression): OpenApiCodegenSchema | undefined => {
    const schema = schemaFromTsType(checker.getTypeAtLocation(expression));
    return Object.keys(schema).length === 0 ? undefined : schema;
  };

  const schemaFromTsType = (type: ts.Type, seen = new Set<string>()): OpenApiCodegenSchema => {
    const promised = promisedTypeOf(type);
    if (promised !== undefined) {
      return schemaFromTsType(promised, seen);
    }
    if (type.isUnion()) {
      return schemaFromTsUnion(type, seen);
    }
    if (type.flags & ts.TypeFlags.StringLiteral && type.isStringLiteral()) {
      return { type: "string", const: type.value };
    }
    if (type.isNumberLiteral()) {
      return { type: "number", const: type.value };
    }
    if (type.flags & ts.TypeFlags.StringLike) {
      return { type: "string" };
    }
    if (type.flags & ts.TypeFlags.NumberLike) {
      return { type: "number" };
    }
    if (type.flags & ts.TypeFlags.BooleanLike) {
      return { type: "boolean" };
    }
    if (type.flags & ts.TypeFlags.BigIntLike) {
      return { type: "integer" };
    }
    if (type.flags & ts.TypeFlags.Null) {
      return { type: "null" };
    }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
      return {};
    }

    const name = openApiTypeName(type);
    if (name === "Date") {
      return { type: "string", format: "date-time" };
    }
    if (name === "Array" || name === "ReadonlyArray" || checker.isArrayType(type) || checker.isTupleType(type)) {
      return schemaFromArrayTsType(type, seen);
    }
    if (name === "ListDocument") {
      const inner = typeArgumentsOf(type)[0];
      return listDocumentSchema(inner ? schemaFromTsType(inner, seen) : {});
    }
    if (name === "Record") {
      return { type: "object" };
    }
    if (name === "Readonly" || name === "Partial" || name === "Required") {
      const inner = typeArgumentsOf(type)[0];
      return inner ? schemaFromTsType(inner, seen) : {};
    }
    if (name === "Promise" || (name === undefined && checker.typeToString(type) === "Promise")) {
      return {};
    }
    if (name !== undefined && (OPENAPI_BUILTIN_TYPE_NAMES.has(name) || OPENAPI_EMPTY_TYPE_NAMES.has(name))) {
      return {};
    }
    if (name !== undefined && !isAnonymousTypeName(name)) {
      return { $ref: `#/components/schemas/${schemaNameForType(type, name)}` };
    }
    return schemaFromObjectTsType(type, seen);
  };

  const promisedTypeOf = (type: ts.Type): ts.Type | undefined => {
    return openApiTypeName(type) === "Promise" ? typeArgumentsOf(type)[0] : undefined;
  };

  const typeArgumentsOf = (type: ts.Type): readonly ts.Type[] => {
    return checker.getTypeArguments(type as ts.TypeReference);
  };

  const schemaFromTsUnion = (type: ts.UnionType, seen: Set<string>): OpenApiCodegenSchema => {
    const schemas: OpenApiCodegenSchema[] = [];
    let nullable = false;
    for (const part of type.types) {
      if (part.flags & ts.TypeFlags.Undefined) {
        continue;
      }
      if (part.flags & ts.TypeFlags.Null) {
        nullable = true;
        continue;
      }
      const schema = schemaFromTsType(part, seen);
      if (Object.keys(schema).length > 0) {
        schemas.push(schema);
      }
    }
    const merged = mergeResponseSchemas(schemas);
    if (merged === undefined) {
      return nullable ? { type: "null" } : {};
    }
    return nullable ? { ...merged, nullable: true } : merged;
  };

  const schemaFromArrayTsType = (type: ts.Type, seen: Set<string>): OpenApiCodegenSchema => {
    if (checker.isTupleType(type)) {
      const tupleArgs = typeArgumentsOf(type);
      return { type: "array", items: mergeResponseSchemas(tupleArgs.map((item) => schemaFromTsType(item, seen))) ?? {} };
    }
    const args = typeArgumentsOf(type);
    return { type: "array", items: args[0] ? schemaFromTsType(args[0], seen) : {} };
  };

  const schemaFromObjectTsType = (type: ts.Type, seen: Set<string>): OpenApiCodegenSchema => {
    const key = typeIdentity(type);
    if (seen.has(key)) {
      return {};
    }
    seen.add(key);

    const properties: Record<string, OpenApiCodegenSchema> = {};
    const required: string[] = [];
    for (const property of checker.getPropertiesOfType(type)) {
      const name = property.getName();
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration === undefined) {
        continue;
      }
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      properties[name] = schemaFromTsType(propertyType, new Set(seen));
      if (!isOptionalTsProperty(property, propertyType)) {
        required.push(name);
      }
    }
    seen.delete(key);

    const schema: OpenApiCodegenSchema = { type: "object", properties };
    if (required.length > 0) {
      schema.required = required.sort((a, b) => a.localeCompare(b));
    }
    return schema;
  };

  const schemaNameForTypeReference = (node: ts.TypeReferenceNode, fallback: string): string => {
    const typeName = node.typeName;
    const nameNode = ts.isIdentifier(typeName) ? typeName : typeName.right;
    const symbol = resolvedSymbol(checker.getSymbolAtLocation(nameNode), checker);
    return schemaNameForDeclaration(fallback, symbol?.declarations?.[0]);
  };

  const schemaNameForType = (type: ts.Type, fallback: string): string => {
    const reference = type as ts.TypeReference;
    const symbol = resolvedSymbol(type.aliasSymbol ?? reference.target?.symbol ?? type.symbol, checker);
    return schemaNameForDeclaration(fallback, symbol?.declarations?.[0]);
  };

  const typeIdentity = (type: ts.Type): string => {
    const withId = type as ts.Type & { id?: number };
    return withId.id === undefined ? checker.typeToString(type) : String(withId.id);
  };

  return {
    schemaFromMembers,
    schemaFromDeclaration(declaration) {
      const schema = schemaFromDeclarationMembers(declaration);
      const description = declaration.name === undefined ? undefined : documentationOf(declaration.name);
      return description === undefined ? schema : { description, ...schema };
    },
    schemaNameForDeclaration,
    responseSchemaFromMethod,
    operationFromMethod,
  };

  function schemaFromDeclarationMembers(declaration: ts.ClassDeclaration | ts.InterfaceDeclaration): OpenApiCodegenSchema {
    if (!declaration.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)) {
      return schemaFromMembers(declaration.members, ts.isClassDeclaration(declaration) ? "class" : "interface");
    }
    // Effective instance properties include imported and indirect base classes.
    // Keep original property declarations so their Validator rules remain visible.
    const properties = checker.getPropertiesOfType(checker.getTypeAtLocation(declaration));
    const members = properties.flatMap(property => {
      const member = property.valueDeclaration ?? property.declarations?.[0];
      return member !== undefined && (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) ? [member] : [];
    });
    return schemaFromMembers(members, ts.isClassDeclaration(declaration) ? "class" : "interface");
  }
}

function collectSchemaNameIndex(sourceFiles: readonly ts.SourceFile[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const source of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
        let files = index.get(node.name.text);
        if (files === undefined) {
          files = new Set<string>();
          index.set(node.name.text, files);
        }
        files.add(source.fileName);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return index;
}

function isSchemaProperty(node: ts.Node): node is ts.PropertyDeclaration | ts.PropertySignature {
  return ts.isPropertyDeclaration(node) || ts.isPropertySignature(node);
}

function isPrivateMember(member: ts.PropertyDeclaration | ts.PropertySignature): boolean {
  if (!ts.isPropertyDeclaration(member)) {
    return false;
  }
  return member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) ?? false;
}

function schemaInitializer(member: ts.PropertyDeclaration | ts.PropertySignature): ts.Expression | undefined {
  return ts.isPropertyDeclaration(member) ? member.initializer : undefined;
}

function isRequiredProperty(
  member: ts.PropertyDeclaration | ts.PropertySignature,
  ownerKind: "class" | "interface",
  validators: readonly Record<string, unknown>[],
): boolean {
  if (validators.some((options) => options.required === true)) {
    return true;
  }
  if (member.questionToken !== undefined) {
    return false;
  }
  if (ownerKind === "interface") {
    return true;
  }
  return ts.isPropertyDeclaration(member) && member.initializer === undefined && member.exclamationToken !== undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function validatorOptionsOf(member: ts.PropertyDeclaration | ts.PropertySignature): Record<string, unknown>[] {
  if (!ts.isPropertyDeclaration(member)) {
    return [];
  }
  const options: Record<string, unknown>[] = [];
  for (const decorator of ts.getDecorators(member) ?? []) {
    const info = decoratorCall(decorator);
    if (!info?.call || info.name !== "Validator") {
      continue;
    }
    const firstArg = info.call.arguments[0];
    if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
      options.push(objectLiteralValue(firstArg));
    }
  }
  return options;
}

function applyValidatorOptions(schema: OpenApiCodegenSchema, options: Record<string, unknown>): OpenApiCodegenSchema {
  const out: OpenApiCodegenSchema = { ...schema };
  const typeHint = typeof options.type === "string" ? options.type : undefined;
  if (typeHint !== undefined) {
    applyTypeHint(out, typeHint);
  }
  if (options.email === true) {
    out.type = "string";
    out.format = "email";
  }
  if (options.url === true) {
    out.type = "string";
    out.format = "uri";
  }
  if (options.uuid === true) {
    out.type = "string";
    out.format = "uuid";
  }
  if (options.phone === true) {
    out.type = "string";
    out.pattern = "^\\\\+?[0-9 ()-]{7,20}$";
  }
  if (options.json === true) {
    out.type = "string";
    out.contentMediaType = "application/json";
  }
  if (options.integer === true) {
    out.type = "integer";
  }
  if (options.notEmpty === true) {
    out.type ??= "string";
    out.minLength = Math.max(readNumber(out.minLength) ?? 0, 1);
  }
  setNumber(out, "minLength", options.minLength);
  setNumber(out, "maxLength", options.maxLength);
  if (isNumberTuple(options.length)) {
    out.minLength = options.length[0];
    out.maxLength = options.length[1];
  }
  setNumber(out, "minimum", options.min);
  setNumber(out, "maximum", options.max);
  if (isNumberTuple(options.range)) {
    out.minimum = options.range[0];
    out.maximum = options.range[1];
  }
  if (options.positive === true) {
    out.exclusiveMinimum = 0;
  }
  if (options.negative === true) {
    out.exclusiveMaximum = 0;
  }
  if (typeof options.pattern === "string") {
    out.type = "string";
    out.pattern = options.pattern;
  }
  return out;
}

function applyTypeHint(schema: OpenApiCodegenSchema, typeHint: string): void {
  switch (typeHint) {
    case "string":
    case "phone":
      schema.type = "string";
      break;
    case "number":
      schema.type = "number";
      break;
    case "boolean":
      schema.type = "boolean";
      break;
    case "email":
      schema.type = "string";
      schema.format = "email";
      break;
    case "date":
      schema.type = "string";
      schema.format = "date-time";
      break;
    case "json":
      schema.type = "string";
      schema.contentMediaType = "application/json";
      break;
    case "enum":
    case "any":
      break;
  }
}

function setNumber(target: OpenApiCodegenSchema, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = value;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isNumberTuple(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

function unwrapPromiseType(node: ts.TypeNode): ts.TypeNode {
  if (ts.isTypeReferenceNode(node) && getTypeReferenceName(node) === "Promise" && node.typeArguments?.[0]) {
    return node.typeArguments[0] as ts.TypeNode;
  }
  return node;
}

function schemaFromLiteralType(node: ts.LiteralTypeNode): OpenApiCodegenSchema {
  const literal = node.literal;
  if (ts.isStringLiteralLike(literal)) {
    return { type: "string", const: literal.text };
  }
  if (ts.isNumericLiteral(literal)) {
    return { type: "number", const: Number(literal.text) };
  }
  if (literal.kind === ts.SyntaxKind.TrueKeyword) {
    return { type: "boolean", const: true };
  }
  if (literal.kind === ts.SyntaxKind.FalseKeyword) {
    return { type: "boolean", const: false };
  }
  if (literal.kind === ts.SyntaxKind.NullKeyword) {
    return { type: "null" };
  }
  return {};
}

function schemaFromInitializer(initializer: ts.Expression | undefined): OpenApiCodegenSchema {
  if (!initializer) {
    return {};
  }
  if (ts.isStringLiteralLike(initializer)) {
    return { type: "string" };
  }
  if (ts.isNumericLiteral(initializer)) {
    return { type: "number" };
  }
  if (initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) {
    return { type: "boolean" };
  }
  if (ts.isArrayLiteralExpression(initializer)) {
    return { type: "array", items: {} };
  }
  if (ts.isObjectLiteralExpression(initializer)) {
    return { type: "object" };
  }
  return {};
}

function objectLiteralValue(node: ts.ObjectLiteralExpression): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = propertyNameText(property.name);
    if (!name) {
      continue;
    }
    out[name] = expressionValue(property.initializer);
  }
  return out;
}

function expressionValue(expression: ts.Expression): unknown {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((item) => expressionValue(item));
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return objectLiteralValue(expression);
  }
  return undefined;
}

function isNestedFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function callExpressionName(call: ts.CallExpression): string | undefined {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function numericLiteralValue(expression: ts.Expression | undefined): number | undefined {
  if (expression === undefined) {
    return undefined;
  }
  const unwrapped = unwrapExpression(expression);
  if (ts.isNumericLiteral(unwrapped)) {
    return Number(unwrapped.text);
  }
  return undefined;
}

function mergeResponseSchemas(schemas: readonly OpenApiCodegenSchema[]): OpenApiCodegenSchema | undefined {
  const unique = new Map<string, OpenApiCodegenSchema>();
  for (const schema of schemas) {
    if (Object.keys(schema).length === 0) {
      continue;
    }
    unique.set(JSON.stringify(schema), schema);
  }
  const values = [...unique.values()];
  if (values.length === 0) {
    return undefined;
  }
  if (values.length === 1) {
    return values[0];
  }
  return { anyOf: values };
}

function isOptionalTsProperty(property: ts.Symbol, type: ts.Type): boolean {
  if ((property.flags & ts.SymbolFlags.Optional) !== 0) {
    return true;
  }
  return type.isUnion() && type.types.some((part) => (part.flags & ts.TypeFlags.Undefined) !== 0);
}

function openApiTypeName(type: ts.Type): string | undefined {
  const reference = type as ts.TypeReference;
  return type.aliasSymbol?.name ?? reference.target?.symbol?.name ?? type.symbol?.name;
}

function isAnonymousTypeName(name: string): boolean {
  return name === "__type" || name === "__object" || name === "Object";
}

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (symbol === undefined) {
    return undefined;
  }
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function defaultDuplicateSchemaName(name: string, filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const context = parts.slice(Math.max(0, parts.length - 3), Math.max(0, parts.length - 1)).map(toPascalIdentifier).join("");
  return context.length === 0 ? name : `${context}${name}`;
}

function toPascalIdentifier(value: string): string {
  return value
    .replace(/\.[^.]+$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function listDocumentSchema(itemSchema: OpenApiSchema): OpenApiCodegenSchema {
  return {
    type: "object",
    properties: {
      data: { type: "array", items: itemSchema },
      meta: {
        type: "object",
        properties: {
          total: { type: "integer" },
          page: { type: "integer" },
          size: { type: "integer" },
          pageCount: { type: "integer" },
        },
        required: ["page", "pageCount", "size", "total"],
      },
      links: {
        type: "object",
        properties: {
          self: { type: "string" },
          first: { type: "string" },
          last: { type: "string" },
          prev: { type: "string" },
          next: { type: "string" },
        },
        required: ["first", "last", "self"],
      },
    },
    required: ["data", "meta"],
  };
}

function decoratorCall(decorator: ts.Decorator): { name: string; call?: ts.CallExpression } | undefined {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return { name: expression.expression.text, call: expression };
  }
  if (ts.isIdentifier(expression)) {
    return { name: expression.text };
  }
  return undefined;
}

function getTypeReferenceName(node: ts.TypeNode): string | undefined {
  if (!ts.isTypeReferenceNode(node)) {
    return undefined;
  }
  const typeName = node.typeName;
  if (ts.isIdentifier(typeName)) {
    return typeName.text;
  }
  if (ts.isQualifiedName(typeName)) {
    return typeName.right.text;
  }
  return undefined;
}
