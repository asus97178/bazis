import { HttpClient } from "./HttpClient";
import { HttpClientConfigError } from "./errors";
import type { RequestConfig } from "./types";

/** Resolves pre-configured named clients (à la .NET `IHttpClientFactory`). */
export interface HttpClientFactory {
  createClient(name?: string): HttpClient;
}

/**
 * Fluent builder for {@link HttpClientFactory}. Unknown names fail fast with
 * {@link HttpClientConfigError} rather than silently returning a blank client.
 */
export class HttpClientFactoryBuilder {
  private readonly named = new Map<string, RequestConfig>();
  private defaults: RequestConfig = {};

  /** Config for `createClient()` (no name). */
  public useDefault(config: RequestConfig): this {
    this.defaults = config;
    return this;
  }

  public addClient(name: string, config: RequestConfig): this {
    this.named.set(name, config);
    return this;
  }

  public build(): HttpClientFactory {
    const named = new Map(this.named);
    const defaults = this.defaults;
    return {
      createClient(name?: string): HttpClient {
        if (name === undefined) {
          return new HttpClient(defaults);
        }
        const config = named.get(name);
        if (config === undefined) {
          throw new HttpClientConfigError(name, [...named.keys()]);
        }
        return new HttpClient(defaults).create(config);
      },
    };
  }
}
