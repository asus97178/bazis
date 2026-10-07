import { parseModuleName, type ModuleNaming } from "../naming";
import { validatePackParts } from "../parseCli";
import { buildModuleTemplates, type ModuleTemplateFiles } from "./module";

/** The folder of a pack part: `prices` → `prices_module`. */
export function packPartFolder(part: ModuleNaming): string {
  return `${part.folder}_module`;
}

export function buildPackTemplates(naming: ModuleNaming, partNames: readonly string[], command?: string): readonly ModuleTemplateFiles[] {
  validatePackParts(partNames);
  const parts = partNames.map((name) => {
    const part = parseModuleName(name);
    // A part names a responsibility (Tables), not a CRUD entity (Table).
    return { ...part, entity: part.module, folder: packPartFolder(part) };
  });
  if (parts.some((part) => part.moduleClass === naming.moduleClass)) {
    throw new Error("A pack and its parts must have distinct module class names.");
  }
  return [
    {
      relativePath: `${naming.module}.module.ts`,
      content: `import { Module } from "bazis/core/di";
${parts.map((part) => `import { ${part.moduleClass} } from "./${part.folder}/${part.module}.module";`).join("\n")}

@Module({
  imports: [${parts.map((part) => part.moduleClass).join(", ")}],
  exports: [],
})
export class ${naming.moduleClass} {}
`,
    },
    {
      relativePath: "MODULE.md",
      content: `# ${naming.moduleClass}

Passport version: 1.0. Type: composite.
Status: composition scaffold generated; the parts are not implemented yet.
Entry: [${naming.module}.module.ts](${naming.module}.module.ts).
${command === undefined ? "" : `Created with: \`${command}\`.\n`}Before changing it, read AGENTS.md and docs/architecture/MODULE_ARCHITECTURE.md.

## Responsibility and parts

The root combines self-contained responsibilities; the author fixes the exact
data boundaries and invariants of each part in its passport before implementing
it. If the responsibilities are not self-contained, use one atomic module.

| Part | Responsibility and data | Public entries | Depends on | Passport |
| --- | --- | --- | --- | --- |
${parts.map((part) => `| ${part.moduleClass} | Not defined yet: ${part.input} | Module class, no arguments | imports: [] | [MODULE.md](${part.folder}/MODULE.md) |`).join("\n")}

## Layout and wiring

Root files: this passport, ${naming.module}.module.ts.
${parts.map((part) => `Directory ${part.folder}: ${part.module}.module.ts and MODULE.md.`).join("\n")}
imports: [${parts.map((part) => part.moduleClass).join(", ")}]. exports: [].
TypeScript entry: ${naming.moduleClass}; no factory or input fields.
Public tokens of the parts are re-exported by the root explicitly when needed.
Domain providers, ORM, HTTP, config, background, UI, AI and events do not
belong to the root; the atomic parts own them. Consumers import the root.
Orchestration across parts also gets its own atomic owner.

## Inputs, outputs, errors and lifecycle

The root only wires classes; it has no public operations or effects of its own.
Arguments, data, required/null/default, validation, results, errors, scopes and
effects of future operations are described in the parts' passports.
Links between parts, shared infrastructure and needed exports are not defined yet.

## Checks

None run for the new pack. After implementation: codegen, the composition,
exports, no cycles or duplicate registrations, the parts' tests.
A generated scaffold does not prove the pack is ready.
`,
    },
    ...parts.flatMap((part) => buildModuleTemplates(part, "empty", undefined, { command, pack: naming.moduleClass }).map((file) => ({
      relativePath: `${part.folder}/${file.relativePath}`, content: file.content,
    }))),
  ];
}
