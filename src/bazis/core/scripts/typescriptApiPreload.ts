// Preloaded into the codegen process (`bun --preload`): see useTypeScriptCompilerApi.
import { useTypeScriptCompilerApi } from "./typescriptApi";

try {
  useTypeScriptCompilerApi(import.meta.dir);
} catch (error) {
  console.error(`[bazis] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
