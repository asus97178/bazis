import path from "node:path";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { parseModuleName } from "./naming";

export interface GenerateProjectOptions {
  readonly name: string;
  /** Exact destination directory; defaults to ./<kebab-name>. */
  readonly outputPath?: string;
  /** Local Osnv package source; defaults to this checkout's src/osnv. */
  readonly frameworkPath?: string;
  /** Opt into a live link to the source checkout instead of a portable snapshot. */
  readonly linkFramework?: boolean;
  readonly dryRun?: boolean;
}

export interface GenerateProjectResult {
  readonly projectDir: string;
  /** Application scaffold files; framework sources are summarized separately. */
  readonly files: readonly string[];
  readonly dryRun: boolean;
  readonly frameworkMode: "snapshot" | "link";
  readonly frameworkFileCount: number;
}

/** Create a separate application without mutating the framework checkout. */
export async function generateProject(options: GenerateProjectOptions): Promise<GenerateProjectResult> {
  const name = parseModuleName(options.name).folder;
  const requested = path.resolve(options.outputPath ?? name);
  const parent = await realpath(path.dirname(requested)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Parent directory does not exist: ${path.dirname(requested)}. Create it first or choose another --path.`);
    throw error;
  });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory()) throw new Error(`Project parent is not a directory: ${parent}`);
  const projectDir = path.join(parent, path.basename(requested));
  if (await exists(projectDir)) throw new Error(`Project path already exists: ${projectDir}`);

  const frameworkDir = await resolveFramework(options.frameworkPath);
  if (projectDir.startsWith(`${frameworkDir}${path.sep}`)) {
    throw new Error("Project directory must be outside the Osnv package.");
  }
  const dependencyPath = path.relative(projectDir, frameworkDir).replaceAll("\\", "/");
  const frameworkMode = options.linkFramework ? "link" : "snapshot";
  const frameworkFiles = options.linkFramework ? [] : await collectFrameworkFiles(frameworkDir);
  const dependency = options.linkFramework
    ? `file:${dependencyPath.startsWith(".") ? dependencyPath : `./${dependencyPath}`}`
    : "file:./vendor/osnv";
  const files = buildProjectFiles(name, dependency, frameworkMode);
  if (!options.dryRun) {
    const staged = await mkdtemp(path.join(parent, `.${name}.osnv-`));
    try {
      for (const [relative, content] of files) {
        const output = path.join(staged, relative);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, content, { encoding: "utf8", flag: "wx" });
      }
      for (const relative of frameworkFiles) {
        const output = path.join(staged, "vendor/osnv", relative);
        await mkdir(path.dirname(output), { recursive: true });
        await copyFile(path.join(frameworkDir, relative), output);
      }
      if (await exists(projectDir)) throw new Error(`Project path appeared during generation: ${projectDir}`);
      await rename(staged, projectDir);
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw error;
    }
  }
  return { projectDir, files: files.map(([relative]) => path.join(projectDir, relative)), dryRun: options.dryRun === true,
    frameworkMode, frameworkFileCount: frameworkFiles.length };
}

/** Package sources only: do not carry checkout state, dependencies or test fixtures. */
async function collectFrameworkFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const excluded = new Set(["node_modules", "test", "tests", "__tests__"]);
  const visit = async (relative: string): Promise<void> => {
    const file = path.join(directory, relative);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Framework snapshot cannot include a symbolic link: ${relative}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(file)).sort()) {
        // Same contents as the npm package: no tests, fixtures or internal passports.
        if (entry.startsWith(".") || excluded.has(entry) || entry === "MODULE.md" || /\.(test|spec)\.[^.]+$/.test(entry) || entry.endsWith(".bun-build")) continue;
        await visit(path.join(relative, entry));
      }
    } else if (info.isFile()) files.push(relative);
    else throw new Error(`Unsupported framework package entry: ${relative}`);
  };
  for (const entry of ["index.ts", "package.json", "core", "library", "cli"]) await visit(entry);
  // MIT requires the license text to travel with every copy of the package.
  for (const entry of ["LICENSE", "README.md"]) if (await exists(path.join(directory, entry))) await visit(entry);
  return files;
}

async function resolveFramework(requested?: string): Promise<string> {
  const candidates = requested === undefined
    ? [path.resolve("src/osnv"), path.resolve(import.meta.dir, "..")]
    : [path.resolve(requested)];
  for (const candidate of candidates) {
    let directory: string;
    try { directory = await realpath(candidate); } catch { continue; }
    const info = await lstat(path.join(directory, "package.json")).catch(() => undefined);
    if (!info?.isFile()) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      const required = await Promise.all(["index.ts", "cli/main.ts", "core/scripts/di-generate.ts"]
        .map((file) => lstat(path.join(directory, file)).then((entry) => entry.isFile()).catch(() => false)));
      if (manifest.name === "osnv" && required.every(Boolean)) {
        return directory;
      }
    } catch { /* Try the next candidate. */ }
  }
  throw new Error("Local Osnv package not found. Pass --framework <path-to-src/osnv>.");
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function buildProjectFiles(name: string, dependency: string, frameworkMode: "snapshot" | "link"): readonly (readonly [string, string])[] {
  const manifest = {
    name, version: "0.1.0", private: true, type: "module",
    scripts: {
      "codegen": "osnv codegen",
      "dev": "osnv dev",
      "test": "osnv test",
      "build": "osnv build",
      "build:bin": "osnv build --bin",
      "start": `./bin/${name}`,
    },
    dependencies: { osnv: dependency },
    devDependencies: { "@types/bun": "1.4.0", typescript: "^5" },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext"],
      types: ["bun"], strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true,
      skipLibCheck: true, noEmit: true,
    },
    include: ["src/**/*"],
  };
  const codegen = { version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } };
  return [
    ["package.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["tsconfig.json", `${JSON.stringify(tsconfig, null, 2)}\n`],
    ["osnv.config.json", `${JSON.stringify(codegen, null, 2)}\n`],
    [".gitignore", "node_modules/\nbin/\nsrc/generated/\n.env\n"],
    [".env.example", "# Copy to .env (Bun loads it automatically).\nOSNV_ENV=development\nHOST=127.0.0.1\nPORT=3000\n"],
    ["src/app/test/health.test.ts", HEALTH_TEST],
    ["AGENTS.md", "# Working on this osnv project\n\nBefore changing the application, read the [module architecture](docs/architecture/MODULE_ARCHITECTURE.md). Create new modules only with `bunx osnv g module` or `bunx osnv g pack`; fill in the generated `MODULE.md` afterwards. Only codegen updates `src/generated/`.\n"],
    ["docs/architecture/MODULE_ARCHITECTURE.md", "# Application module architecture\n\n`src/index.ts` calls `runApp`; `src/app/modules/App.module.ts` composes feature modules through `imports`. The application root owns no domain logic.\n\nOne self-contained function is an atomic module. It owns its data, services, HTTP and background handlers. A composite module is only for several independent functions; its root does composition. Layers and file counts alone do not create submodules.\n\nCreate new modules only with `bunx osnv g module <Name> --empty|--minimal|--full` or `bunx osnv g pack <Name> --parts <a,b>`. Before implementing, define the responsibility and public entries, then fill in the generated `MODULE.md`: fields, errors, dependencies, exports and checks. Use the public APIs of the `osnv` package and its DI and ORM. Do not edit `src/generated/` by hand; run `bunx osnv codegen`.\n\n`--minimal` creates a sample CRUD with the ORM. To run it the application needs a database provider and a ready schema. For a first function without a database use `--empty`. Check types and the binary build after changes that affect startup.\n"],
    ["src/app/modules/App.module.ts", 'import { Module } from "osnv/core/di";\n\n@Module({ imports: [], exports: [] })\nexport class AppModule {}\n'],
    ["src/index.ts", 'import { runApp } from "osnv/core/app";\nimport { AppModule } from "./app/modules/App.module";\nimport { registerOsnvGeneratedRuntime } from "./generated/osnv/runtime";\n\nawait registerOsnvGeneratedRuntime();\nawait runApp(AppModule, { http: { hostname: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true } });\n'],
    ["README.md", `# ${name}\n\nAn [osnv](https://www.npmjs.com/package/osnv) application. ${frameworkMode === "snapshot"
      ? "The framework package is copied to `vendor/osnv`; keep it in Git and move it with the project. The framework checkout is no longer needed. Framework updates do not reach this copy automatically."
      : "The `osnv` dependency links an external local checkout (`--link-framework`). Moving the project needs the same package and an updated path in `package.json`."}\nRead the [local architecture](docs/architecture/MODULE_ARCHITECTURE.md) before changing modules.\n\nNeeds Bun ≥ 1.4.0. Settings go to \`.env\` (example: \`.env.example\`).\n\n\`\`\`sh\nbun install\nbunx osnv dev\n# GET http://127.0.0.1:3000/health\n# If the port is busy: PORT=3100 bunx osnv dev\n\`\`\`\n\nAdd an atomic module from the project root: \`bunx osnv g module Task --empty\`.\nAfter filling in its passport and implementation, run \`bunx osnv codegen\`.\nTests: \`bunx osnv test\`. Typecheck: \`bunx osnv build\`. Binary: \`bunx osnv build --bin\`, run it with \`bun run start\`.\n\n\`--minimal\` creates a sample CRUD with paging (20 records by default, at most 100 over HTTP); it needs a database provider and a schema to run. The service returns \`PageResult\`; the HTTP controller builds JSON:API. \`DbContext.saveChanges()\` saves every change of its context. In ORM predicates combine conditions with \`.and()\` and \`.or()\`; codegen rejects \`&&\` and \`||\` between predicates.\n`],
  ];
}

const HEALTH_TEST = `import { expect, test } from "bun:test";

// Starts the app from source exactly as \`osnv dev\` does and checks /health.
test("app starts and answers /health", async () => {
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const app = Bun.spawn([process.execPath, "run", "src/index.ts"], { env: { ...process.env, HOST: "127.0.0.1", PORT: port }, stdout: "ignore", stderr: "inherit" });
  try {
    let status = 0;
    for (let attempt = 0; attempt < 100 && status !== 200; attempt++) {
      await Bun.sleep(100);
      status = await fetch(\`http://127.0.0.1:\${port}/health\`).then((response) => response.status, () => 0);
    }
    expect(status).toBe(200);
  } finally {
    app.kill();
    await app.exited;
  }
});
`;
