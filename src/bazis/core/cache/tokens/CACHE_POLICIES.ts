import { createToken } from "../../di";
import type { CachePolicyRegistry } from "../types/CachePolicy";

/** Named cache policies from cache module configuration, e.g. `memory({ policies })`. */
export const CACHE_POLICIES = createToken<CachePolicyRegistry>("CachePolicies");
