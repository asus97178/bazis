import type { HttpContext } from "../HttpContext/HttpContext";
import type { HttpMiddleware } from "./types";

/**
 * Runs a precompiled middleware chain. The chain array is built once per
 * route at startup; per request we only allocate the dispatch closure.
 */
export function runPipeline(chain: readonly HttpMiddleware[], ctx: HttpContext): Promise<void> {
  let lastIndex = -1;
  const dispatch = async (index: number): Promise<void> => {
    if (index <= lastIndex) {
      throw new Error("next() called multiple times in the same middleware");
    }
    lastIndex = index;
    const middleware = chain[index];
    if (middleware) {
      await middleware(ctx, () => dispatch(index + 1));
    }
  };
  return dispatch(0);
}
