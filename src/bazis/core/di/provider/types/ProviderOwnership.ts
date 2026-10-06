/** Who is responsible for disposing an instance created by a provider. */
export type ProviderOwnership = "container" | "external";

export interface ProviderOwnershipOptions {
  /** Defaults to `container`; use `external` when a lifecycle adapter owns cleanup. */
  readonly ownership?: ProviderOwnership;
}
