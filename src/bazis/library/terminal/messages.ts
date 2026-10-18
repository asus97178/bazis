import type { Language } from "./language";

/**
 * Words of the terminal screens. Framing, statuses and hints are translated;
 * names from the code, file paths, environment variables and the raw text of
 * a driver error stay as they are.
 */

type Forms = readonly [one: string, few: string, many: string];

const NOUNS_EN = {
  file: ["file", "files", "files"],
  dep: ["dep", "deps", "deps"],
  controller: ["controller", "controllers", "controllers"],
  requestModel: ["request model", "request models", "request models"],
  list: ["list", "lists", "lists"],
  tool: ["tool", "tools", "tools"],
  section: ["section", "sections", "sections"],
  module: ["module", "modules", "modules"],
  route: ["route", "routes", "routes"],
  service: ["service", "services", "services"],
  job: ["background job", "background jobs", "background jobs"],
  operation: ["operation", "operations", "operations"],
  table: ["table", "tables", "tables"],
  schema: ["schema", "schemas", "schemas"],
  migration: ["migration", "migrations", "migrations"],
  problem: ["problem", "problems", "problems"],
  error: ["error", "errors", "errors"],
  warning: ["warning", "warnings", "warnings"],
  connection: ["connection", "connections", "connections"],
  test: ["test", "tests", "tests"],
  change: ["change", "changes", "changes"],
  part: ["part", "parts", "parts"],
  context: ["database context", "database contexts", "database contexts"],
} as const satisfies Record<string, Forms>;

export type Noun = keyof typeof NOUNS_EN;

const NOUNS_RU: Record<Noun, Forms> = {
  file: ["файл", "файла", "файлов"],
  dep: ["зависимость", "зависимости", "зависимостей"],
  controller: ["контроллер", "контроллера", "контроллеров"],
  requestModel: ["модель запроса", "модели запроса", "моделей запроса"],
  list: ["список", "списка", "списков"],
  tool: ["инструмент", "инструмента", "инструментов"],
  section: ["раздел", "раздела", "разделов"],
  module: ["модуль", "модуля", "модулей"],
  route: ["маршрут", "маршрута", "маршрутов"],
  service: ["сервис", "сервиса", "сервисов"],
  job: ["фоновая задача", "фоновые задачи", "фоновых задач"],
  operation: ["операция", "операции", "операций"],
  table: ["таблица", "таблицы", "таблиц"],
  schema: ["схема", "схемы", "схем"],
  migration: ["миграция", "миграции", "миграций"],
  problem: ["проблема", "проблемы", "проблем"],
  error: ["ошибка", "ошибки", "ошибок"],
  warning: ["предупреждение", "предупреждения", "предупреждений"],
  connection: ["подключение", "подключения", "подключений"],
  test: ["тест", "теста", "тестов"],
  change: ["изменение", "изменения", "изменений"],
  part: ["часть", "части", "частей"],
  context: ["контекст базы данных", "контекста базы данных", "контекстов базы данных"],
};

/** Genitive after «из N»: «из 1 подключения», «из 3 подключений», «из 21 подключения». */
const GENITIVE_RU: Partial<Record<Noun, readonly [one: string, many: string]>> = {
  connection: ["подключения", "подключений"],
};

function genitiveRu(count: number, noun: Noun): string {
  const forms = GENITIVE_RU[noun] ?? [NOUNS_RU[noun][1], NOUNS_RU[noun][2]];
  return count % 10 === 1 && count % 100 !== 11 ? forms[0] : forms[1];
}

function formEn(count: number, forms: Forms): string {
  return count === 1 ? forms[0] : forms[1];
}

function formRu(count: number, forms: Forms): string {
  const mod10 = count % 10, mod100 = count % 100;
  if (!Number.isInteger(count)) return forms[1];
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

const en = {
  language: "en" as Language,
  noun: (noun: Noun, count: number) => formEn(count, NOUNS_EN[noun]),
  badge: { ok: "OK", fail: "FAIL", skip: "SKIP", warn: "WARN", up: "UP", down: "DOWN", wait: "WAIT", info: "INFO" },
  banner: { success: "SUCCESS", failed: "FAILED" },
  section: {
    build: "BUILD", configuration: "CONFIGURATION", infrastructure: "INFRASTRUCTURE", schema: "DATABASE SCHEMA",
    modules: "MODULES", routes: "ROUTES", warnings: "WARNINGS", startup: "STARTUP", project: "PROJECT",
    files: "FILES", next: "NEXT STEPS", tests: "TESTS", binary: "EXECUTABLE", codegen: "CODEGEN", problems: "PROBLEMS",
  },
  step: {
    codegen: "codegen", typecheck: "typecheck", config: "config", connections: "connections", schema: "schema",
    modules: "modules", services: "services", tests: "bun test", compile: "compile", files: "files", register: "register",
  },
  meta: { env: "env", watch: "watch", on: "on", off: "off", src: "src", pid: "pid", target: "target", out: "output", path: "path" },
  common: {
    of: "of", in: "in", and: "and", none: "none", ok: "ok", empty: "empty", plus: "plus", memory: "memory",
    declaredIn: "declared in", code: "code", where: "where", try: "try", logs: "logs", inProcess: "in process",
    dryRun: "dry run — nothing was written",
  },
  config: {
    environment: (name: string) => `environment: ${name}`,
    devDefault: (count: number) => `${count === 1 ? "secret" : "secrets"} from dev default`,
    devDefaultNote: (env: string) => `← development default (set ${env} in production)`,
    invalid: (total: number) => `of ${total} sections invalid`,
    issue: {
      missingSecret: "required secret is not set",
      devSecret: "production would use the development default secret from the code",
      number: "expected a finite number",
      boolean: "expected a boolean (true, false, 1, 0)",
      string: "expected a string",
      enumValue: (values: string) => `value is not allowed, use one of: ${values}`,
      conflict: "conflicting environment aliases",
      validatorFailed: "validator failed",
      got: (value: string, source: string) => `got ${value} from ${source}`,
    },
    fix: {
      setVariable: (names: string) => `set ${names}`,
      orSecretFile: "or a file in a secretFilesSource directory",
      orProduction: (key: string) => `or declare ${key}: secret() with a value source in the production section`,
      change: (names: string) => `change ${names}`,
    },
  },
  infra: {
    up: (total: number) => `of ${total} up`,
    failed: (total: number) => `of ${total} connections failed`,
    parallel: "checked in parallel",
    waiting: "waiting for",
    timeoutStep: (count: number) => `${count} connection${count === 1 ? "" : "s"} did not answer`,
    connectTimeout: (seconds: string) => `connect() did not finish in ${seconds}`,
    hint: {
      password: (where: string) => `check the user and password: ${where}`,
      refused: (kind: string) => `is ${kind} running at this address?`,
      timeout: "no answer in time — the server is down or the address is wrong",
      address: (names: string) => `address: ${names}`,
      dns: "the host name does not resolve — check the address",
      database: "the database does not exist — create it or fix the name",
      deadline: "give connect() its own deadline and fail with a clear message",
      raiseLimit: "or raise the limit: runApp(…, { kernel: { startupTimeoutMs } })",
    },
  },
  schema: { add: "+", none: "schema is up to date", warnings: "schema warnings" },
  modules: {
    controller: "controller", service: "service", table: "table", background: "background", tool: "tool", exports: "exports",
    emptyHint: "empty — add providers, controllers or tools",
    every: (interval: string) => `every ${interval}`,
  },
  routes: { open: "open", auth: "auth", protected: "protected", roles: (roles: string) => roles },
  warnings: {
    openRoutes: (count: number) => `${count} route${count === 1 ? " is" : "s are"} open — no @Authorize. Protect ${count === 1 ? "it" : "them"} before production.`,
    devSecret: (key: string) => `${key} uses the development default from the code.`,
  },
  startup: {
    configuration: "configuration", container: "container", infrastructure: "infrastructure", schema: "schema", services: "services",
  },
  ready: {
    running: (app: string, ms: string) => `${app} is running · ready in ${ms}`,
    local: "Local", network: "Network", health: "Health", docs: "OpenAPI",
    notExposed: (host: string) => `not exposed — listening on ${host} (set HOST=0.0.0.0)`,
    watching: (src: string) => `watching ${src} · restarts on change · logs below · Ctrl+C to stop`,
    noWatch: "logs below · Ctrl+C to stop",
    worker: (app: string, ms: string) => `${app} started · ready in ${ms}`,
  },
  failure: {
    config: (count: number) => `configuration is invalid · ${count} problem${count === 1 ? "" : "s"}`,
    infra: (down: number, total: number) => `infrastructure is down · ${down} of ${total} connection${total === 1 ? "" : "s"}`,
    timeout: (seconds: string) => `startup timed out after ${seconds}`,
    di: "dependency injection is not wired",
    codegen: (count: number) => `codegen failed · ${count} error${count === 1 ? "" : "s"}`,
    app: "application failed to start",
    typecheck: (count: number) => `typecheck failed · ${count} error${count === 1 ? "" : "s"}`,
    tests: "tests failed",
    command: "command failed",
    skipConfig: "not checked — configuration is invalid",
    skipInfra: "not started — infrastructure is down",
    skipCodegen: "not started — codegen failed",
    skipEarlier: "not started — an earlier stage failed",
    exitNothing: (code: number) => `exit code ${code} · nothing was started`,
    exitWatch: (code: number, src: string) => `exit code ${code} · watching ${src} — fix and save to restart`,
    exit: (code: number) => `exit code ${code}`,
    timeoutCause: (name: string, seconds: string) => `${name} did not finish starting in ${seconds} and gave no error`,
    dbMissing: (users: string) => `no database is connected, but ${users} use${users.includes(",") ? "" : "s"} one`,
    dbFix: "connect a database: @Infra({ db: ormBazisConnect(dbConfig) })",
  },
  build: {
    typecheckOk: "no type errors",
    done: (ms: string) => `build is ready · ${ms}`,
    binary: (path: string, size: string) => `${path} · ${size}`,
    binaryDone: (path: string) => `executable is ready · ${path}`,
    run: "run",
    production: "BAZIS_ENV defaults to production in the executable",
    dotenv: "reads .env files from its working directory",
  },
  codegen: {
    done: (ms: string) => `codegen is ready · ${ms}`,
    generatedInto: "into",
    unreachable: (file: string) => `${file} is not imported from the entrypoint — skipped`,
    unreachableFix: "import its module in the host module, or remove the file",
    outputs: "generated",
    sqlFix: "inject IPostgres from bazis/core/infra instead of Bun's SQL",
    redisFix: "inject IRedis from bazis/core/infra instead of Bun's RedisClient",
    unknownDepFix: "register the class in a module, declare a token with createToken, or bind it with an explicit factory",
    run: "run",
  },
  dev: {
    restarting: "changed — restarting",
  },
  test: {
    done: "all tests passed",
    failed: (code: number) => `bun test exited with code ${code}`,
  },
  project: {
    created: (name: string) => `project ${name} is created`,
    planned: (name: string) => `project ${name} is planned`,
    dependency: (version: string) => `bazis ${version} from npm`,
    vendor: (count: number) => `vendor/bazis · ${count} package files — keep it in version control`,
    linked: "bazis is linked to a local checkout",
    install: "install dependencies",
    dev: "start in development mode",
    open: "open in the browser",
  },
  module: {
    kind: { module: "module", pack: "pack" } as Record<"module" | "pack", string>,
    created: (kind: string, name: string) => `${kind} ${name} is generated`,
    planned: (kind: string, name: string) => `${kind} ${name} is planned`,
    registered: (host: string) => `connected in ${host}`,
    notRegistered: "not connected — codegen skips it until a module imports it",
    codegenSkipped: "codegen skipped (--no-codegen) — run bazis codegen",
    needsDb: "this module uses a database: connect one with @Infra({ db: ormBazisConnect(dbConfig) })",
    needsCache: "this module caches: pass runApp(AppModule, { cache: memory() })",
    keptOnFailure: "scaffold files were kept — fix the error and run bazis codegen",
  },
  errors: {
    unknown: "Use bazis --help to list commands and options.",
    bunTooOld: (required: string, actual: string) => `bazis needs Bun ${required.startsWith(">=") ? `${required.slice(2).trim()} or newer` : required}; this is Bun ${actual}.`,
    bunWhich: (file: string) => `This Bun is ${file}. bunx bazis and bun run scripts start bazis with the first bun in PATH, not with the Bun that called them.`,
    bunUpgrade: "Update that Bun: bun upgrade. Or put the newer Bun first in PATH.",
  },
};

export type Messages = typeof en;

const ru: Messages = {
  language: "ru",
  noun: (noun, count) => formRu(count, NOUNS_RU[noun]),
  badge: { ok: "ГОТОВО", fail: "ОШИБКА", skip: "ПРОПУСК", warn: "ВНИМАНИЕ", up: "ОК", down: "СБОЙ", wait: "ЖДЁМ", info: "ИНФО" },
  banner: { success: "УСПЕХ", failed: "ПРОВАЛ" },
  section: {
    build: "СБОРКА", configuration: "КОНФИГУРАЦИЯ", infrastructure: "ИНФРАСТРУКТУРА", schema: "СХЕМА БАЗЫ ДАННЫХ",
    modules: "МОДУЛИ", routes: "МАРШРУТЫ", warnings: "ПРЕДУПРЕЖДЕНИЯ", startup: "ЗАПУСК", project: "ПРОЕКТ",
    files: "ФАЙЛЫ", next: "ДАЛЬШЕ", tests: "ТЕСТЫ", binary: "ИСПОЛНЯЕМЫЙ ФАЙЛ", codegen: "КОДОГЕНЕРАЦИЯ", problems: "ПРОБЛЕМЫ",
  },
  step: {
    codegen: "кодогенерация", typecheck: "типы", config: "конфигурация", connections: "подключения", schema: "схема",
    modules: "модули", services: "сервисы", tests: "bun test", compile: "компиляция", files: "файлы", register: "подключение",
  },
  meta: { env: "среда", watch: "слежение", on: "вкл", off: "выкл", src: "вход", pid: "pid", target: "цель", out: "файл", path: "путь" },
  common: {
    of: "из", in: "в", and: "и", none: "нет", ok: "в порядке", empty: "пусто", plus: "ещё", memory: "память",
    declaredIn: "объявлено в", code: "код", where: "где", try: "попробуйте", logs: "журнал", inProcess: "в процессе",
    dryRun: "пробный запуск — ничего не записано",
  },
  config: {
    environment: (name) => `среда: ${name}`,
    devDefault: (count) => `${formRu(count, ["секрет", "секрета", "секретов"])} из значения для разработки`,
    devDefaultNote: (env) => `← значение для разработки (в production задайте ${env})`,
    invalid: (total) => `из ${total} с ошибками`,
    issue: {
      missingSecret: "обязательный секрет не задан",
      devSecret: "в production попадёт секрет для разработки из кода",
      number: "нужно конечное число",
      boolean: "нужно логическое значение (true, false, 1, 0)",
      string: "нужна строка",
      enumValue: (values) => `значение не разрешено, используйте одно из: ${values}`,
      conflict: "переменные-синонимы заданы по-разному",
      validatorFailed: "проверка значения упала",
      got: (value, source) => `получено ${value} из ${source}`,
    },
    fix: {
      setVariable: (names) => `задайте ${names}`,
      orSecretFile: "или файл в каталоге secretFilesSource",
      orProduction: (key) => `или объявите ${key}: secret() с источником значения в разделе production`,
      change: (names) => `исправьте ${names}`,
    },
  },
  infra: {
    up: (total) => `из ${total} работают`,
    failed: (total) => `из ${total} не подключились`,
    parallel: "проверены параллельно",
    waiting: "ждём",
    timeoutStep: (count) => `${count} ${formRu(count, NOUNS_RU.connection)} не ответило`,
    connectTimeout: (seconds) => `connect() не завершился за ${seconds}`,
    hint: {
      password: (where) => `проверьте пользователя и пароль: ${where}`,
      refused: (kind) => `запущен ли ${kind} по этому адресу?`,
      timeout: "нет ответа вовремя — сервер не запущен или адрес неверный",
      address: (names) => `адрес: ${names}`,
      dns: "имя хоста не разрешается — проверьте адрес",
      database: "базы данных нет — создайте её или исправьте имя",
      deadline: "дайте connect() свой срок и понятную ошибку",
      raiseLimit: "или увеличьте предел: runApp(…, { kernel: { startupTimeoutMs } })",
    },
  },
  schema: { add: "+", none: "схема актуальна", warnings: "предупреждения схемы" },
  modules: {
    controller: "контроллер", service: "сервис", table: "таблица", background: "фон", tool: "инструмент", exports: "экспорт",
    emptyHint: "пусто — добавьте провайдеры, контроллеры или инструменты",
    every: (interval) => `каждые ${interval}`,
  },
  routes: { open: "открыт", auth: "доступ", protected: "защищён", roles: (roles) => roles },
  warnings: {
    openRoutes: (count) => `${count} ${formRu(count, NOUNS_RU.route)} без @Authorize. Защитите их до production.`,
    devSecret: (key) => `${key} берёт значение для разработки из кода.`,
  },
  startup: {
    configuration: "конфигурация", container: "контейнер", infrastructure: "инфраструктура", schema: "схема", services: "сервисы",
  },
  ready: {
    running: (app, ms) => `${app} работает · готово за ${ms}`,
    local: "Локально", network: "Сеть", health: "Здоровье", docs: "OpenAPI",
    notExposed: (host) => `недоступно снаружи — слушает ${host} (задайте HOST=0.0.0.0)`,
    watching: (src) => `слежу за ${src} · перезапуск при изменениях · журнал ниже · Ctrl+C — остановить`,
    noWatch: "журнал ниже · Ctrl+C — остановить",
    worker: (app, ms) => `${app} запущено · готово за ${ms}`,
  },
  failure: {
    config: (count) => `конфигурация с ошибками · ${count} ${formRu(count, NOUNS_RU.problem)}`,
    infra: (down, total) => `инфраструктура недоступна · ${down} из ${total} ${genitiveRu(total, "connection")}`,
    timeout: (seconds) => `запуск не уложился в ${seconds}`,
    di: "внедрение зависимостей не собрано",
    codegen: (count) => `кодогенерация не удалась · ${count} ${formRu(count, NOUNS_RU.error)}`,
    app: "приложение не запустилось",
    typecheck: (count) => `проверка типов не прошла · ${count} ${formRu(count, NOUNS_RU.error)}`,
    tests: "тесты не прошли",
    command: "команда не выполнена",
    skipConfig: "не проверялось — конфигурация с ошибками",
    skipInfra: "не запускалось — инфраструктура недоступна",
    skipCodegen: "не запускалось — кодогенерация не удалась",
    skipEarlier: "не запускалось — предыдущий этап не удался",
    exitNothing: (code) => `код выхода ${code} · ничего не запущено`,
    exitWatch: (code, src) => `код выхода ${code} · слежу за ${src} — исправьте и сохраните для перезапуска`,
    exit: (code) => `код выхода ${code}`,
    timeoutCause: (name, seconds) => `${name} не завершил запуск за ${seconds} и не сообщил об ошибке`,
    dbMissing: (users) => `база данных не подключена, а её использует ${users}`,
    dbFix: "подключите базу: @Infra({ db: ormBazisConnect(dbConfig) })",
  },
  build: {
    typecheckOk: "ошибок типов нет",
    done: (ms) => `сборка готова · ${ms}`,
    binary: (path, size) => `${path} · ${size}`,
    binaryDone: (path) => `исполняемый файл готов · ${path}`,
    run: "запуск",
    production: "в исполняемом файле BAZIS_ENV по умолчанию production",
    dotenv: "читает .env из рабочего каталога",
  },
  codegen: {
    done: (ms) => `кодогенерация готова · ${ms}`,
    generatedInto: "в",
    unreachable: (file) => `${file} не импортируется из точки входа — пропущен`,
    unreachableFix: "импортируйте его модуль в модуль-хозяин или удалите файл",
    outputs: "сгенерировано",
    sqlFix: "внедряйте IPostgres из bazis/core/infra вместо SQL из Bun",
    redisFix: "внедряйте IRedis из bazis/core/infra вместо RedisClient из Bun",
    unknownDepFix: "зарегистрируйте класс в модуле, объявите токен через createToken или привяжите явной фабрикой",
    run: "запуск",
  },
  dev: {
    restarting: "изменён — перезапуск",
  },
  test: {
    done: "все тесты прошли",
    failed: (code) => `bun test завершился с кодом ${code}`,
  },
  project: {
    created: (name) => `проект ${name} создан`,
    planned: (name) => `проект ${name} запланирован`,
    dependency: (version) => `bazis ${version} из npm`,
    vendor: (count) => `vendor/bazis · ${count} файлов пакета — храните в системе контроля версий`,
    linked: "bazis подключён из локальной копии",
    install: "установите зависимости",
    dev: "запустите в режиме разработки",
    open: "откройте в браузере",
  },
  module: {
    kind: { module: "модуль", pack: "составной модуль" },
    created: (kind, name) => `${kind} ${name} создан`,
    planned: (kind, name) => `${kind} ${name} запланирован`,
    registered: (host) => `подключён в ${host}`,
    notRegistered: "не подключён — кодогенерация пропускает его, пока модуль не импортирован",
    codegenSkipped: "кодогенерация пропущена (--no-codegen) — запустите bazis codegen",
    needsDb: "модулю нужна база данных: подключите её через @Infra({ db: ormBazisConnect(dbConfig) })",
    needsCache: "модуль кэширует: передайте runApp(AppModule, { cache: memory() })",
    keptOnFailure: "файлы модуля оставлены — исправьте ошибку и запустите bazis codegen",
  },
  errors: {
    unknown: "Список команд и опций: bazis --help.",
    bunTooOld: (required, actual) => `bazis нужен Bun ${required.startsWith(">=") ? `${required.slice(2).trim()} или новее` : required}, а запущен Bun ${actual}.`,
    bunWhich: (file) => `Запущен ${file}. bunx bazis и скрипты bun run запускают bazis первым bun из PATH, а не тем Bun, который их вызвал.`,
    bunUpgrade: "Обновите этот Bun: bun upgrade. Или поставьте новый Bun первым в PATH.",
  },
};

const DICTIONARIES: Readonly<Record<Language, Messages>> = Object.freeze({ en, ru });

export function messages(language: Language): Messages {
  return DICTIONARIES[language];
}

/** `3 files`, `3 файла`. */
export function count(t: Messages, value: number, noun: Noun): string {
  return `${value} ${t.noun(noun, value)}`;
}
