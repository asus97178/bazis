import { parseModuleName } from "./naming";

export type GenerateProfile = "empty" | "minimal" | "full";

export interface ParsedGenerateArgs {
  readonly generator: "module" | "pack";
  readonly name: string;
  readonly parts: readonly string[];
  readonly modulesRoot?: string;
  readonly appModule?: string;
  /** Composite module to add the new module to as a part (module generator only). */
  readonly pack?: string;
  readonly register: boolean;
  readonly force: boolean;
  readonly profile: GenerateProfile;
  readonly dryRun: boolean;
  readonly codegen: boolean;
  readonly target?: string;
}

export interface ParsedProcessArgs {
  readonly name: string;
  /** The module that owns the process. */
  readonly module: string;
  readonly pack?: string;
  readonly modulesRoot?: string;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export type ParseCliResult =
  | { readonly kind: "help"; readonly help: boolean }
  | { readonly kind: "version" }
  | { readonly kind: "new"; readonly name: string; readonly outputPath?: string; readonly frameworkPath?: string; readonly linkFramework: boolean; readonly vendor: boolean; readonly dryRun: boolean }
  | { readonly kind: "generate"; readonly args: ParsedGenerateArgs }
  | { readonly kind: "process"; readonly args: ParsedProcessArgs }
  | { readonly kind: "workflow"; readonly action: "check"; readonly appModule?: string }
  | { readonly kind: "workflow"; readonly action: "diagram"; readonly key: string; readonly appModule?: string }
  | { readonly kind: "codegen"; readonly target?: string }
  | { readonly kind: "dev"; readonly watch: boolean }
  | { readonly kind: "test"; readonly args: readonly string[] }
  | { readonly kind: "build"; readonly bin: boolean; readonly outfile?: string; readonly dotenv: boolean; readonly platform?: string }
  | { readonly kind: "error"; readonly message: string };

const GENERATOR_ALIASES = new Map<string, "module" | "pack">([
  ["module", "module"], ["m", "module"],
  ["pack", "pack"], ["p", "pack"], ["module-pack", "pack"],
]);
const VALUE_OPTIONS = new Set(["--modules-root", "--app-module", "--pack", "--module", "--parts", "--target", "--path", "--framework", "--outfile", "--platform"]);
/** Platforms of `bun build --compile --target=bun-<platform>`. */
export const BINARY_PLATFORM = /^(linux|darwin|windows)-(x64|arm64)(-musl)?(-baseline|-modern)?$/;
const FLAG_OPTIONS = new Set(["--no-register", "--force", "--full", "--enterprise", "--minimal", "--empty", "--dry-run", "--no-codegen", "--link-framework", "--vendor", "--bin", "--watch", "--dotenv"]);

/** Parsing is pure: help and invalid input can never start generation. */
export function parseCliArgs(argv: readonly string[]): ParseCliResult {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) return { kind: "help", help: true };
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) return { kind: "version" };
  if (argv.length === 0) return { kind: "help", help: false };
  // Everything after `test` (or `test --`) belongs to `bun test`.
  if (argv[0] === "test") return { kind: "test", args: argv[1] === "--" ? argv.slice(2) : argv.slice(1) };

  const positional: string[] = [];
  const options = new Map<string, string>();
  const error = (message: string): ParseCliResult => ({ kind: "error", message });
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (VALUE_OPTIONS.has(arg)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-") || value.trim() === "") {
        return error(`Option ${arg} requires a value.`);
      }
      if (options.has(arg)) return error(`Option ${arg} may only be specified once.`);
      options.set(arg, value);
    } else if (FLAG_OPTIONS.has(arg)) {
      options.set(arg, "true");
    } else if (arg.startsWith("-")) {
      return error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [command, generatorToken, name] = positional;
  const target = options.get("--target");
  if (command === "new") {
    if (positional.length !== 2) return error("Use: bazis new <Name> [--path <directory>] [--framework <directory>] [--vendor | --link-framework] [--dry-run]");
    for (const option of options.keys()) {
      if (option !== "--path" && option !== "--framework" && option !== "--link-framework" && option !== "--vendor" && option !== "--dry-run") {
        return error(`Option ${option} is not supported by new.`);
      }
    }
    if (options.has("--vendor") && options.has("--link-framework")) return error("--vendor and --link-framework cannot be combined.");
    try {
      parseModuleName(generatorToken!);
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
    return { kind: "new", name: generatorToken!, outputPath: options.get("--path"), frameworkPath: options.get("--framework"), linkFramework: options.has("--link-framework"), vendor: options.has("--vendor"), dryRun: options.has("--dry-run") };
  }
  if (target !== undefined && !/^[a-z][a-z0-9-]*$/.test(target)) {
    return error("Target must be a codegen target name or all.");
  }
  if (command === "dev") {
    if (positional.length !== 1 || [...options.keys()].some((option) => option !== "--watch")) return error("Use: bazis dev [--watch]");
    return { kind: "dev", watch: options.has("--watch") };
  }
  if (options.has("--watch")) return error("--watch is only supported by dev.");
  if (command === "build") {
    if (positional.length !== 1) return error("Use: bazis build [--bin [--outfile <path>] [--platform <os-arch>] [--dotenv]]");
    for (const option of options.keys()) {
      if (option !== "--bin" && option !== "--outfile" && option !== "--dotenv" && option !== "--platform") return error(`Option ${option} is not supported by build.`);
    }
    if (options.has("--outfile") && !options.has("--bin")) return error("--outfile requires --bin.");
    if (options.has("--dotenv") && !options.has("--bin")) return error("--dotenv requires --bin.");
    if (options.has("--platform") && !options.has("--bin")) return error("--platform requires --bin.");
    const platform = options.get("--platform");
    if (platform !== undefined && !BINARY_PLATFORM.test(platform)) {
      return error(`Unknown platform: ${platform}. Use <os>-<arch>[-musl]: linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, darwin-arm64, darwin-x64, windows-x64.`);
    }
    return { kind: "build", bin: options.has("--bin"), outfile: options.get("--outfile"), dotenv: options.has("--dotenv"), ...(platform === undefined ? {} : { platform }) };
  }
  if (options.has("--bin") || options.has("--outfile") || options.has("--dotenv") || options.has("--platform")) return error("--bin, --outfile, --platform and --dotenv are only supported by build.");
  if (command === "codegen") {
    if (positional.length !== 1) return error("Use: bazis codegen [--target <name|all>]");
    for (const option of options.keys()) {
      if (option !== "--target") return error(`Option ${option} is not supported by codegen.`);
    }
    return { kind: "codegen", target };
  }
  if (command === "workflow") {
    for (const option of options.keys()) {
      if (option !== "--app-module") return error(`Option ${option} is not supported by workflow.`);
    }
    const appModule = options.get("--app-module");
    if (generatorToken === "check" && positional.length === 2) return { kind: "workflow", action: "check", ...(appModule === undefined ? {} : { appModule }) };
    if (generatorToken === "diagram" && positional.length === 3) return { kind: "workflow", action: "diagram", key: name!, ...(appModule === undefined ? {} : { appModule }) };
    return error("Use: bazis workflow check [--app-module <path>] or bazis workflow diagram <key> [--app-module <path>]");
  }
  if (options.has("--module") && !((command === "g" || command === "generate") && (generatorToken === "process" || generatorToken === "pr"))) return error("--module is only supported by g process.");
  if ((command === "g" || command === "generate") && (generatorToken === "process" || generatorToken === "pr")) {
    for (const option of options.keys()) {
      if (!["--module", "--pack", "--modules-root", "--force", "--dry-run"].includes(option)) return error(`Option ${option} is not supported by g process.`);
    }
    if (name === undefined || positional.length !== 3) return error("Use: bazis g process <Name> --module <Name> [--pack <Name>]");
    const module = options.get("--module");
    if (module === undefined) return error("g process needs the module that owns the process: --module <Name>.");
    try {
      parseModuleName(name);
      parseModuleName(module);
      if (options.has("--pack")) parseModuleName(options.get("--pack")!);
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
    return {
      kind: "process",
      args: { name, module, pack: options.get("--pack"), modulesRoot: options.get("--modules-root"), force: options.has("--force"), dryRun: options.has("--dry-run") },
    };
  }
  if (command !== "g" && command !== "generate") {
    return error(`Unknown command: ${command ?? "(missing)"}. Use: bazis --help`);
  }
  if (generatorToken === undefined) return error("Generator is required: module (m), pack (p) or process (pr).");
  if (options.has("--path") || options.has("--framework") || options.has("--link-framework") || options.has("--vendor")) return error("--path, --framework, --link-framework and --vendor are only supported by new.");
  const generator = GENERATOR_ALIASES.get(generatorToken);
  if (generator === undefined) return error(`Unknown generator: ${generatorToken}. Supported: module (m), pack (p), process (pr)`);
  if (name === undefined) return error("Module name is required.");
  if (positional.length !== 3) return error(`Unexpected argument: ${positional[3]}`);

  const profiles: GenerateProfile[] = [];
  if (options.has("--minimal")) profiles.push("minimal");
  if (options.has("--full") || options.has("--enterprise")) profiles.push("full");
  if (options.has("--empty")) profiles.push("empty");
  if (profiles.length > 1) return error("Choose only one profile: --empty, --minimal or --full.");
  if (generator === "pack" && profiles.length > 0) return error("Pack parts start empty; module profile flags are not supported by pack.");
  if (generator === "module" && options.has("--parts")) return error("--parts is only supported by pack.");
  if (generator === "pack" && options.has("--pack")) return error("--pack adds a part with g module; a pack is created with --parts.");
  if (options.has("--pack") && options.has("--app-module")) return error("--pack connects the part in the pack root; do not combine it with --app-module.");
  if (options.has("--no-codegen") && target !== undefined) return error("--target cannot be used with --no-codegen.");
  if (options.has("--no-register") && target !== undefined) return error("Use bazis codegen --target separately after connecting the module.");

  const parts = options.get("--parts")?.split(",").map((part) => part.trim()) ?? [];
  try {
    parseModuleName(name);
    if (options.has("--pack")) parseModuleName(options.get("--pack")!);
    if (generator === "pack") validatePackParts(parts);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
  return {
    kind: "generate",
    args: {
      generator, name, parts,
      modulesRoot: options.get("--modules-root"), appModule: options.get("--app-module"), pack: options.get("--pack"),
      register: !options.has("--no-register"), force: options.has("--force"),
      profile: profiles[0] ?? "minimal", dryRun: options.has("--dry-run"),
      codegen: !options.has("--no-codegen"), target,
    },
  };
}

export function validatePackParts(parts: readonly string[]): void {
  if (parts.length < 2) throw new Error("A pack needs at least two independent parts. Use --parts tables,records.");
  const names = parts.map(parseModuleName);
  // `records` and `record` are distinct modules but name one entity: reject the confusion.
  if (new Set(names.map((name) => name.folder)).size !== names.length
    || new Set(names.map((name) => name.entity)).size !== names.length) {
    throw new Error("Pack parts must have distinct names (also in singular form).");
  }
}
