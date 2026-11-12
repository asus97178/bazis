/**
 * The Claude adapter lives in its own entry: it imports `@anthropic-ai/sdk`,
 * which only an application that uses Claude installs.
 */
export {
  AnthropicModelProvider,
  AnthropicProviderError,
  anthropicAdapter,
  type AnthropicAdapterOptions,
  type AnthropicClient,
} from "./connectors/anthropic";
