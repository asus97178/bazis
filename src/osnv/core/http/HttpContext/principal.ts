/**
 * Contract of the "current request subject" in `ctx.state`.
 *
 * This is the only meeting point between the authentication layer (an application
 * `@Authorize` check puts the principal into `ctx.state`) and the kernel parts
 * that need per-user personalization (for example the output cache with
 * `varyByUser`/`varyByClaim`). The key and the shape are declared here, in the
 * kernel, so application code depends on the kernel and not the other way round.
 */

/** The `ctx.state` key under which {@link RequestPrincipal} is stored. */
export const PRINCIPAL_STATE_KEY = "auth:principal";

/**
 * The minimal principal shape the kernel relies on. The concrete implementation
 * (token kind, claim set and so on) belongs to the application layer; these
 * optional fields are enough for the kernel.
 */
export interface RequestPrincipal {
  /** Subject identifier (`sub`); used by the output cache for `varyByUser`. */
  readonly subject?: string;
  /** Optional claim lookup by type; used for `varyByClaim`. */
  findFirst?(claimType: string): string | undefined;
}
