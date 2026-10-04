# osnv — Osnova

Модульный backend-фреймворк для [Bun](https://bun.com) на TypeScript: DI с
кодогенерацией, HTTP, ORM для PostgreSQL, JWT, WebSocket, фоновые службы,
AI-агенты и CLI. Пакет поставляется исходниками TypeScript и работает только
в Bun (≥ 1.4.0): сборка в JavaScript не нужна, типы берутся из исходников.

## Новый проект

```sh
bunx osnv new MyApp
cd my-app
bun install
bunx osnv dev      # GET http://127.0.0.1:3000/health
```

Модуль внутри проекта: `bunx osnv g module Task --empty` (кодогенерация
запускается сама). Разработка с перезапуском при изменениях: `bunx osnv dev --watch`.
Тесты: `bunx osnv test`. Проверка типов: `bunx osnv build`; бинарник: `bunx osnv build --bin`.

`osnv dev`, `test`, `build` сами запускают кодогенерацию. Если запустить
приложение в обход CLI после правки кода, оно предупредит при старте, что
сгенерированный код устарел.

## В существующем проекте

```sh
bun add osnv
```

```ts
// src/index.ts — так его создаёт `bunx osnv new`
import { runApp } from "osnv/core/app";
import { AppModule } from "./app/modules/App.module";
import { registerOsnovaGeneratedRuntime } from "./generated/osnv/runtime";

await registerOsnovaGeneratedRuntime();
await runApp(AppModule, { http: { hostname: "127.0.0.1", port: 3000, health: true } });
```

`src/generated/osnv/` создаёт кодогенерация
`bun run node_modules/osnv/core/scripts/di-generate.ts` по файлу
`osnv.config.json`: она связывает зависимости конструкторов и HTTP-модели.
Проще всего начать с `bunx osnv new` — он создаёт эти файлы и скрипты.
Публичные входы перечислены в `exports` файла `package.json`.

## Лицензия

MIT
