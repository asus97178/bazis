import path from "node:path";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { parseModuleName } from "./naming";

export interface GenerateProjectOptions {
  readonly name: string;
  /** Exact destination directory; defaults to ./<kebab-name>. */
  readonly outputPath?: string;
  /** Local Osnova package source; defaults to this checkout's src/osnova. */
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
  const parent = await realpath(path.dirname(requested));
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory()) throw new Error(`Project parent is not a directory: ${parent}`);
  const projectDir = path.join(parent, path.basename(requested));
  if (await exists(projectDir)) throw new Error(`Project path already exists: ${projectDir}`);

  const frameworkDir = await resolveFramework(options.frameworkPath);
  if (projectDir.startsWith(`${frameworkDir}${path.sep}`)) {
    throw new Error("Project directory must be outside the Osnova package.");
  }
  const dependencyPath = path.relative(projectDir, frameworkDir).replaceAll("\\", "/");
  const frameworkMode = options.linkFramework ? "link" : "snapshot";
  const frameworkFiles = options.linkFramework ? [] : await collectFrameworkFiles(frameworkDir);
  const dependency = options.linkFramework
    ? `file:${dependencyPath.startsWith(".") ? dependencyPath : `./${dependencyPath}`}`
    : "file:./vendor/osnova";
  const files = buildProjectFiles(name, dependency, frameworkMode);
  if (!options.dryRun) {
    const staged = await mkdtemp(path.join(parent, `.${name}.osnova-`));
    try {
      for (const [relative, content] of files) {
        const output = path.join(staged, relative);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, content, { encoding: "utf8", flag: "wx" });
      }
      for (const relative of frameworkFiles) {
        const output = path.join(staged, "vendor/osnova", relative);
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
        if (entry.startsWith(".") || excluded.has(entry) || /\.(test|spec)\.[^.]+$/.test(entry) || entry.endsWith(".bun-build")) continue;
        await visit(path.join(relative, entry));
      }
    } else if (info.isFile()) files.push(relative);
    else throw new Error(`Unsupported framework package entry: ${relative}`);
  };
  for (const entry of ["index.ts", "package.json", "core", "library", "cli"]) await visit(entry);
  if (await exists(path.join(directory, "LICENSES"))) await visit("LICENSES");
  return files;
}

async function resolveFramework(requested?: string): Promise<string> {
  const candidates = requested === undefined
    ? [path.resolve("src/osnova"), path.resolve(import.meta.dir, "..")]
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
      if (manifest.name === "osnova" && required.every(Boolean)) {
        return directory;
      }
    } catch { /* Try the next candidate. */ }
  }
  throw new Error("Local Osnova package not found. Pass --framework <path-to-src/osnova>.");
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
      "osnova": "bun run node_modules/osnova/cli/main.ts",
      "di:generate": "bun run node_modules/osnova/core/scripts/di-generate.ts",
      "predev": "bun run di:generate",
      "dev": "bun run src/index.ts",
      "prebuild": "bun run di:generate",
      "build": "bun x tsc --noEmit",
      "build:bin": `bun run di:generate && bun build --compile src/index.ts --outfile bin/${name}`,
    },
    dependencies: { osnova: dependency },
    devDependencies: { "@types/bun": "1.4.0", typescript: "^5" },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext"],
      types: ["bun"], strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true,
      skipLibCheck: true, noEmit: true,
      paths: { "@/*": ["./node_modules/osnova/*"], "@osnova": ["./node_modules/osnova/index.ts"], "@osnova/*": ["./node_modules/osnova/*"] },
    },
    include: ["src/**/*"],
  };
  const codegen = { version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } };
  return [
    ["package.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["tsconfig.json", `${JSON.stringify(tsconfig, null, 2)}\n`],
    ["osnova.codegen.json", `${JSON.stringify(codegen, null, 2)}\n`],
    [".gitignore", "node_modules/\nbin/\nsrc/generated/\n.env\n"],
    ["AGENTS.md", "# Работа с проектом Osnova\n\nПеред изменением приложения прочитайте [архитектуру модулей](docs/architecture/MODULE_ARCHITECTURE.md). Новые модули создавайте только командой `bun run osnova g module` или `bun run osnova g pack`; после генерации заполните `MODULE.md`. Файлы `src/generated/` обновляет только codegen.\n"],
    ["docs/architecture/MODULE_ARCHITECTURE.md", "# Архитектура модулей приложения\n\n`src/index.ts` запускает `runApp`; `src/app/modules/App.module.ts` собирает функциональные модули через `imports`. Корень приложения не владеет предметной логикой.\n\nОдна самостоятельная функция — атомарный модуль. Он владеет своими данными, сервисами, HTTP и фоновыми обработчиками. Составной модуль нужен только для нескольких независимых функций; его корень выполняет композицию. Слои и число файлов сами по себе не создают подмодули.\n\nСоздавайте новые модули только через `bun run osnova g module <Name> --empty|--minimal|--full` или `bun run osnova g pack <Name> --parts <a,b>`. Перед реализацией определите ответственность и публичные входы, затем заполните сгенерированный `MODULE.md`: поля, ошибки, зависимости, exports и проверки. Пользуйтесь публичными API пакета `osnova`, существующими DI и ORM. Не редактируйте `src/generated/` вручную; запускайте `bun run di:generate`.\n\n`--minimal` создаёт учебный CRUD с ORM. Для его запуска приложению нужны provider БД и готовая схема. Для первой функции без БД используйте `--empty`. Проверяйте типы и бинарную сборку после изменений, влияющих на запуск.\n"],
    ["src/app/modules/App.module.ts", 'import { Module } from "osnova/core/di";\n\n@Module({ imports: [], exports: [] })\nexport class AppModule {}\n'],
    ["src/index.ts", 'import { runApp } from "osnova/core/app";\nimport { AppModule } from "./app/modules/App.module";\nimport { registerOsnovaGeneratedRuntime } from "./generated/osnova/runtime";\n\nawait registerOsnovaGeneratedRuntime();\nawait runApp(AppModule, { http: { hostname: "127.0.0.1", port: Number(process.env.PORT ?? 3000), health: true } });\n'],
    ["README.md", `# ${name}\n\nПриложение Osnova. ${frameworkMode === "snapshot"
      ? "Исходный пакет сохранён в `vendor/osnova`; включайте его в Git и переносите вместе с проектом. Исходный checkout фреймворка больше не нужен. Обновления фреймворка в эту копию автоматически не попадают."
      : "Зависимость `osnova` связана с внешним локальным checkout через `--link-framework`. Для переноса нужен тот же пакет и обновление пути в `package.json`."}\nПеред изменением модулей прочитайте [локальную архитектуру](docs/architecture/MODULE_ARCHITECTURE.md).\n\nИспользуйте квалифицированный для исходного фреймворка Bun 1.4.0.\n\n\`\`\`sh\nbun install\nbun run dev\n# GET http://127.0.0.1:3000/health\n# При занятом порте: PORT=3100 bun run dev\n\`\`\`\n\nДобавить атомарный модуль из корня проекта: \`bun run osnova g module Task --empty\`.\nПосле заполнения паспорта и реализации модуля запустите \`bun run di:generate\`.\nДля проверки типов: \`bun run build\`. Для бинарника: \`bun run build:bin\`.\n\n\`--minimal\` создаёт пример CRUD с пагинацией (20 записей по умолчанию, не более 100 через HTTP); для запуска нужны provider БД и схема. Сервис возвращает \`PageResult\`, HTTP-контроллер формирует JSON:API. Сохранение выполняет \`DbContext.saveChanges()\` для всех изменений своего контекста. В ORM соединяйте условия через \`.and()\` и \`.or()\`; codegen отклоняет \`&&\` и \`||\` между предикатами.\n`],
  ];
}
