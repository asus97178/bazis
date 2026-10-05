import { describe, expect, test } from "bun:test";
import {
  DI,
  ModuleEncapsulationError,
  createContainer,
  createOpenGenericTokenFamily,
  createToken,
  singleton,
  type DiRegistrar,
} from "../index";
import { namedDependency } from "../provider";
import { tokenToDebugName } from "../token";
import { testModule } from "./test-fixtures";

interface IDb {
  query(): string;
}

class Db implements IDb {
  public query(): string {
    return "rows";
  }
}

class DbInternalPool {
  public readonly size = 4;
}

class UserService {
  public constructor(public readonly db: IDb) {}
}

const DB = createToken<IDb>("EncapsDb");
const DB_POOL = createToken<DbInternalPool>("EncapsDbPool");

describe("DI module encapsulation", () => {
  test("module without exports stays fully open (backward compat)", () => {
    const databaseModule = testModule("DatabaseModule", {
      providers: [
        DI.singleton(DI.classProvider(DB, Db)),
        DI.singleton(DI.classProvider(DB_POOL, DbInternalPool)),
      ],
    });
    const appModule = testModule("AppModule", {
      imports: [databaseModule],
      providers: [DI.singleton(DI.classProvider(UserService, UserService, [DB_POOL] as const))],
    });

    const container = createContainer(appModule);
    expect(container.resolve(UserService).db).toBeInstanceOf(DbInternalPool);
  });

  test("importer can use exported token", () => {
    const databaseModule = testModule("DatabaseModule", {
      providers: [
        DI.singleton(DI.classProvider(DB, Db)),
        DI.singleton(DI.classProvider(DB_POOL, DbInternalPool)),
      ],
      exports: [DB],
    });
    const appModule = testModule("AppModule", {
      imports: [databaseModule],
      providers: [DI.singleton(DI.classProvider(UserService, UserService, [DB] as const))],
    });

    const container = createContainer(appModule);
    expect(container.resolve(UserService).db).toBeInstanceOf(Db);
  });

  test("importer cannot use non-exported token", () => {
    const databaseModule = testModule("DatabaseModule", {
      providers: [
        DI.singleton(DI.classProvider(DB, Db)),
        DI.singleton(DI.classProvider(DB_POOL, DbInternalPool)),
      ],
      exports: [DB],
    });
    const appModule = testModule("AppModule", {
      imports: [databaseModule],
      providers: [DI.singleton(DI.classProvider(UserService, UserService, [DB_POOL] as const))],
    });

    expect(() => createContainer(appModule)).toThrow(ModuleEncapsulationError);
    expect(() => createContainer(appModule)).toThrow(/EncapsDbPool/);
  });

  test("exports: [] makes the module fully private", () => {
    const privateModule = testModule("PrivateModule", {
      providers: [DI.singleton(DI.classProvider(DB, Db))],
      exports: [],
    });
    const appModule = testModule("AppModule", {
      imports: [privateModule],
      providers: [DI.singleton(DI.classProvider(UserService, UserService, [DB] as const))],
    });

    expect(() => createContainer(appModule)).toThrow(ModuleEncapsulationError);
  });

  test("re-export: a closed module can forward an imported token", () => {
    const databaseModule = testModule("DatabaseModule", {
      providers: [DI.singleton(DI.classProvider(DB, Db))],
      exports: [DB],
    });
    const infraModule = testModule("InfraModule", {
      imports: [databaseModule],
      providers: [],
      exports: [DB],
    });
    const appModule = testModule("AppModule", {
      imports: [infraModule],
      providers: [DI.singleton(DI.classProvider(UserService, UserService, [DB] as const))],
    });

    const container = createContainer(appModule);
    expect(container.resolve(UserService).db).toBeInstanceOf(Db);
  });

  test("non-imported module's services are invisible to a closed module", () => {
    const databaseModule = testModule("DatabaseModule", {
      providers: [DI.singleton(DI.classProvider(DB, Db))],
      exports: [DB],
    });
    const ordersModule = testModule("OrdersModule", {
      // No import of DatabaseModule, but it depends on its token.
      providers: [DI.singleton(DI.classProvider(UserService, UserService, [DB] as const))],
      exports: [UserService],
    });
    const appModule = testModule("AppModule", {
      imports: [databaseModule, ordersModule],
      providers: [],
    });

    expect(() => createContainer(appModule)).toThrow(ModuleEncapsulationError);
    expect(() => createContainer(appModule)).toThrow(/OrdersModule/);
  });

  test("exporting an unknown token is reported", () => {
    const databaseModule = testModule("DatabaseModule", {
      providers: [DI.singleton(DI.classProvider(DB, Db))],
      exports: [DB_POOL],
    });
    const appModule = testModule("AppModule", {
      imports: [databaseModule],
      providers: [],
      exports: [],
    });

    expect(() => createContainer(appModule)).toThrow(ModuleEncapsulationError);
    expect(() => createContainer(appModule)).toThrow(/neither provides nor imports/);
  });

  test("named deps (auto deps) violations are caught", () => {
    class HiddenLogger {
      public log(): void {}
    }
    class NeedsHiddenLogger {
      public static readonly inject = [namedDependency("HiddenLogger")] as const;
      public constructor(public readonly logger: HiddenLogger) {}
    }

    const loggingModule = testModule("LoggingModule", {
      providers: [singleton(HiddenLogger)],
      exports: [],
    });
    const appModule = testModule("AppModule", {
      imports: [loggingModule],
      providers: [
        DI.singleton(
          DI.classProvider(NeedsHiddenLogger, NeedsHiddenLogger, [namedDependency("HiddenLogger")] as const),
        ),
      ],
    });

    expect(() => createContainer(appModule)).toThrow(ModuleEncapsulationError);
    expect(() => createContainer(appModule)).toThrow(/HiddenLogger/);
  });

  test("open generic family visibility is enforced", () => {
    interface IRepository<T> {
      readonly entity: string;
      readonly marker?: T;
    }
    const REPO = createOpenGenericTokenFamily<unknown, IRepository<unknown>>("EncapsRepo");
    const USER = createToken<{ id: string }>("EncapsUserEntity");

    class NeedsRepo {
      public constructor(public readonly repo: IRepository<unknown>) {}
    }

    const configureRepo = (di: DiRegistrar) => {
      di.addOpenGeneric(REPO, "singleton", (argument) => ({
        provide: REPO.of(argument),
        useFactory: () => ({ entity: tokenToDebugName(argument) }),
        deps: [],
      }));
    };

    const repoModule = testModule("RepoModule", {
      configure: configureRepo,
      exports: [],
    });
    const appModule = testModule("AppModule", {
      imports: [repoModule],
      providers: [DI.singleton(DI.classProvider(NeedsRepo, NeedsRepo, [REPO.of(USER)] as const))],
    });

    expect(() => createContainer(appModule)).toThrow(ModuleEncapsulationError);

    const openRepoModule = testModule("OpenRepoModule", {
      configure: configureRepo,
      exports: [REPO],
    });
    const okAppModule = testModule("OkAppModule", {
      imports: [openRepoModule],
      providers: [DI.singleton(DI.classProvider(NeedsRepo, NeedsRepo, [REPO.of(USER)] as const))],
    });
    const container = createContainer(okAppModule);
    expect(container.resolve(NeedsRepo).repo.entity).toBe("EncapsUserEntity");
  });

  test("an exact exported closed generic does not expose its sibling", () => {
    const REPO = createOpenGenericTokenFamily<unknown, { value: string }>("ExactExportRepo");
    const PUBLIC = createToken<object>("ExactExportPublic");
    const PRIVATE = createToken<object>("ExactExportPrivate");
    const publicRepo = REPO.of(PUBLIC);
    const privateRepo = REPO.of(PRIVATE);
    const module = testModule("ExactRepoModule", {
      providers: [
        DI.singleton(DI.valueProvider(publicRepo, { value: "public" })),
        DI.singleton(DI.valueProvider(privateRepo, { value: "private" })),
      ],
      exports: [publicRepo],
    });
    class NeedsPublic { public constructor(public readonly repo: { value: string }) {} }
    const allowed = testModule("ExactRepoImporter", {
      imports: [module], providers: [DI.singleton(DI.classProvider(NeedsPublic, NeedsPublic, [publicRepo] as const))],
    });
    expect(createContainer(allowed).resolve(NeedsPublic).repo.value).toBe("public");
    const denied = testModule("ExactRepoDenied", {
      imports: [module], providers: [DI.singleton(DI.classProvider(NeedsPublic, NeedsPublic, [privateRepo] as const))],
    });
    expect(() => createContainer(denied)).toThrow(ModuleEncapsulationError);
  });

  test("root container resolves private services (composition root)", () => {
    const privateModule = testModule("PrivateModule", {
      providers: [DI.singleton(DI.classProvider(DB, Db))],
      exports: [],
    });
    const appModule = testModule("AppModule", {
      imports: [privateModule],
      providers: [],
    });

    const container = createContainer(appModule);
    expect(container.resolve(DB)).toBeInstanceOf(Db);
  });

  test("diamond imports are processed once and stay valid", () => {
    const sharedModule = testModule("SharedModule", {
      providers: [DI.singleton(DI.classProvider(DB, Db))],
      exports: [DB],
    });
    const leftModule = testModule("LeftModule", { imports: [sharedModule], exports: [DB] });
    const rightModule = testModule("RightModule", { imports: [sharedModule], exports: [] });
    const appModule = testModule("AppModule", {
      imports: [leftModule, rightModule],
      providers: [DI.singleton(DI.classProvider(UserService, UserService, [DB] as const))],
    });

    const container = createContainer(appModule);
    expect(container.resolve(UserService).db).toBeInstanceOf(Db);
  });
});
