import type { ModuleNaming } from "../naming";
import { modulePassport } from "./passport";

export type ModuleTemplateProfile = "empty" | "minimal" | "full";

export interface ModuleTemplateFiles {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * Feature module scaffold.
 *
 * `minimal` (default): a compact CRUD that is easy to read and adapt.
 * `empty`: the entry point and passport. `full`: a showcase with
 * auth/cache/background/JSON:API list and an AI entry in the same feature.
 */
export function buildModuleTemplates(
  naming: ModuleNaming,
  profile: ModuleTemplateProfile = "minimal",
  /** null: the host has no auth helpers, so `full` emits no @Authorize. */
  authImportPath: string | null = "../../auth",
): readonly ModuleTemplateFiles[] {
  const { entity } = naming;

  if (profile === "empty") {
    return [
      { relativePath: `${naming.module}.module.ts`, content: `import { Module } from "osnv/core/di";\n\n@Module({ imports: [], exports: [] })\nexport class ${naming.moduleClass} {}\n` },
      { relativePath: "MODULE.md", content: modulePassport(naming, profile) },
    ];
  }

  const base: ModuleTemplateFiles[] = [
    { relativePath: `${naming.module}.module.ts`, content: moduleFile(naming, profile) },
    { relativePath: `model/${entity}.model.ts`, content: ormModelFile(naming, profile) },
    { relativePath: `model/${entity}DbContext.ts`, content: dbContextFile(naming) },
    { relativePath: `services/I${entity}.service.ts`, content: serviceInterfaceFile(naming) },
    { relativePath: `services/${entity}.service.ts`, content: serviceFile(naming, profile) },
    { relativePath: `http/${entity}Controller.ts`, content: controllerFile(naming, profile, authImportPath) },
    { relativePath: `http/contracts/${entity}Requests.ts`, content: requestFile(naming) },
    { relativePath: `http/contracts/${entity}Responses.ts`, content: responseFile(naming) },
    { relativePath: `http/contracts/${entity}ListQuery.ts`, content: listQueryFile(naming) },
    { relativePath: "MODULE.md", content: modulePassport(naming, profile) },
  ];

  if (profile === "minimal") {
    return base;
  }

  return [
    ...base,
    { relativePath: `background/${entity}StatsReporter.ts`, content: statsReporterFile(naming) },
    { relativePath: `ai/agents/${entity}AnalystAgent.ts`, content: agentFile(naming) },
    { relativePath: `ai/contracts/${entity}Brief.ts`, content: aiContractsFile(naming) },
    { relativePath: `ai/tools/${entity}SummaryTool.ts`, content: aiToolFile(naming) },
  ];
}

function moduleFile(n: ModuleNaming, profile: ModuleTemplateProfile): string {
  const cacheImport = profile === "full" ? "import { cachedScoped } from \"osnv/core/cache\";\n" : "";
  const moduleImport = "import { Module, scoped } from \"osnv/core/di\";";
  const providerFactory = profile === "full" ? "cachedScoped" : "scoped";
  const backgroundImport = profile === "full" ? `import { ${n.entity}StatsReporter } from "./background/${n.entity}StatsReporter";\n` : "";
  const aiImports = profile === "full"
    ? `import { ${n.entity}AnalystAgent } from "./ai/agents/${n.entity}AnalystAgent";
import { ${n.entity}SummaryTool } from "./ai/tools/${n.entity}SummaryTool";
`
    : "";
  const backgroundLine = profile === "full" ? `  background: [${n.entity}StatsReporter],\n` : "";
  const aiLines = profile === "full"
    ? `  agents: [${n.entity}AnalystAgent],
  tools: [${n.entity}SummaryTool],
`
    : "";

  return `${cacheImport}${moduleImport}
${aiImports}${backgroundImport}import { ${n.entity}Controller } from "./http/${n.entity}Controller";
import { ${n.entity} } from "./model/${n.entity}.model";
import { ${n.entity}DbContext } from "./model/${n.entity}DbContext";
import { I${n.entity}Service } from "./services/I${n.entity}.service";
import { ${n.entity}Service } from "./services/${n.entity}.service";

@Module({
  ormOsnova: {
    context: ${n.entity}DbContext,
    entities: [${n.entity}],
  },
  controllers: [${n.entity}Controller],
  providers: [
    ${providerFactory}(I${n.entity}Service, ${n.entity}Service),
  ],
${backgroundLine}${aiLines}  exports: [I${n.entity}Service],
})
export class ${n.moduleClass} {}
`;
}

function controllerFile(n: ModuleNaming, profile: ModuleTemplateProfile, authImportPath: string | null): string {
  const auth = profile === "full" && authImportPath !== null;
  const fullImports = profile !== "full"
    ? "import { Controller, Created, Delete, Get, HttpContext, NoContent, NotFound, Ok, Post, Put } from \"osnv/core/http\";\n"
    : auth
      ? `import { OutputCache } from "osnv/core/cache";
import { Authorize, Controller, Created, Delete, Get, HttpContext, NoContent, NotFound, Ok, Post, Put } from "osnv/core/http";
import { TokenKind } from "${authImportPath}/tokenKinds";
import { requireTokenKind } from "${authImportPath}/jwtAuth";
`
      : `import { OutputCache } from "osnv/core/cache";
import { Controller, Created, Delete, Get, HttpContext, NoContent, NotFound, Ok, Post, Put } from "osnv/core/http";
// No host auth helpers (src/app/modules/auth) were found: these routes are public.
// Add @Authorize(...) from "osnv/core/http" with your policy before exposing them.
`;
  const authList = profile === "full"
    ? `${auth ? "  @Authorize(requireTokenKind(TokenKind.Admin, TokenKind.Client))\n" : ""}  @OutputCache({ seconds: 30, varyByQuery: "*", varyByUser: true, tags: ["${n.route}"] })
`
    : "";
  const authRead = auth ? "  @Authorize(requireTokenKind(TokenKind.Admin, TokenKind.Client))\n" : "";
  const authWrite = auth ? "  @Authorize(requireTokenKind(TokenKind.Admin))\n" : "";

  return `${fullImports}import { buildListDocument } from "osnv/library/jsonapi";
import { ${n.entity}ListQuery } from "./contracts/${n.entity}ListQuery";
import { Create${n.entity}Request, Update${n.entity}Request } from "./contracts/${n.entity}Requests";
import type { I${n.entity}Service } from "../services/I${n.entity}.service";

@Controller("${n.route}")
export class ${n.entity}Controller {
  constructor(private readonly ${n.collection}: I${n.entity}Service) {}

${authList}  @Get()
  async list(query: ${n.entity}ListQuery, ctx: HttpContext) {
    const { items, total } = await this.${n.collection}.getAll(query);
    return buildListDocument(items, query, total, { basePath: ctx.path });
  }

${authRead}  @Get(":id(uuid)")
  async getById(id: string) {
    const item = await this.${n.collection}.getById(id);
    return item ? Ok(item) : NotFound({ error: \`${n.entity.toLowerCase()} \${id} not found\` });
  }

${authWrite}  @Post()
  async create(body: Create${n.entity}Request, ctx: HttpContext) {
    const item = await this.${n.collection}.create(body);
    return Created(\`\${ctx.path.replace(/\\/$/, "")}/\${item.id}\`, item);
  }

${authWrite}  @Put(":id(uuid)")
  async update(id: string, body: Update${n.entity}Request) {
    const item = await this.${n.collection}.update(id, body);
    return item ? Ok(item) : NotFound({ error: \`${n.entity.toLowerCase()} \${id} not found\` });
  }

${authWrite}  @Delete(":id(uuid)")
  async delete(id: string) {
    const removed = await this.${n.collection}.delete(id);
    return removed ? NoContent() : NotFound({ error: \`${n.entity.toLowerCase()} \${id} not found\` });
  }
}
`;
}

function ormModelFile(n: ModuleNaming, profile: ModuleTemplateProfile): string {
  const schemaImport = profile === "full" ? ", Schema" : "";
  const schemaDecorator = profile === "full" ? `@Schema("${n.dbSchema}")\n` : "";
  return `import { Column, Entity, Index, UUID${schemaImport} } from "osnv/core/orm";

${schemaDecorator}@Entity({ migrate: true, table: "${n.route}" })
export class ${n.entity} {
  @UUID()
  id = "";

  @Column({ type: "text" })
  name = "";

  @Index({ unique: true })
  @Column({ type: "text" })
  email = "";

  @Column({ type: "createdAt" })
  createdAt = new Date(0);

  @Column({ type: "updatedAt" })
  updatedAt = new Date(0);
}
`;
}

function dbContextFile(n: ModuleNaming): string {
  return `import { DbContext } from "osnv/core/orm";
import { ${n.entity} } from "./${n.entity}.model";

export class ${n.entity}DbContext extends DbContext {
  readonly ${n.collection} = this.set(${n.entity});
}
`;
}

function serviceInterfaceFile(n: ModuleNaming): string {
  return `import { createToken } from "osnv/core/di";
import type { PageResult } from "osnv/core/orm";
import type { ListQuery } from "osnv/library/jsonapi";
import type { Create${n.entity}Request, Update${n.entity}Request } from "../http/contracts/${n.entity}Requests";
import type { ${n.entity}Response, ${n.entity}Summary } from "../http/contracts/${n.entity}Responses";

export interface I${n.entity}Service {
  getAll(query: ListQuery): Promise<PageResult<${n.entity}Response>>;
  summary(): Promise<${n.entity}Summary>;
  count(): Promise<number>;
  getById(id: string): Promise<${n.entity}Response | null>;
  create(body: Create${n.entity}Request): Promise<${n.entity}Response>;
  update(id: string, body: Update${n.entity}Request): Promise<${n.entity}Response | null>;
  delete(id: string): Promise<boolean>;
}

export const I${n.entity}Service = createToken<I${n.entity}Service>("I${n.entity}Service");
`;
}

function serviceFile(n: ModuleNaming, profile: ModuleTemplateProfile): string {
  const imports = profile === "full"
    ? `import { Cacheable, type ICache } from "osnv/core/cache";\n`
    : "";
  const cacheDecorator = profile === "full"
    ? `  @Cacheable({ seconds: 60, key: (id) => \`${n.route}:\${String(id)}\`, tags: ["${n.route}"] })
`
    : "";
  const invalidateCache = profile === "full" ? `\n    this.cache.evictByTag("${n.route}");` : "";

  return `${imports}import { paginate, type PageResult } from "osnv/core/orm";
import type { ListQuery } from "osnv/library/jsonapi";
import type { Create${n.entity}Request, Update${n.entity}Request } from "../http/contracts/${n.entity}Requests";
import { to${n.entity}Response, type ${n.entity}Response, type ${n.entity}Summary } from "../http/contracts/${n.entity}Responses";
import { ${n.entity} } from "../model/${n.entity}.model";
import { ${n.entity}DbContext } from "../model/${n.entity}DbContext";
import type { I${n.entity}Service } from "./I${n.entity}.service";

export class ${n.entity}Service implements I${n.entity}Service {
  constructor(private readonly db: ${n.entity}DbContext${profile === "full" ? ", private readonly cache: ICache" : ""}) {}

  async getAll(query: ListQuery): Promise<PageResult<${n.entity}Response>> {
    const { items, total } = await paginate(this.db.${n.collection}.asNoTracking(), query);
    return { items: items.map(to${n.entity}Response), total };
  }

  async summary(): Promise<${n.entity}Summary> {
    const count = await this.count();
    const items = await this.db.${n.collection}.asNoTracking().orderBy(item => item.id).take(20)
      .select(item => ({ name: item.name })).toList();
    return {
      count,
      names: items.map((item) => item.name),
    };
  }

  count(): Promise<number> {
    return this.db.${n.collection}.count();
  }

${cacheDecorator}  async getById(id: string): Promise<${n.entity}Response | null> {
    const item = await this.db.${n.collection}.find(id);
    return item ? to${n.entity}Response(item) : null;
  }

  async create(body: Create${n.entity}Request): Promise<${n.entity}Response> {
    const item = Object.assign(new ${n.entity}(), {
      name: body.name,
      email: body.email,
    });
    this.db.${n.collection}.add(item);
    await this.db.saveChanges();${invalidateCache}
    return to${n.entity}Response(item);
  }

  async update(id: string, body: Update${n.entity}Request): Promise<${n.entity}Response | null> {
    const item = await this.db.${n.collection}.find(id);
    if (!item) {
      return null;
    }
    if (body.name !== undefined) {
      item.name = body.name;
    }
    if (body.email !== undefined) {
      item.email = body.email;
    }
    await this.db.saveChanges();${invalidateCache}
    return to${n.entity}Response(item);
  }

  async delete(id: string): Promise<boolean> {
    const item = await this.db.${n.collection}.find(id);
    if (!item) {
      return false;
    }
    this.db.${n.collection}.remove(item);
    await this.db.saveChanges();${invalidateCache}
    return true;
  }
}
`;
}

function requestFile(n: ModuleNaming): string {
  return `import { RequestModel } from "osnv/core/http";
import { Validator } from "osnv/library/validation";

@RequestModel()
export class Create${n.entity}Request {
  @Validator({ required: true, minLength: 2, maxLength: 100 })
  name!: string;

  @Validator({ required: true, email: true, minLength: 3, maxLength: 120 })
  email!: string;
}

@RequestModel()
export class Update${n.entity}Request {
  @Validator({ minLength: 2, maxLength: 100 })
  name?: string;

  @Validator({ email: true, minLength: 3, maxLength: 120 })
  email?: string;
}
`;
}

function responseFile(n: ModuleNaming): string {
  return `import type { ${n.entity} } from "../../model/${n.entity}.model";

export interface ${n.entity}Response {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ${n.entity}Summary {
  readonly count: number;
  readonly names: readonly string[];
}

export function to${n.entity}Response(entity: ${n.entity}): ${n.entity}Response {
  return {
    id: entity.id,
    name: entity.name,
    email: entity.email,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}
`;
}

function listQueryFile(n: ModuleNaming): string {
  return `import { Filterable, ListOptions, ListRequest, Sortable } from "osnv/core/http";
import type { ${n.entity} } from "../../model/${n.entity}.model";

@ListOptions({ defaultSize: 20, maxSize: 100 })
export class ${n.entity}ListQuery extends ListRequest<${n.entity}> {
  @Sortable()
  @Filterable("eq", "contains", "startsWith")
  name!: string;

  @Sortable()
  @Filterable("eq", "contains")
  email!: string;

  @Sortable()
  createdAt!: Date;
}
`;
}

function statsReporterFile(n: ModuleNaming): string {
  return `import { Background, PeriodicBackgroundService } from "osnv/core/background";
import type { ServiceProvider } from "osnv/core/di";
import type { Logger } from "osnv/core/kernel";
import { I${n.entity}Service } from "../services/I${n.entity}.service";

@Background({ intervalMs: 60_000, runImmediately: false })
export class ${n.entity}StatsReporter extends PeriodicBackgroundService {
  constructor(
    private readonly provider: ServiceProvider,
    private readonly logger: Logger,
  ) {
    super();
  }

  protected override async tick(signal: AbortSignal): Promise<void> {
    const scope = this.provider.createScope();
    try {
      const service = scope.resolve(I${n.entity}Service);
      const count = await service.count();
      if (!signal.aborted) {
        this.logger.info("${n.route}: records in database", { count });
      }
    } finally {
      await scope.dispose();
    }
  }
}
`;
}

function aiContractsFile(n: ModuleNaming): string {
  return `import { Validator } from "osnv/library/validation";

export class Prepare${n.entity}BriefRequest {
  @Validator({ required: true, minLength: 3 })
  topic!: string;

  @Validator({ required: true, minLength: 3 })
  audience = "operators";
}

export class ${n.entity}BriefDocument {
  title = "";
  bullets: string[] = [];
}
`;
}

function aiToolFile(n: ModuleNaming): string {
  return `import { Tool, type AgentToolExecutionContext } from "osnv/core/agent";
import { Validator } from "osnv/library/validation";
import type { I${n.entity}Service } from "../../services/I${n.entity}.service";

export class ${n.entity}SummaryToolInput {
  @Validator({ required: true, minLength: 3 })
  topic!: string;
}

export class ${n.entity}SummaryToolOutput {
  topic = "";
  count = 0;
  names: string[] = [];
  agentName = "";
}

@Tool({
  name: "${n.route}.summary",
  description: "Reads the ${n.route} summary through ${n.entity}Service.",
  input: ${n.entity}SummaryToolInput,
  output: ${n.entity}SummaryToolOutput,
  sideEffect: "read",
})
export class ${n.entity}SummaryTool {
  constructor(private readonly ${n.collection}: I${n.entity}Service) {}

  async execute(input: ${n.entity}SummaryToolInput, context: AgentToolExecutionContext): Promise<${n.entity}SummaryToolOutput> {
    const summary = await this.${n.collection}.summary();
    return Object.assign(new ${n.entity}SummaryToolOutput(), {
      topic: input.topic,
      count: summary.count,
      names: [...summary.names],
      agentName: context.agentName ?? "",
    });
  }
}
`;
}

function agentFile(n: ModuleNaming): string {
  return `import { Agent, Task, agentOutput } from "osnv/core/agent";
import { Prepare${n.entity}BriefRequest, ${n.entity}BriefDocument } from "../contracts/${n.entity}Brief";
import { ${n.entity}SummaryTool } from "../tools/${n.entity}SummaryTool";

@Agent({
  name: "${n.route}-analyst",
  role: "${n.route} analyst",
  sections: [
    {
      kind: "developer",
      content: "Write short, concrete operational summaries of the ${n.route} domain.",
    },
    {
      kind: "tool-policy",
      content: "Use read tools before the final summary. Do not make up data.",
    },
  ],
  tools: [${n.entity}SummaryTool],
  modelProfile: "reasoning",
  maxSteps: 3,
})
export class ${n.entity}AnalystAgent {
  @Task({
    name: "prepare-${n.route}-brief",
    description: "Prepare a short ${n.route} summary from the current module data.",
    input: Prepare${n.entity}BriefRequest,
    output: ${n.entity}BriefDocument,
    modelProfile: "reasoning",
    maxSteps: 3,
  })
  prepareBrief(_input: Prepare${n.entity}BriefRequest): ${n.entity}BriefDocument {
    return agentOutput();
  }
}
`;
}
