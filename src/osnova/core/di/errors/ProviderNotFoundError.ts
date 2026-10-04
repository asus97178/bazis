import { tokenToDebugName } from "../token";
import type { Token } from "../token";
import { DiError } from "./DiError";

export class ProviderNotFoundError extends DiError {
  public constructor(token: Token<unknown>, path?: readonly string[]) {
    const pathSuffix = path && path.length > 0 ? ` Resolution path: ${path.join(" -> ")}.` : "";
    super(`Provider for token "${tokenToDebugName(token)}" was not found.${pathSuffix}`);
  }
}
