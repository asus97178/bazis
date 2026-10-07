import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// TypeScript 7 ships no compiler API ("typescript" exports only the version).
// Codegen then loads the TypeScript 6 API from @typescript/typescript6.
const repository = process.cwd();
const api = path.join(repository, "src/bazis/core/scripts/typescriptApi.ts");
const realTypeScript = path.dirname(Bun.resolveSync("typescript/package.json", repository));
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function project(typescriptMajor: 6 | 7, bridge: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-ts-api-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules/@typescript"), { recursive: true });
  if (typescriptMajor === 7) {
    const fake = path.join(root, "node_modules/typescript");
    await mkdir(path.join(fake, "lib"), { recursive: true });
    await writeFile(path.join(fake, "package.json"), JSON.stringify({ name: "typescript", version: "7.0.2", exports: { ".": "./lib/version.cjs" } }));
    await writeFile(path.join(fake, "lib/version.cjs"), 'module.exports = { version: "7.0.2" };\n');
  } else {
    await symlink(realTypeScript, path.join(root, "node_modules/typescript"));
  }
  if (bridge) await symlink(realTypeScript, path.join(root, "node_modules/@typescript/typescript6"));
  await writeFile(path.join(root, "probe.ts"), `import { useTypeScriptCompilerApi } from ${JSON.stringify(api)};
try {
  useTypeScriptCompilerApi(import.meta.dir);
} catch (error) {
  console.log((error as Error).message);
  process.exit(0);
}
const ts = (await import("typescript")).default;
console.log(typeof ts.createProgram + " " + ts.version);
`);
  return root;
}

async function probe(root: string): Promise<string> {
  const child = Bun.spawn([process.execPath, "probe.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return (out + err).trim();
}

test("TypeScript 7 with @typescript/typescript6: the typescript import gives the TypeScript 6 compiler API", async () => {
  expect(await probe(await project(7, true))).toMatch(/^function 6\./);
});

test("TypeScript 7 without the bridge: a clear error with the install command", async () => {
  expect(await probe(await project(7, false))).toBe(
    "BAZIS_TYPESCRIPT_API_MISSING: TypeScript 7 has no compiler API, and bazis codegen needs one. Install the TypeScript 6 API next to it: bun add -d @typescript/typescript6",
  );
});

test("TypeScript 6 is used as is", async () => {
  expect(await probe(await project(6, false))).toMatch(/^function 6\./);
});
