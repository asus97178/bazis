import { defineConfig } from "../../kernel";

/**
 * Settings of access (ACCESS-001): the claims the default rights system reads,
 * and the limit of values in one list condition.
 */
export const accessConfig = defineConfig("access", {
  default: {
    /** The claim with the account kind: `sub` becomes `<kind>:<subject>`; empty — no kind. */
    kindClaim: "",
    /** The claim with the roles of the default rights system, separated by spaces or commas. */
    roleClaim: "role",
    maxInList: 1000,
  },
  validate: {
    maxInList: (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100_000 ? undefined : "must be an integer 1–100000",
  },
});
