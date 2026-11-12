import { defineConfig } from "../../kernel";

/** Settings of access (ACCESS-001), `access.*` in the configuration. */
export interface AccessConfig {
  /** The claim with the account kind: `sub` becomes `<kind>:<subject>`; empty — no kind. */
  kindClaim: string;
  /** The claim with the roles of the default rights system, separated by spaces or commas. */
  roleClaim: string;
  /** Values of one list condition and of a lookup result. */
  maxInList: number;
  /**
   * Seconds between two questions to the permission sources about their
   * version (ACCESS-001 §3.1): how long another instance may keep a removed
   * permission. `0` — never ask: one instance, or the application calls
   * `IAccessCatalog.changed` on every instance itself.
   */
  sourcePollSeconds: number;
  /** Seconds a permission source has for one answer; after them the reading has failed. */
  sourceTimeoutSeconds: number;
}

export const accessConfig = defineConfig<AccessConfig>("access", {
  default: { kindClaim: "", roleClaim: "role", maxInList: 1000, sourcePollSeconds: 5, sourceTimeoutSeconds: 10 },
  validate: {
    maxInList: (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100_000 ? undefined : "must be an integer 1–100000",
    sourcePollSeconds: (value) => Number.isFinite(value) && value >= 0 && value <= 3600 ? undefined : "must be a number 0–3600",
    sourceTimeoutSeconds: (value) => Number.isFinite(value) && value > 0 && value <= 600 ? undefined : "must be a number above 0, up to 600",
  },
});
