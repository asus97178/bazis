import { HttpClient } from "./HttpClient";
import { HttpClientConfigError } from "./errors";
import type { RequestConfig } from "./types";

/**
 * Resolves pre-configured named clients (à la .NET `IHttpClientFactory`).
 * An abstract class, so a service can take it by type in its constructor.
 */
export abstract class HttpClientFactory {
  public abstract createClient(name?: string): HttpClient;
}

class ConfiguredHttpClientFactory extends HttpClientFactory {
  public constructor(
    private readonly defaults: RequestConfig,
    private readonly named: ReadonlyMap<string, RequestConfig>,
  ) {
    super();
  }

  public createClient(name?: string): HttpClient {
    if (name === undefined) {
      return new HttpClient(this.defaults);
    }
    const config = this.named.get(name);
    if (config === undefined) {
      throw new HttpClientConfigError(name, [...this.named.keys()]);
    }
    return new HttpClient(this.defaults).create(config);
  }
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
    return new ConfiguredHttpClientFactory(this.defaults, new Map(this.named));
  }
}
