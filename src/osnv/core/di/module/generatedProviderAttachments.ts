import type { Class } from "../token";

/** Package-internal capability used only as an exact-class generated metadata key. */
export interface GeneratedProviderAttachmentChannel<T> {
  readonly kind: "generatedProviderAttachment";
  readonly description: string;
  normalize(target: Class<object>, value: unknown): T;
  equals?(left: T, right: T): boolean;
}

export interface GeneratedProviderAttachmentV1 {
  readonly channel: GeneratedProviderAttachmentChannel<unknown>;
  readonly target: Class<object>;
  readonly value: unknown;
}

type AnyChannel = GeneratedProviderAttachmentChannel<unknown>;
type Store = Map<AnyChannel, Map<Class<object>, unknown>>;
type PreparedEntry = Readonly<{ channel: AnyChannel; target: Class<object>; value: unknown }>;
export interface PreparedGeneratedProviderAttachments { readonly entries: readonly PreparedEntry[]; }

let attachments: Store = new Map();

export function createGeneratedProviderAttachmentChannel<T>(input: Readonly<{
  description: string;
  normalize(target: Class<object>, value: unknown): T;
  equals?(left: T, right: T): boolean;
}>): GeneratedProviderAttachmentChannel<T> {
  const description = input.description.trim();
  if (description.length === 0 || typeof input.normalize !== "function") {
    throw new TypeError("Generated provider attachment channel is invalid.");
  }
  return Object.freeze({
    kind: "generatedProviderAttachment" as const,
    description,
    normalize: input.normalize,
    equals: input.equals,
  }) as GeneratedProviderAttachmentChannel<T>;
}

/** Exact-class query only; intentionally no channel or attachment enumeration API exists. */
export function getGeneratedProviderAttachment<T>(
  channel: GeneratedProviderAttachmentChannel<T>,
  target: Class<object>,
): T | undefined {
  return attachments.get(channel as AnyChannel)?.get(target) as T | undefined;
}

/** @internal Snapshot participates in generated-target atomic commit/rollback. */
export function snapshotGeneratedProviderAttachments(): Store {
  return new Map([...attachments].map(([channel, entries]) => [channel, new Map(entries)]));
}

/** @internal Restores generated attachment state after failed target publication. */
export function restoreGeneratedProviderAttachments(snapshot: Store): void {
  attachments = new Map([...snapshot].map(([channel, entries]) => [channel, new Map(entries)]));
}

/** @internal Validates and publishes a target's complete exact-class attachment slice. */
/** @internal Validates every attachment before any generated target owner is mutated. */
export function prepareGeneratedProviderAttachments(
  entries: readonly GeneratedProviderAttachmentV1[] | undefined,
): PreparedGeneratedProviderAttachments {
  if (entries === undefined) return Object.freeze({ entries: Object.freeze([]) });
  if (!Array.isArray(entries)) throw new TypeError("Generated provider attachments must be an array.");
  const normalized: readonly PreparedEntry[] = entries.map((entry) => {
    if (entry === null || typeof entry !== "object" || entry.channel?.kind !== "generatedProviderAttachment"
      || typeof entry.target !== "function") {
      throw new TypeError("Generated provider attachment is invalid.");
    }
    const channel = entry.channel as AnyChannel;
    return Object.freeze({ channel, target: entry.target, value: channel.normalize(entry.target, entry.value) });
  });
  const own = new Map<AnyChannel, Set<Class<object>>>();
  for (const entry of normalized) {
    const targets = own.get(entry.channel) ?? new Set<Class<object>>();
    if (targets.has(entry.target)) throw new TypeError(`Generated provider attachment is duplicated for ${entry.channel.description}.`);
    targets.add(entry.target); own.set(entry.channel, targets);
    const current = attachments.get(entry.channel)?.get(entry.target);
    if (current !== undefined && !(entry.channel.equals?.(current, entry.value) ?? Object.is(current, entry.value))) {
      throw new TypeError(`Generated provider attachment diverges for ${entry.channel.description}.`);
    }
  }
  return Object.freeze({ entries: Object.freeze([...normalized]) });
}

/** @internal Commits a previously validated attachment slice inside the target transaction. */
export function commitGeneratedProviderAttachments(prepared: PreparedGeneratedProviderAttachments): void {
  for (const entry of prepared.entries) {
    let targets = attachments.get(entry.channel);
    if (targets === undefined) {
      targets = new Map();
      attachments.set(entry.channel, targets);
    }
    if (!targets.has(entry.target)) targets.set(entry.target, entry.value);
  }
}

/** @internal Convenience only for isolated tests; generated target runtime uses prepare + commit. */
export function registerGeneratedProviderAttachments(entries: readonly GeneratedProviderAttachmentV1[] | undefined): void {
  commitGeneratedProviderAttachments(prepareGeneratedProviderAttachments(entries));
}
