/** Serializes cache values to/from the string form a distributed store keeps. */
export interface CacheCodec<TValue> {
  serialize(value: TValue): string;
  deserialize(raw: string): TValue;
}
