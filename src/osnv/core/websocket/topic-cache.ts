import { normalizeNamespace } from "./decorators";

const SEP = "\0";

export interface TopicCacheOptions {
  readonly maxTopics?: number;
}

export interface TopicCacheStats {
  readonly topics: number;
}

export class TopicCache {
  private readonly cache = new Map<string, string>();
  private readonly maxTopics: number;

  public constructor(options: TopicCacheOptions = {}) {
    this.maxTopics = options.maxTopics !== undefined && Number.isFinite(options.maxTopics) && options.maxTopics > 0
      ? Math.floor(options.maxTopics)
      : 10_000;
  }

  get(namespace: string, room: string): string {
    const ns = normalizeNamespace(namespace);
    const key = `${ns}${SEP}${room}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const topic = key;
    this.ensureCapacity(key);
    this.cache.set(key, topic);
    return topic;
  }

  delete(namespace: string, room: string): void {
    this.cache.delete(`${normalizeNamespace(namespace)}${SEP}${room}`);
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): TopicCacheStats {
    return { topics: this.cache.size };
  }

  private ensureCapacity(nextKey: string): void {
    if (this.cache.size < this.maxTopics || this.cache.has(nextKey)) {
      return;
    }
    const oldest = this.cache.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      this.cache.delete(oldest);
    }
  }
}

export const topicCache = new TopicCache();
