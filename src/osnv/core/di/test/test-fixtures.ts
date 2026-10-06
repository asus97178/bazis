import { DI, createToken, type OsnvModule, type OsnvModuleMetadata } from "../index";

export interface ILogger {
  log(message: string): void;
}

export const LOGGER = createToken<ILogger>("ILogger");

export class TestLogger implements ILogger {
  public readonly messages: string[] = [];

  public log(message: string): void {
    this.messages.push(message);
  }
}

export class AppService {
  public constructor(public readonly logger: ILogger) {}
}

export class KeyedAppService {
  public constructor(public readonly logger: ILogger) {}
}

export class BoundDepsAppService {
  public static inject = DI.injectFor(BoundDepsAppService, LOGGER);

  public constructor(public readonly logger: ILogger) {}
}

export class MissingDepsAppService {
  public constructor(public readonly logger: ILogger) {}
}

export class SugarAppService {
  public static inject = DI.injectFor(SugarAppService, LOGGER);

  public constructor(public readonly logger: ILogger) {}
}

export class CounterService {
  public static created = 0;
  public readonly id: number;

  public constructor() {
    CounterService.created += 1;
    this.id = CounterService.created;
  }
}

export class DisposableService {
  public disposed = false;

  public dispose(): void {
    this.disposed = true;
  }
}

export class ScopedDisposableService {
  public disposed = false;

  public dispose(): void {
    this.disposed = true;
  }
}

export class AsyncDisposableService {
  public disposed = false;

  public async disposeAsync(): Promise<void> {
    this.disposed = true;
  }
}

export class PromiseDisposeService {
  public disposed = false;

  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export function tokenToName(token: unknown): string {
  if (typeof token === "function") {
    return token.name;
  }
  if (token && typeof token === "object" && "description" in token) {
    return String((token as { description: unknown }).description);
  }
  return "unknown";
}

/** Module with a class name for diagnostics (encapsulation and the like). */
export function testModule(className: string, metadata: OsnvModuleMetadata): OsnvModule {
  const moduleClass = { [className]: class {} }[className] as abstract new (...args: never) => unknown;
  Object.assign(moduleClass, metadata);
  return moduleClass as OsnvModule;
}
