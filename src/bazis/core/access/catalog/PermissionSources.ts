import type { Class, ServiceProvider } from "../../di";
import { LOGGER, type ConfigView } from "../../kernel";
import type { AccessConfig } from "../check/accessConfig";
import type { PermissionSource } from "../contracts/PermissionSource";
import type { OwnedPermission } from "./AccessCatalog";
import { declarationsOf } from "./moduleFields";
import { frozenSpec, lookupsOf, permissionProblems, underPrefix, type PermissionSpec } from "./permissions";

/** A source of `@Module({ permissionSources })` with the module that declares it. */
export interface OwnedPermissionSource {
  readonly prefix: string;
  readonly type: Class<PermissionSource>;
  readonly module: string;
}

/** What is known about a source now: for `/health` and the administrator. */
export interface PermissionSourceState {
  readonly prefix: string;
  readonly module: string;
  /** Whether its permissions have been read at least once. */
  readonly loaded: boolean;
  /** The version of the data the permissions were read at. */
  readonly version: string | undefined;
  /** Why the last reading failed; the permissions read before it stay. */
  readonly error: string | undefined;
  readonly permissions: number;
}

interface Source extends OwnedPermissionSource {
  permissions: ReadonlyMap<string, OwnedPermission>;
  loaded: boolean;
  version: string | undefined;
  error: string | undefined;
  /** When the version was last compared, for the limit of {@link PermissionSources.verify}. */
  verifiedAt: number;
  /** Readings of one source go one after another. */
  queue: Promise<unknown>;
}

/** How often a missing key or attribute may ask a source for its version. */
const VERIFY_EVERY_MS = 1000;

/**
 * The permissions of the application's sources (ACCESS-001 §3.1): read before
 * the application takes requests, read again when a source's version changes.
 * A specification passes the checks of a declared one; a bad one is logged and
 * the permission does not exist — closed, never open. A reading that fails
 * leaves the permissions read before it.
 */
export class PermissionSources {
  private readonly sources: readonly Source[];
  private readonly kinds: ReadonlySet<string>;

  constructor(private readonly services: ServiceProvider, private readonly config: ConfigView<AccessConfig>) {
    const { sources, kinds } = declarationsOf(services);
    this.kinds = new Set(kinds.map((kind) => kind.kind));
    this.sources = [...sources]
      .sort((left, right) => left.prefix.localeCompare(right.prefix))
      .map((source) => ({ ...source, permissions: new Map(), loaded: false, version: undefined, error: undefined, verifiedAt: 0, queue: Promise.resolve() }));
  }

  /** The prefix of the source that owns the key, or `undefined` — the key is not of a source. */
  prefixOf(key: string): string | undefined {
    return this.sources.find((source) => underPrefix(key, source.prefix))?.prefix;
  }

  permission(key: string): OwnedPermission | undefined {
    for (const source of this.sources) if (underPrefix(key, source.prefix)) return source.permissions.get(key);
    return undefined;
  }

  permissions(): OwnedPermission[] {
    return this.sources.flatMap((source) => [...source.permissions.values()]);
  }

  state(): readonly PermissionSourceState[] {
    return this.sources.map(({ prefix, module, loaded, version, error, permissions }) => ({ prefix, module, loaded, version, error, permissions: permissions.size }));
  }

  /** The seconds between two questions about the versions; `0` — never ask. */
  get pollSeconds(): number {
    return this.sources.length === 0 ? 0 : this.config.get("sourcePollSeconds");
  }

  /** Reads every source: at start, before the application takes requests. */
  async load(): Promise<void> {
    await Promise.all(this.sources.map((source) => this.enqueue(source, () => this.read(source))));
  }

  /** Asks every source for its version and reads again the ones that changed or have not been read. */
  async poll(): Promise<void> {
    await Promise.all(this.sources.map((source) => this.enqueue(source, () => this.compare(source))));
  }

  /**
   * The source of the prefix changed. With `keys` only these permissions are
   * read now; the version stays the old one, so the next comparison reads the
   * whole prefix — another instance may have changed other keys meanwhile.
   */
  async changed(prefix: string, keys?: readonly string[]): Promise<void> {
    const source = this.sources.find((item) => item.prefix === prefix);
    if (source === undefined) throw new TypeError(`No permission source owns the prefix "${prefix}": name it in permissionSources of a module.`);
    await this.enqueue(source, () => (keys === undefined || !source.loaded ? this.read(source) : this.readKeys(source, keys)));
  }

  /**
   * Compares the version of the key's source before the catalog answers "no
   * such permission" or drops a grant: a table another instance has just
   * created must not wait for the poll. Not more often than once a second for
   * a prefix, unless `force`. `true` — the permissions were read again.
   */
  async verify(key: string, force = false): Promise<boolean> {
    const source = this.sources.find((item) => underPrefix(key, item.prefix));
    if (source === undefined) return false;
    return await this.enqueue(source, async () => {
      if (!force && Date.now() - source.verifiedAt < VERIFY_EVERY_MS) return false;
      return await this.compare(source);
    });
  }

  private enqueue<T>(source: Source, work: () => Promise<T>): Promise<T> {
    const result = source.queue.then(work);
    source.queue = result.catch(() => undefined);
    return result;
  }

  /** `true` — the version differed (or nothing was read yet) and the permissions were read again. */
  private async compare(source: Source): Promise<boolean> {
    source.verifiedAt = Date.now();
    if (source.loaded) {
      try {
        const version = await this.use(source, async (instance) => String(await instance.version()));
        if (version === source.version) {
          source.error = undefined;
          return false;
        }
      } catch (error) {
        this.failed(source, error);
        return false;
      }
    }
    return await this.read(source);
  }

  private async read(source: Source): Promise<boolean> {
    source.verifiedAt = Date.now();
    try {
      // The version first: data changed during the reading gives a newer version to the next comparison.
      const { version, declarations } = await this.use(source, async (instance) => ({ version: String(await instance.version()), declarations: await instance.load() }));
      if (typeof declarations !== "object" || declarations === null || Array.isArray(declarations)) throw new TypeError("load() must return an object: key → permission");
      const permissions = new Map<string, OwnedPermission>();
      for (const key of Object.keys(declarations).sort()) {
        const permission = this.accept(source, key, declarations[key]!);
        if (permission !== undefined) permissions.set(key, permission);
      }
      source.permissions = permissions;
      source.version = version;
      source.loaded = true;
      source.error = undefined;
      return true;
    } catch (error) {
      this.failed(source, error);
      return false;
    }
  }

  private async readKeys(source: Source, keys: readonly string[]): Promise<boolean> {
    try {
      const declarations = await this.use(source, async (instance) => await instance.load(keys));
      if (typeof declarations !== "object" || declarations === null || Array.isArray(declarations)) throw new TypeError("load(keys) must return an object: key → permission");
      const permissions = new Map(source.permissions);
      for (const key of keys) {
        const spec = Object.hasOwn(declarations, key) ? declarations[key] : undefined;
        const permission = spec === undefined ? undefined : this.accept(source, key, spec);
        if (permission === undefined) permissions.delete(key);
        else permissions.set(key, permission);
      }
      source.permissions = new Map([...permissions].sort(([left], [right]) => left.localeCompare(right)));
      return true;
    } catch (error) {
      this.failed(source, error);
      return false;
    }
  }

  /** The permission, or `undefined` with the problems logged: it does not exist then. */
  private accept(source: Source, key: string, spec: PermissionSpec): OwnedPermission | undefined {
    const problems = underPrefix(key, source.prefix) ? permissionProblems(key, spec) : [`permission "${key}": the key must start with "${source.prefix}."`];
    if (problems.length === 0) {
      for (const [name, attribute] of Object.entries(spec.on ?? {})) {
        if (attribute.ref !== undefined && !this.kinds.has(attribute.ref)) problems.push(`permission "${key}": attribute "${name}" refers to kind "${attribute.ref}", which no module declares in references`);
      }
      for (const lookup of lookupsOf(spec)) {
        if (!this.services.has(lookup)) problems.push(`permission "${key}": ${lookup.name} is not registered: add it to providers of ${source.module}`);
      }
    }
    if (problems.length > 0) {
      this.services.tryResolve(LOGGER)?.error("access permission of a source rejected", { source: source.prefix, module: source.module, permission: key, problems });
      return undefined;
    }
    return { key, spec: frozenSpec(spec), module: source.module, source: source.prefix };
  }

  private async use<T>(source: Source, work: (instance: PermissionSource) => Promise<T>): Promise<T> {
    const scope = this.services.createScope();
    try {
      return await work(scope.resolve(source.type));
    } finally {
      await scope.dispose();
    }
  }

  private failed(source: Source, error: unknown): void {
    source.error = error instanceof Error ? error.message : String(error);
    this.services.tryResolve(LOGGER)?.error("access permission source failed", {
      source: source.prefix,
      module: source.module,
      error: source.error,
      state: source.loaded ? "the permissions read before stay" : "the source has no permissions",
    });
  }
}
