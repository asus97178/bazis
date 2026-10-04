import { parseModuleName } from "./naming";

export type GenerateProfile = "empty" | "minimal" | "full";

export interface ParsedGenerateArgs {
  readonly generator: "module" | "pack";
  readonly name: string;
  readonly parts: readonly string[];
  readonly modulesRoot?: string;
  readonly appModule?: string;
  readonly register: boolean;
  readonly force: boolean;
  readonly profile: GenerateProfile;
  readonly dryRun: boolean;
  readonly codegen: boolean;
  readonly target?: string;
}

export type ParseCliResult =
  | { readonly kind: "help"; readonly help: boolean }
  | { readonly kind: "new"; readonly name: string; readonly outputPath?: string; readonly frameworkPath?: string; readonly linkFramework: boolean; readonly dryRun: boolean }
  | { readonly kind: "generate"; readonly args: ParsedGenerateArgs }
  | { readonly kind: "codegen"; readonly target?: string }
  | { readonly kind: "error"; readonly message: string };

const GENERATOR_ALIASES = new Map<string, "module" | "pack">([
  ["module", "module"], ["m", "module"],
  ["pack", "pack"], ["p", "pack"], ["module-pack", "pack"],
]);
const VALUE_OPTIONS = new Set(["--modules-root", "--app-module", "--parts", "--target", "--path", "--framework"]);
const FLAG_OPTIONS = new Set(["--no-register", "--force", "--full", "--enterprise", "--minimal", "--empty", "--dry-run", "--no-codegen", "--link-framework"]);

/** Parsing is pure: help and invalid input can never start generation. */
export function parseCliArgs(argv: readonly string[]): ParseCliResult {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) return { kind: "help", help: true };
  if (argv.length === 0) return { kind: "help", help: false };

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
    if (positional.length !== 2) return error("Use: osnova new <Name> [--path <directory>] [--framework <directory>] [--link-framework] [--dry-run]");
    for (const option of options.keys()) {
      if (option !== "--path" && option !== "--framework" && option !== "--link-framework" && option !== "--dry-run") {
        return error(`Option ${option} is not supported by new.`);
      }
    }
    try {
      parseModuleName(generatorToken!);
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
    return { kind: "new", name: generatorToken!, outputPath: options.get("--path"), frameworkPath: options.get("--framework"), linkFramework: options.has("--link-framework"), dryRun: options.has("--dry-run") };
  }
  if (target !== undefined && !/^[a-z][a-z0-9-]*$/.test(target)) {
    return error("Target must be a codegen target name or all.");
  }
  if (command === "codegen") {
    if (positional.length !== 1) return error("Use: osnova codegen [--target <name|all>]");
    for (const option of options.keys()) {
      if (option !== "--target") return error(`Option ${option} is not supported by codegen.`);
    }
    return { kind: "codegen", target };
  }
  if (command !== "g" && command !== "generate") {
    return error(`Unknown command: ${command ?? "(missing)"}. Use: osnova --help`);
  }
  if (generatorToken === undefined) return error("Generator is required: module (m) or pack (p).");
  if (options.has("--path") || options.has("--framework") || options.has("--link-framework")) return error("--path, --framework and --link-framework are only supported by new.");
  const generator = GENERATOR_ALIASES.get(generatorToken);
  if (generator === undefined) return error(`Unknown generator: ${generatorToken}. Supported: module (m), pack (p)`);
  if (name === undefined) return error("Module name is required.");
  if (positional.length !== 3) return error(`Unexpected argument: ${positional[3]}`);

  const profiles: GenerateProfile[] = [];
  if (options.has("--minimal")) profiles.push("minimal");
  if (options.has("--full") || options.has("--enterprise")) profiles.push("full");
  if (options.has("--empty")) profiles.push("empty");
  if (profiles.length > 1) return error("Choose only one profile: --empty, --minimal or --full.");
  if (generator === "pack" && profiles.length > 0) return error("Pack parts start empty; module profile flags are not supported by pack.");
  if (generator === "module" && options.has("--parts")) return error("--parts is only supported by pack.");
  if (options.has("--no-codegen") && target !== undefined) return error("--target cannot be used with --no-codegen.");
  if (options.has("--no-register") && target !== undefined) return error("Use osnova codegen --target separately after connecting the module.");

  const parts = options.get("--parts")?.split(",").map((part) => part.trim()) ?? [];
  try {
    parseModuleName(name);
    if (generator === "pack") validatePackParts(parts);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
  return {
    kind: "generate",
    args: {
      generator, name, parts,
      modulesRoot: options.get("--modules-root"), appModule: options.get("--app-module"),
      register: !options.has("--no-register"), force: options.has("--force"),
      profile: profiles[0] ?? "minimal", dryRun: options.has("--dry-run"),
      codegen: !options.has("--no-codegen"), target,
    },
  };
}

export function validatePackParts(parts: readonly string[]): void {
  if (parts.length < 2) throw new Error("A pack needs at least two independent parts. Use --parts tables,records.");
  const names = parts.map(parseModuleName);
  if (new Set(names.map((name) => name.folder)).size !== names.length
    || new Set(names.map((name) => name.moduleClass)).size !== names.length) {
    throw new Error("Pack parts must have distinct folder and module class names.");
  }
}
