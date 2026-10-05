import path from "node:path";
import ts from "typescript";

export interface AgentCodegenSource {
  readonly filePath: string;
  /** Program-owned AST; codegen never reparses application source. */
  readonly sourceFile?: ts.SourceFile;
  /** Legacy test-only fixture input; project generation always supplies sourceFile. */
  readonly content?: string;
}

export interface AgentCodegenResult {
  readonly output: string;
  readonly warnings: readonly string[];
  readonly agentCount: number;
  readonly toolCount: number;
  readonly promptCount: number;
  /** Class contracts referenced by agents, tasks and tools. */
  readonly schemaNames: readonly string[];
  /** Program-owned declarations of those contracts, for nominal schema bindings. */
  readonly schemaModels: readonly ts.ClassDeclaration[];
}

export interface AgentCodegenOptions {
  readonly generatedDir?: string;
  readonly frameworkImports?: "relative" | "public";
  /** Use the same naming policy as the project's OpenAPI analyzer. */
  readonly schemaNameForDeclaration?: (name: string, declaration: ts.ClassDeclaration) => string;
}

interface AgentCodegenEntry {
  readonly className: string;
  readonly filePath: string;
  readonly metadata: AgentCodegenMetadata;
}

interface AgentCodegenMetadata {
  readonly name: string;
  readonly description?: string;
  readonly role?: string;
  readonly goal?: string;
  readonly instructions: readonly string[];
  readonly constraints: readonly string[];
  readonly sections: readonly PromptSectionCodegenMetadata[];
  readonly prompt?: string;
  readonly tools?: readonly string[];
  readonly input?: string;
  readonly output?: string;
  readonly modelProfile?: string;
  readonly maxSteps?: number;
  readonly tasks: readonly AgentTaskCodegenMetadata[];
}

interface AgentTaskCodegenMetadata {
  readonly name: string;
  readonly methodName: string;
  readonly description?: string;
  readonly input?: string;
  readonly output?: string;
  readonly modelProfile?: string;
  readonly maxSteps?: number;
}

interface ToolCodegenEntry {
  readonly className: string;
  readonly filePath: string;
  readonly metadata: ToolCodegenMetadata;
}

interface ToolCodegenMetadata {
  readonly name: string;
  readonly description: string;
  readonly input?: string;
  readonly output?: string;
  readonly sideEffect: "none" | "read" | "write" | "external";
  readonly approval: "never" | "policy" | "required";
  readonly timeoutMs?: number;
  readonly tags: readonly string[];
}

interface PromptCodegenEntry {
  readonly className: string;
  readonly filePath: string;
  readonly metadata: PromptCodegenMetadata;
}

interface PromptCodegenMetadata {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly role?: string;
  readonly goal?: string;
  readonly instructions: readonly string[];
  readonly constraints: readonly string[];
  readonly sections: readonly PromptSectionCodegenMetadata[];
}

type PromptSectionCodegenKind =
  | "system"
  | "developer"
  | "role"
  | "task"
  | "instructions"
  | "constraints"
  | "examples"
  | "output"
  | "tool-policy"
  | "memory"
  | "knowledge";

interface PromptSectionCodegenMetadata {
  readonly kind: PromptSectionCodegenKind;
  readonly title?: string;
  readonly content: readonly string[];
  readonly priority?: number;
}

interface AgentParseState {
  readonly source: ts.SourceFile;
  readonly node: ts.Node;
  readonly decorator: string;
  readonly className: string;
  ok: boolean;
}

interface AgentCodegenContext {
  readonly generatedDir: string;
  readonly frameworkImports: "relative" | "public";
  readonly warnings: string[];
  readonly classFilesByName: Map<string, string>;
  readonly classDeclarationsByName: Map<string, ts.ClassDeclaration>;
  readonly ambiguousClassNames: Set<string>;
  readonly namedExportedClassNames: Set<string>;
  readonly agents: AgentCodegenEntry[];
  readonly tools: ToolCodegenEntry[];
  readonly prompts: PromptCodegenEntry[];
}

interface RenderedAgentCatalog {
  readonly output: string;
  readonly agentCount: number;
  readonly toolCount: number;
  readonly promptCount: number;
}

export function generateAgentMetadataCatalog(
  sources: readonly AgentCodegenSource[],
  options: AgentCodegenOptions | string = {},
): AgentCodegenResult {
  const normalizedOptions = typeof options === "string" ? { generatedDir: options } : options;
  const context: AgentCodegenContext = {
    generatedDir: normalizedOptions.generatedDir ?? "src/osnv/core/agent/generated",
    frameworkImports: normalizedOptions.frameworkImports ?? "relative",
    warnings: [],
    classFilesByName: new Map(),
    classDeclarationsByName: new Map(),
    ambiguousClassNames: new Set(),
    namedExportedClassNames: new Set(),
    agents: [],
    tools: [],
    prompts: [],
  };

  const parsedSources = sources.map((source) => ({
    filePath: source.filePath,
    sourceFile: source.sourceFile ?? ts.createSourceFile(source.filePath, source.content ?? "", ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS),
  }));

  for (let index = 0; index < parsedSources.length; index += 1) {
    const source = parsedSources[index]!;
    collectClassIndex(source.sourceFile, context);
  }

  for (let index = 0; index < parsedSources.length; index += 1) {
    const source = parsedSources[index]!;
    collectAgentEntries(source.sourceFile, context);
  }

  const rendered = renderAgentCatalog(context);
  const schemaModels = collectAgentSchemaNames(context)
    .filter((name) => !context.ambiguousClassNames.has(name))
    .map((name) => context.classDeclarationsByName.get(name))
    .filter((declaration): declaration is ts.ClassDeclaration => declaration !== undefined);
  return {
    output: rendered.output,
    warnings: Object.freeze([...context.warnings]),
    agentCount: rendered.agentCount,
    toolCount: rendered.toolCount,
    promptCount: rendered.promptCount,
    schemaNames: Object.freeze(schemaModels.map((declaration) =>
      normalizedOptions.schemaNameForDeclaration?.(declaration.name!.text, declaration) ?? declaration.name!.text)
      .sort((left, right) => left.localeCompare(right))),
    schemaModels: Object.freeze(schemaModels),
  };
}

function collectAgentSchemaNames(context: AgentCodegenContext): readonly string[] {
  const names = new Set<string>();
  for (const agent of context.agents) {
    if (agent.metadata.input) names.add(agent.metadata.input);
    if (agent.metadata.output) names.add(agent.metadata.output);
    for (const task of agent.metadata.tasks) {
      if (task.input) names.add(task.input);
      if (task.output) names.add(task.output);
    }
  }
  for (const tool of context.tools) {
    if (tool.metadata.input) names.add(tool.metadata.input);
    if (tool.metadata.output) names.add(tool.metadata.output);
  }
  return Object.freeze([...names].sort((left, right) => left.localeCompare(right)));
}

function collectClassIndex(source: ts.SourceFile, context: AgentCodegenContext): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      recordClassFile(node.name.text, source.fileName, context);
      context.classDeclarationsByName.set(node.name.text, node);
      if (isNamedExportedClass(node)) {
        context.namedExportedClassNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function collectAgentEntries(source: ts.SourceFile, context: AgentCodegenContext): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const decorators = ts.getDecorators(node) ?? [];
      for (const decorator of decorators) {
        const info = decoratorCall(decorator);
        if (!info || (info.name !== "Agent" && info.name !== "Tool" && info.name !== "Prompt")) {
          continue;
        }
        if (!isNamedExportedClass(node)) {
          context.warnings.push(
            `${info.name} class "${className}" (${source.fileName}) is not a named export; ` +
              `agent codegen can only import named-export classes.`,
          );
          continue;
        }
        const namedNode = node as ts.ClassDeclaration & { readonly name: ts.Identifier };
        if (info.name === "Agent") {
          const metadata = parseAgentMetadata(source, namedNode, info, context);
          if (metadata) {
            context.agents.push({ className, filePath: source.fileName, metadata });
          }
        } else if (info.name === "Tool") {
          const metadata = parseToolMetadata(source, namedNode, info, context);
          if (metadata) {
            context.tools.push({ className, filePath: source.fileName, metadata });
          }
        } else {
          const metadata = parsePromptMetadata(source, namedNode, info, context);
          if (metadata) {
            context.prompts.push({ className, filePath: source.fileName, metadata });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
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

function isNamedExportedClass(node: ts.ClassDeclaration): boolean {
  const modifiers = ts.getModifiers(node) ?? [];
  const hasExport = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const hasDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  return hasExport && !hasDefault;
}

function recordClassFile(name: string, filePath: string, context: AgentCodegenContext): void {
  const existing = context.classFilesByName.get(name);
  if (existing === undefined) {
    context.classFilesByName.set(name, filePath);
  } else if (existing !== filePath) {
    context.ambiguousClassNames.add(name);
  }
}

function parseAgentMetadata(
  source: ts.SourceFile,
  node: ts.ClassDeclaration & { readonly name: ts.Identifier },
  info: { name: string; call?: ts.CallExpression },
  context: AgentCodegenContext,
): AgentCodegenMetadata | undefined {
  const state: AgentParseState = { source, node, decorator: "@Agent", className: node.name.text, ok: true };
  const properties = readDecoratorProperties(info, state, context, true);
  if (!state.ok || properties === undefined) {
    return undefined;
  }

  const name = readOptionalStringProperty(properties, "name", state, context) ?? node.name.text;
  const description = readOptionalStringProperty(properties, "description", state, context);
  const role = readOptionalStringProperty(properties, "role", state, context);
  const goal = readOptionalStringProperty(properties, "goal", state, context);
  const instructions = readOptionalStringArrayProperty(properties, "instructions", state, context) ?? [];
  const constraints = readOptionalStringArrayProperty(properties, "constraints", state, context) ?? [];
  const sections = readOptionalPromptSectionArrayProperty(properties, "sections", state, context) ?? [];
  const prompt = readOptionalClassProperty(properties, "prompt", state, context);
  const tools = readOptionalClassArrayProperty(properties, "tools", state, context) ?? [];
  const input = readOptionalClassProperty(properties, "input", state, context);
  const output = readOptionalClassProperty(properties, "output", state, context);
  const modelProfile = readOptionalStringProperty(properties, "modelProfile", state, context);
  const maxSteps = readOptionalPositiveIntegerProperty(properties, "maxSteps", state, context);
  const tasks = parseAgentTasks(source, node, context);

  if (!state.ok) {
    return undefined;
  }
  return { name, description, role, goal, instructions, constraints, sections, prompt, tools, input, output, modelProfile, maxSteps, tasks };
}

function parseAgentTasks(
  source: ts.SourceFile,
  node: ts.ClassDeclaration & { readonly name: ts.Identifier },
  context: AgentCodegenContext,
): readonly AgentTaskCodegenMetadata[] {
  const tasks: AgentTaskCodegenMetadata[] = [];
  for (const member of node.members) {
    if (!ts.isMethodDeclaration(member)) {
      continue;
    }
    const decorators = ts.getDecorators(member) ?? [];
    for (const decorator of decorators) {
      const info = decoratorCall(decorator);
      if (!info || info.name !== "Task") {
        continue;
      }
      const task = parseAgentTaskMetadata(source, node.name.text, member, info, context);
      if (task !== undefined) {
        tasks.push(task);
      }
    }
  }
  return tasks;
}

function parseAgentTaskMetadata(
  source: ts.SourceFile,
  className: string,
  node: ts.MethodDeclaration,
  info: { name: string; call?: ts.CallExpression },
  context: AgentCodegenContext,
): AgentTaskCodegenMetadata | undefined {
  const state: AgentParseState = { source, node, decorator: "@Task", className, ok: true };
  const methodName = methodNameText(node.name);
  if (methodName === undefined) {
    failAgentParse(state, context, "@Task supports string method names only.");
    return undefined;
  }
  if (isStaticOrPrivateMethod(node)) {
    failAgentParse(state, context, "@Task supports public instance methods only.");
    return undefined;
  }

  const properties = readTaskDecoratorProperties(info, state, context);
  if (!state.ok || properties === undefined) {
    return undefined;
  }

  const name = readOptionalStringProperty(properties, "name", state, context) ?? methodName;
  const description = readOptionalStringProperty(properties, "description", state, context);
  const input = readOptionalClassProperty(properties, "input", state, context) ?? readFirstParameterTypeName(node, state, context);
  const output = readOptionalClassProperty(properties, "output", state, context) ?? readReturnTypeName(node, state, context);
  const modelProfile = readOptionalStringProperty(properties, "modelProfile", state, context);
  const maxSteps = readOptionalPositiveIntegerProperty(properties, "maxSteps", state, context);

  if (!state.ok) {
    return undefined;
  }
  return { name, methodName, description, input, output, modelProfile, maxSteps };
}

function readTaskDecoratorProperties(
  info: { name: string; call?: ts.CallExpression },
  state: AgentParseState,
  context: AgentCodegenContext,
): Map<string, ts.Expression> | undefined {
  if (!info.call) {
    return new Map();
  }
  if (info.call.arguments.length === 0) {
    return new Map();
  }
  const firstArg = info.call.arguments[0];
  if (!firstArg) {
    return new Map();
  }
  if (ts.isStringLiteralLike(firstArg)) {
    return new Map([["name", firstArg]]);
  }
  if (!ts.isObjectLiteralExpression(firstArg)) {
    failAgentParse(state, context, "@Task codegen supports a string literal or object literal options only.");
    return undefined;
  }
  return readObjectLiteralProperties(firstArg, "@Task", state, context);
}

function methodNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return undefined;
}

function isStaticOrPrivateMethod(node: ts.MethodDeclaration): boolean {
  const modifiers = ts.getModifiers(node) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword || modifier.kind === ts.SyntaxKind.PrivateKeyword);
}

function readFirstParameterTypeName(
  node: ts.MethodDeclaration,
  state: AgentParseState,
  context: AgentCodegenContext,
): string | undefined {
  const first = node.parameters[0];
  if (!first?.type) {
    return undefined;
  }
  return readTypeReferenceName(first.type, "task input", state, context);
}

function readReturnTypeName(
  node: ts.MethodDeclaration,
  state: AgentParseState,
  context: AgentCodegenContext,
): string | undefined {
  if (!node.type) {
    return undefined;
  }
  return readTypeReferenceName(node.type, "task output", state, context);
}

function readTypeReferenceName(
  type: ts.TypeNode,
  field: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): string | undefined {
  if (!ts.isTypeReferenceNode(type)) {
    failAgentParse(state, context, `${field} must be a class type reference.`);
    return undefined;
  }
  if (!ts.isIdentifier(type.typeName)) {
    failAgentParse(state, context, `${field} must be a class type identifier.`);
    return undefined;
  }
  if (type.typeName.text === "Promise") {
    const inner = type.typeArguments?.[0];
    if (!inner) {
      failAgentParse(state, context, `${field} Promise<T> must declare T.`);
      return undefined;
    }
    return readTypeReferenceName(inner, field, state, context);
  }
  return type.typeName.text;
}

function parseToolMetadata(
  source: ts.SourceFile,
  node: ts.ClassDeclaration & { readonly name: ts.Identifier },
  info: { name: string; call?: ts.CallExpression },
  context: AgentCodegenContext,
): ToolCodegenMetadata | undefined {
  const state: AgentParseState = { source, node, decorator: "@Tool", className: node.name.text, ok: true };
  const properties = readDecoratorProperties(info, state, context, false);
  if (!state.ok || properties === undefined) {
    return undefined;
  }

  const name = readRequiredStringProperty(properties, "name", state, context);
  const description = readRequiredStringProperty(properties, "description", state, context);
  const input = readOptionalClassProperty(properties, "input", state, context);
  const output = readOptionalClassProperty(properties, "output", state, context);
  const sideEffect = readOptionalStringProperty(properties, "sideEffect", state, context) ?? "none";
  const approval = readOptionalStringProperty(properties, "approval", state, context);
  const timeoutMs = readOptionalPositiveIntegerProperty(properties, "timeoutMs", state, context);
  const tags = readOptionalStringArrayProperty(properties, "tags", state, context) ?? [];

  if (sideEffect !== "none" && sideEffect !== "read" && sideEffect !== "write" && sideEffect !== "external") {
    failAgentParse(state, context, `sideEffect must be one of "none", "read", "write", "external".`);
  }
  if (approval !== undefined && approval !== "never" && approval !== "policy" && approval !== "required") {
    failAgentParse(state, context, `approval must be one of "never", "policy", "required".`);
  }
  if ((sideEffect === "write" || sideEffect === "external") && approval === "never") {
    failAgentParse(state, context, `write/external tools cannot use approval: "never".`);
  }

  if (!state.ok || name === undefined || description === undefined) {
    return undefined;
  }

  const resolvedSideEffect = sideEffect as ToolCodegenMetadata["sideEffect"];
  const resolvedApproval = (approval ??
    (sideEffect === "write" || sideEffect === "external" ? "required" : "policy")) as ToolCodegenMetadata["approval"];
  return {
    name,
    description,
    input,
    output,
    sideEffect: resolvedSideEffect,
    approval: resolvedApproval,
    timeoutMs,
    tags,
  };
}

function parsePromptMetadata(
  source: ts.SourceFile,
  node: ts.ClassDeclaration & { readonly name: ts.Identifier },
  info: { name: string; call?: ts.CallExpression },
  context: AgentCodegenContext,
): PromptCodegenMetadata | undefined {
  const state: AgentParseState = { source, node, decorator: "@Prompt", className: node.name.text, ok: true };
  const properties = readDecoratorProperties(info, state, context, true);
  if (!state.ok || properties === undefined) {
    return undefined;
  }

  const name = readOptionalStringProperty(properties, "name", state, context) ?? node.name.text;
  const description = readOptionalStringProperty(properties, "description", state, context);
  const version = readOptionalStringProperty(properties, "version", state, context);
  const role = readOptionalStringProperty(properties, "role", state, context);
  const goal = readOptionalStringProperty(properties, "goal", state, context);
  const instructions = readOptionalStringArrayProperty(properties, "instructions", state, context) ?? [];
  const constraints = readOptionalStringArrayProperty(properties, "constraints", state, context) ?? [];
  const sections = readOptionalPromptSectionArrayProperty(properties, "sections", state, context) ?? [];

  if (!state.ok) {
    return undefined;
  }
  return { name, description, version, role, goal, instructions, constraints, sections };
}

function readDecoratorProperties(
  info: { name: string; call?: ts.CallExpression },
  state: AgentParseState,
  context: AgentCodegenContext,
  allowEmpty: boolean,
): Map<string, ts.Expression> | undefined {
  if (!info.call) {
    failAgentParse(state, context, `${state.decorator} must be called as ${state.decorator}(...).`);
    return undefined;
  }
  if (info.call.arguments.length === 0) {
    if (allowEmpty) {
      return new Map();
    }
    failAgentParse(state, context, `${state.decorator} requires an object literal argument.`);
    return undefined;
  }

  const firstArg = info.call.arguments[0];
  if (!firstArg || !ts.isObjectLiteralExpression(firstArg)) {
    failAgentParse(state, context, `${state.decorator} codegen supports object literal options only.`);
    return undefined;
  }

  const properties = new Map<string, ts.Expression>();
  for (const property of firstArg.properties) {
    if (!ts.isPropertyAssignment(property)) {
      failAgentParse(state, context, `${state.decorator} codegen does not support shorthand or spread properties.`);
      return undefined;
    }
    const name = propertyNameText(property.name);
    if (name === undefined) {
      failAgentParse(state, context, `${state.decorator} contains an unsupported property name.`);
      return undefined;
    }
    properties.set(name, property.initializer);
  }
  return properties;
}

function readObjectLiteralProperties(
  expression: ts.Expression,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): Map<string, ts.Expression> | undefined {
  if (!ts.isObjectLiteralExpression(expression)) {
    failAgentParse(state, context, `${name} must be an object literal.`);
    return undefined;
  }
  const properties = new Map<string, ts.Expression>();
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      failAgentParse(state, context, `${name} codegen does not support shorthand or spread properties.`);
      return undefined;
    }
    const propertyName = propertyNameText(property.name);
    if (propertyName === undefined) {
      failAgentParse(state, context, `${name} contains an unsupported property name.`);
      return undefined;
    }
    properties.set(propertyName, property.initializer);
  }
  return properties;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return undefined;
}

function readRequiredStringProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): string | undefined {
  const expression = properties.get(name);
  if (!expression) {
    failAgentParse(state, context, `${name} is required.`);
    return undefined;
  }
  return readStringExpression(expression, name, state, context);
}

function readOptionalStringProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): string | undefined {
  const expression = properties.get(name);
  if (!expression) {
    return undefined;
  }
  return readStringExpression(expression, name, state, context);
}

function readStringExpression(
  expression: ts.Expression,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): string | undefined {
  if (!ts.isStringLiteralLike(expression)) {
    failAgentParse(state, context, `${name} must be a string literal.`);
    return undefined;
  }
  const value = expression.text.trim();
  if (value.length === 0) {
    failAgentParse(state, context, `${name} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

function readOptionalStringArrayProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): readonly string[] | undefined {
  const expression = properties.get(name);
  if (!expression) {
    return undefined;
  }
  if (!ts.isArrayLiteralExpression(expression)) {
    failAgentParse(state, context, `${name} must be an array literal.`);
    return undefined;
  }
  const values: string[] = [];
  for (const element of expression.elements) {
    const value = readStringExpression(element, name, state, context);
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

function readOptionalPromptSectionArrayProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): readonly PromptSectionCodegenMetadata[] | undefined {
  const expression = properties.get(name);
  if (!expression) {
    return undefined;
  }
  if (!ts.isArrayLiteralExpression(expression)) {
    failAgentParse(state, context, `${name} must be an array literal.`);
    return undefined;
  }

  const values: PromptSectionCodegenMetadata[] = [];
  for (let index = 0; index < expression.elements.length; index += 1) {
    const element = expression.elements[index] as ts.Expression;
    const sectionProperties = readObjectLiteralProperties(element, `${name}[${index}]`, state, context);
    if (sectionProperties === undefined) {
      continue;
    }
    const kind = readRequiredPromptSectionKindProperty(sectionProperties, "kind", state, context);
    const title = readOptionalStringProperty(sectionProperties, "title", state, context);
    const content = readRequiredStringOrStringArrayProperty(sectionProperties, "content", state, context);
    const priority = readOptionalPositiveIntegerProperty(sectionProperties, "priority", state, context);
    if (kind !== undefined && content !== undefined) {
      values.push({ kind, title, content, priority });
    }
  }
  return values;
}

function readRequiredPromptSectionKindProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): PromptSectionCodegenKind | undefined {
  const value = readRequiredStringProperty(properties, name, state, context);
  if (value === undefined) {
    return undefined;
  }
  if (!isPromptSectionKind(value)) {
    failAgentParse(
      state,
      context,
      `${name} must be one of "system", "developer", "role", "task", "instructions", "constraints", "examples", "output", "tool-policy", "memory", "knowledge".`,
    );
    return undefined;
  }
  return value;
}

function isPromptSectionKind(value: string): value is PromptSectionCodegenKind {
  return (
    value === "system" ||
    value === "developer" ||
    value === "role" ||
    value === "task" ||
    value === "instructions" ||
    value === "constraints" ||
    value === "examples" ||
    value === "output" ||
    value === "tool-policy" ||
    value === "memory" ||
    value === "knowledge"
  );
}

function readRequiredStringOrStringArrayProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): readonly string[] | undefined {
  const expression = properties.get(name);
  if (!expression) {
    failAgentParse(state, context, `${name} is required.`);
    return undefined;
  }
  if (ts.isStringLiteralLike(expression)) {
    const value = readStringExpression(expression, name, state, context);
    return value === undefined ? undefined : [value];
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: string[] = [];
    for (const element of expression.elements) {
      const value = readStringExpression(element, name, state, context);
      if (value !== undefined) {
        values.push(value);
      }
    }
    return values;
  }
  failAgentParse(state, context, `${name} must be a string literal or an array literal.`);
  return undefined;
}

function readOptionalClassProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): string | undefined {
  const expression = properties.get(name);
  if (!expression) {
    return undefined;
  }
  return readClassReferenceExpression(expression, name, state, context);
}

function readOptionalClassArrayProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): readonly string[] | undefined {
  const expression = properties.get(name);
  if (!expression) {
    return undefined;
  }
  if (!ts.isArrayLiteralExpression(expression)) {
    failAgentParse(state, context, `${name} must be an array literal.`);
    return undefined;
  }
  const values: string[] = [];
  for (const element of expression.elements) {
    const value = readClassReferenceExpression(element, name, state, context);
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

function readClassReferenceExpression(
  expression: ts.Expression,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): string | undefined {
  if (!ts.isIdentifier(expression)) {
    failAgentParse(state, context, `${name} must be a class identifier.`);
    return undefined;
  }
  return expression.text;
}

function readOptionalPositiveIntegerProperty(
  properties: ReadonlyMap<string, ts.Expression>,
  name: string,
  state: AgentParseState,
  context: AgentCodegenContext,
): number | undefined {
  const expression = properties.get(name);
  if (!expression) {
    return undefined;
  }
  if (!ts.isNumericLiteral(expression)) {
    failAgentParse(state, context, `${name} must be a positive integer literal.`);
    return undefined;
  }
  const value = Number(expression.text);
  if (!Number.isInteger(value) || value <= 0) {
    failAgentParse(state, context, `${name} must be a positive integer literal.`);
    return undefined;
  }
  return value;
}

function failAgentParse(state: AgentParseState, context: AgentCodegenContext, message: string): void {
  state.ok = false;
  context.warnings.push(`${state.decorator} ${state.className} (${sourceLocation(state.source, state.node)}): ${message}`);
}

function sourceLocation(source: ts.SourceFile, node: ts.Node): string {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${source.fileName}:${position.line + 1}:${position.character + 1}`;
}

function renderAgentCatalog(context: AgentCodegenContext): RenderedAgentCatalog {
  const imports = new Map<string, Set<string>>();
  const validAgents = filterImportableAgentEntries(context.agents, imports, context);
  const validTools = filterImportableToolEntries(context.tools, imports, context);
  const validPrompts = filterImportablePromptEntries(context.prompts, imports, context);

  const lines: string[] = [];
  lines.push("// This file is auto-generated by `bun run di:generate`.");
  lines.push("// Do not edit manually.");
  lines.push("");
  if (context.frameworkImports === "public") {
    lines.push('import type { Class } from "osnv/core/di";');
    lines.push('import type { AgentMetadata, AgentMetadataIndex, PromptMetadata, ToolMetadata } from "osnv/core/agent";');
  } else {
    // The core catalog ships inside the standalone `osnv` package, where
    // workspace-only `@/` aliases do not exist.
    lines.push('import type { Class } from "../../di";');
    lines.push('import type { AgentMetadataIndex } from "../AgentRegistry";');
    lines.push('import type { AgentMetadata, PromptMetadata, ToolMetadata } from "../metadata";');
  }
  for (const importPath of [...imports.keys()].sort((a, b) => a.localeCompare(b))) {
    const classNames = [...(imports.get(importPath) as Set<string>)].sort((a, b) => a.localeCompare(b));
    lines.push(`import { ${classNames.join(", ")} } from ${JSON.stringify(importPath)};`);
  }
  lines.push("");
  lines.push("function readonlyMetadataMap<K, V>(entries: readonly (readonly [K, V])[]): ReadonlyMap<K, V> {");
  lines.push("  const lookup = new Map<K, V>(entries);");
  lines.push("  const facade: ReadonlyMap<K, V> = {");
  lines.push("    get size() { return lookup.size; }, has: (key) => lookup.has(key), get: (key) => lookup.get(key),");
  lines.push("    entries: () => lookup.entries(), keys: () => lookup.keys(), values: () => lookup.values(),");
  lines.push("    forEach: (callback, thisArg) => { for (const [key, value] of lookup) callback.call(thisArg, value, key, facade); },");
  lines.push("    [Symbol.iterator]: () => lookup[Symbol.iterator](),");
  lines.push("  };");
  lines.push("  return Object.freeze(facade);");
  lines.push("}");
  lines.push("");
  lines.push("export const GENERATED_AGENT_METADATA: AgentMetadataIndex = Object.freeze({");
  lines.push("  agents: readonlyMetadataMap<Class<object>, AgentMetadata>([");
  for (const entry of validAgents) {
    lines.push(`    [${entry.className}, Object.freeze(${renderAgentMetadataLiteral(entry.metadata)})],`);
  }
  lines.push("  ]),");
  lines.push("  tools: readonlyMetadataMap<Class<object>, ToolMetadata>([");
  for (const entry of validTools) {
    lines.push(`    [${entry.className}, Object.freeze(${renderToolMetadataLiteral(entry.metadata)})],`);
  }
  lines.push("  ]),");
  lines.push("  prompts: readonlyMetadataMap<Class<object>, PromptMetadata>([");
  for (const entry of validPrompts) {
    lines.push(`    [${entry.className}, Object.freeze(${renderPromptMetadataLiteral(entry.metadata)})],`);
  }
  lines.push("  ]),");
  lines.push("});");
  lines.push("");
  return {
    output: lines.join("\n"),
    agentCount: validAgents.length,
    toolCount: validTools.length,
    promptCount: validPrompts.length,
  };
}

function filterImportableAgentEntries(
  entries: readonly AgentCodegenEntry[],
  imports: Map<string, Set<string>>,
  context: AgentCodegenContext,
): AgentCodegenEntry[] {
  const result: AgentCodegenEntry[] = [];
  for (const entry of entries) {
    if (!canImportClass(entry.className, entry.className, "agent class", context)) {
      continue;
    }
    const refs = [
      entry.metadata.prompt,
      entry.metadata.input,
      entry.metadata.output,
      ...(entry.metadata.tools ?? []),
      ...entry.metadata.tasks.flatMap((task) => [task.input, task.output]),
    ].filter((value): value is string => value !== undefined);
    if (!canImportAllReferences(refs, entry.className, context)) {
      continue;
    }
    addGeneratedImport(imports, entry.className, entry.filePath, context);
    addGeneratedImportsByName(imports, refs, context);
    result.push(entry);
  }
  return result;
}

function filterImportableToolEntries(
  entries: readonly ToolCodegenEntry[],
  imports: Map<string, Set<string>>,
  context: AgentCodegenContext,
): ToolCodegenEntry[] {
  const result: ToolCodegenEntry[] = [];
  for (const entry of entries) {
    if (!canImportClass(entry.className, entry.className, "tool class", context)) {
      continue;
    }
    const refs = [entry.metadata.input, entry.metadata.output].filter((value): value is string => value !== undefined);
    if (!canImportAllReferences(refs, entry.className, context)) {
      continue;
    }
    addGeneratedImport(imports, entry.className, entry.filePath, context);
    addGeneratedImportsByName(imports, refs, context);
    result.push(entry);
  }
  return result;
}

function filterImportablePromptEntries(
  entries: readonly PromptCodegenEntry[],
  imports: Map<string, Set<string>>,
  context: AgentCodegenContext,
): PromptCodegenEntry[] {
  const result: PromptCodegenEntry[] = [];
  for (const entry of entries) {
    if (!canImportClass(entry.className, entry.className, "prompt class", context)) {
      continue;
    }
    addGeneratedImport(imports, entry.className, entry.filePath, context);
    result.push(entry);
  }
  return result;
}

function canImportAllReferences(
  classNames: readonly string[],
  owner: string,
  context: AgentCodegenContext,
): boolean {
  for (let index = 0; index < classNames.length; index += 1) {
    const className = classNames[index] as string;
    if (!canImportClass(className, owner, "referenced class", context)) {
      return false;
    }
  }
  return true;
}

function canImportClass(className: string, owner: string, role: string, context: AgentCodegenContext): boolean {
  if (context.ambiguousClassNames.has(className)) {
    context.warnings.push(`agent codegen: ${owner} uses ambiguous ${role} "${className}" declared in more than one file.`);
    return false;
  }
  if (!context.classFilesByName.has(className)) {
    context.warnings.push(`agent codegen: ${owner} references ${role} "${className}", but it was not found in scanned sources.`);
    return false;
  }
  if (!context.namedExportedClassNames.has(className)) {
    context.warnings.push(`agent codegen: ${owner} references ${role} "${className}", but it is not a named export.`);
    return false;
  }
  return true;
}

function addGeneratedImportsByName(
  imports: Map<string, Set<string>>,
  classNames: readonly string[],
  context: AgentCodegenContext,
): void {
  for (let index = 0; index < classNames.length; index += 1) {
    const className = classNames[index] as string;
    const filePath = context.classFilesByName.get(className);
    if (filePath !== undefined) {
      addGeneratedImport(imports, className, filePath, context);
    }
  }
}

function addGeneratedImport(
  imports: Map<string, Set<string>>,
  className: string,
  filePath: string,
  context: AgentCodegenContext,
): void {
  const importPath = toModuleSpecifierFrom(context.generatedDir, filePath);
  let classNames = imports.get(importPath);
  if (!classNames) {
    classNames = new Set<string>();
    imports.set(importPath, classNames);
  }
  classNames.add(className);
}

function toModuleSpecifierFrom(fromDir: string, filePath: string): string {
  const withoutExt = filePath.replace(/\.tsx?$/, "");
  let relative = path.relative(fromDir, withoutExt).replaceAll("\\", "/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
}

function renderAgentMetadataLiteral(metadata: AgentCodegenMetadata): string {
  const properties = [
    `name: ${JSON.stringify(metadata.name)}`,
    renderOptionalStringProperty("description", metadata.description),
    renderOptionalStringProperty("role", metadata.role),
    renderOptionalStringProperty("goal", metadata.goal),
    `instructions: ${renderStringArray(metadata.instructions)}`,
    `constraints: ${renderStringArray(metadata.constraints)}`,
    `sections: ${renderPromptSections(metadata.sections)}`,
    renderOptionalClassProperty("prompt", metadata.prompt),
    `tools: ${renderClassArray(metadata.tools ?? [])}`,
    renderOptionalClassProperty("input", metadata.input),
    renderOptionalClassProperty("output", metadata.output),
    renderOptionalStringProperty("modelProfile", metadata.modelProfile),
    renderOptionalNumberProperty("maxSteps", metadata.maxSteps),
    `tasks: ${renderAgentTasks(metadata.tasks)}`,
  ].filter((line): line is string => line !== undefined);
  return `{ ${properties.join(", ")} }`;
}

function renderAgentTasks(values: readonly AgentTaskCodegenMetadata[]): string {
  return `Object.freeze([${values.map((value) => `Object.freeze(${renderAgentTaskLiteral(value)})`).join(", ")}])`;
}

function renderAgentTaskLiteral(value: AgentTaskCodegenMetadata): string {
  const properties = [
    `name: ${JSON.stringify(value.name)}`,
    `methodName: ${JSON.stringify(value.methodName)}`,
    renderOptionalStringProperty("description", value.description),
    renderOptionalClassProperty("input", value.input),
    renderOptionalClassProperty("output", value.output),
    renderOptionalStringProperty("modelProfile", value.modelProfile),
    renderOptionalNumberProperty("maxSteps", value.maxSteps),
  ].filter((line): line is string => line !== undefined);
  return `{ ${properties.join(", ")} }`;
}

function renderToolMetadataLiteral(metadata: ToolCodegenMetadata): string {
  const properties = [
    `name: ${JSON.stringify(metadata.name)}`,
    `description: ${JSON.stringify(metadata.description)}`,
    renderOptionalClassProperty("input", metadata.input),
    renderOptionalClassProperty("output", metadata.output),
    `sideEffect: ${JSON.stringify(metadata.sideEffect)}`,
    `approval: ${JSON.stringify(metadata.approval)}`,
    renderOptionalNumberProperty("timeoutMs", metadata.timeoutMs),
    `tags: ${renderStringArray(metadata.tags)}`,
  ].filter((line): line is string => line !== undefined);
  return `{ ${properties.join(", ")} }`;
}

function renderPromptMetadataLiteral(metadata: PromptCodegenMetadata): string {
  const properties = [
    `name: ${JSON.stringify(metadata.name)}`,
    renderOptionalStringProperty("description", metadata.description),
    renderOptionalStringProperty("version", metadata.version),
    renderOptionalStringProperty("role", metadata.role),
    renderOptionalStringProperty("goal", metadata.goal),
    `instructions: ${renderStringArray(metadata.instructions)}`,
    `constraints: ${renderStringArray(metadata.constraints)}`,
    `sections: ${renderPromptSections(metadata.sections)}`,
  ].filter((line): line is string => line !== undefined);
  return `{ ${properties.join(", ")} }`;
}

function renderOptionalStringProperty(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${name}: ${JSON.stringify(value)}`;
}

function renderOptionalClassProperty(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${name}: ${value}`;
}

function renderOptionalNumberProperty(name: string, value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${name}: ${value}`;
}

function renderClassArray(values: readonly string[]): string {
  return `Object.freeze([${values.join(", ")}])`;
}

function renderStringArray(values: readonly string[]): string {
  return `Object.freeze([${values.map((value) => JSON.stringify(value)).join(", ")}])`;
}

function renderPromptSections(values: readonly PromptSectionCodegenMetadata[]): string {
  return `Object.freeze([${values.map((value) => `Object.freeze(${renderPromptSectionLiteral(value)})`).join(", ")}])`;
}

function renderPromptSectionLiteral(value: PromptSectionCodegenMetadata): string {
  const properties = [
    `kind: ${JSON.stringify(value.kind)}`,
    renderOptionalStringProperty("title", value.title),
    `content: ${renderStringArray(value.content)}`,
    renderOptionalNumberProperty("priority", value.priority),
  ].filter((line): line is string => line !== undefined);
  return `{ ${properties.join(", ")} }`;
}
