import type { ConfigInspection } from "../config/defineConfig";

/**
 * What the application found and did while it started: connections, schema
 * changes, routes, listeners and warnings. Subsystems record facts here
 * (`InfraLifecycle`, `OrmLifecycle`, `HttpServer`); the kernel renders them as
 * the startup screen, or as one log line when the output is not a terminal.
 *
 * One report per kernel. It is registered in the container, so a subsystem
 * takes it with `resolver.has(StartupReport)` and records only when present.
 */
export class StartupReport {
  private readonly connectionList = new Map<string, ConnectionFact>();
  private readonly schemaList: SchemaFact[] = [];
  private readonly routeList: RouteFact[] = [];
  private readonly listenerList: ListenerFact[] = [];
  private readonly warningList: string[] = [];
  private readonly timingList: TimingFact[] = [];
  private configRows: readonly ConfigInspection[] = [];

  /**
   * Whether facts are rendered on the startup screen. Subsystems that used to
   * print their own lines (ORM schema changes) print them only when it is off.
   */
  constructor(public readonly screen: boolean = false) {}

  connection(fact: ConnectionFact): void {
    this.connectionList.set(fact.name, { ...this.connectionList.get(fact.name), ...fact });
  }

  schema(fact: SchemaFact): void {
    this.schemaList.push(fact);
  }

  routes(routes: readonly RouteFact[]): void {
    this.routeList.push(...routes);
  }

  listener(fact: ListenerFact): void {
    this.listenerList.push(fact);
  }

  warn(text: string): void {
    if (!this.warningList.includes(text)) this.warningList.push(text);
  }

  timing(fact: TimingFact): void {
    this.timingList.push(fact);
  }

  /** Resolved configuration keys with masked secrets, recorded when the kernel is built. */
  configuration(rows: readonly ConfigInspection[]): void {
    this.configRows = rows;
  }

  get config(): readonly ConfigInspection[] { return this.configRows; }

  get connections(): readonly ConnectionFact[] { return [...this.connectionList.values()]; }
  get schemas(): readonly SchemaFact[] { return this.schemaList; }
  get routeFacts(): readonly RouteFact[] { return this.routeList; }
  get listeners(): readonly ListenerFact[] { return this.listenerList; }
  get warnings(): readonly string[] { return this.warningList; }
  get timings(): readonly TimingFact[] { return this.timingList; }
}

/** A connection of the infrastructure manifest. */
export interface ConnectionFact {
  /** Manifest key: `db`, `cache`. */
  readonly name: string;
  readonly status: "up" | "down" | "wait";
  /** What it connects to, from the connector's `describe()`: `PostgreSQL 17.6`. */
  readonly kind?: string;
  /** Address without credentials: `postgres@127.0.0.1:55432/shop`. */
  readonly address?: string;
  /** Short facts: `pool 10`, `green`. */
  readonly details?: readonly string[];
  /** Environment variables that change the address, for fix hints. */
  readonly settings?: readonly string[];
  readonly ms?: number;
  readonly error?: unknown;
}

/** What a connector says about its connection, for the startup screen and failures. */
export interface ConnectionDescription {
  /** Product and version: `PostgreSQL 17.6`, `Redis 7.4`. */
  readonly kind?: string;
  /** Address without credentials. */
  readonly address?: string;
  readonly details?: readonly string[];
  /** Environment variables or config keys that change the address, for fix hints. */
  readonly settings?: readonly string[];
}

/** Schema work of one database context at start. */
export interface SchemaFact {
  readonly context: string;
  readonly mode: string;
  readonly applied: readonly string[];
  readonly migrated: readonly string[];
  readonly baselined: readonly string[];
  readonly warnings: readonly string[];
  readonly ms?: number;
}

export interface RouteFact {
  readonly method: string;
  readonly path: string;
  /** `TaskController.list`. */
  readonly handler: string;
  /** Not protected by `@Authorize`. */
  readonly open: boolean;
  /** Policy or roles for a protected route. */
  readonly access?: string;
  /** Request model, list query, cache. */
  readonly notes?: readonly string[];
  /** Built-in endpoints (`/health`, `/docs`) are listed separately. */
  readonly builtIn?: boolean;
}

export interface ListenerFact {
  readonly protocol: "http" | "grpc";
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly health?: string;
  readonly docs?: string;
}

/** Wall time of one startup stage. */
export interface TimingFact {
  readonly stage: "infrastructure" | "schema" | "services";
  readonly names: readonly string[];
  readonly ms: number;
}
