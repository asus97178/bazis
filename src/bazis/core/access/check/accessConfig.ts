import { defineConfig } from "../../kernel";

/** Settings of access (ACCESS-001), `access.*` in the configuration. */
export interface AccessConfig {
  /** The claim with the account kind: `sub` becomes `<kind>:<subject>`; empty — no kind. */
  kindClaim: string;
  /** The claim with the roles of the default rights system, separated by spaces or commas. */
  roleClaim: string;
  /** Values of one list condition and of a lookup result. */
  maxInList: number;
}

export const accessConfig = defineConfig<AccessConfig>("access", {
  default: { kindClaim: "", roleClaim: "role", maxInList: 1000 },
  validate: {
    maxInList: (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100_000 ? undefined : "must be an integer 1–100000",
  },
});
