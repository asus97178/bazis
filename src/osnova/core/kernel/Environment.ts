import { KernelError } from "./errors";
import type { EnvironmentName } from "./types";

/**
 * Explicit application environment (Symfony Kernel style). Registered in the
 * container as a value, so any service can depend on it.
 */
export class Environment {
  public constructor(
    public readonly name: EnvironmentName,
    /** Debug mode: extra diagnostics. Default: everywhere except production. */
    public readonly debug: boolean = name !== "production",
  ) {}

  public get isDevelopment(): boolean {
    return this.name === "development";
  }

  public get isProduction(): boolean {
    return this.name === "production";
  }

  public get isTest(): boolean {
    return this.name === "test";
  }

  /** Reads OSNV_ENV (fallback NODE_ENV, then production). Unknown value fails fast. */
  public static fromProcess(debugOverride?: boolean): Environment {
    // A missing deployment setting must fail closed. Development is always an
    // explicit choice made by the dev scripts, never an accidental production
    // fallback.
    const raw = process.env.OSNV_ENV ?? process.env.NODE_ENV ?? "production";
    const name = parseEnvironmentName(raw);
    return new Environment(name, debugOverride ?? name !== "production");
  }
}

function parseEnvironmentName(raw: string): EnvironmentName {
  switch (raw.toLowerCase()) {
    case "development":
    case "dev":
      return "development";
    case "production":
    case "prod":
      return "production";
    case "test":
      return "test";
    default:
      throw new KernelError(
        `Unknown environment "${raw}" (OSNV_ENV/NODE_ENV). Expected: development | production | test.`,
      );
  }
}
