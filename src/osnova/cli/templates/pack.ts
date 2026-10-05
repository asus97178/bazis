import { parseModuleName, type ModuleNaming } from "../naming";
import { validatePackParts } from "../parseCli";
import { buildModuleTemplates, type ModuleTemplateFiles } from "./module";

export function buildPackTemplates(naming: ModuleNaming, partNames: readonly string[]): readonly ModuleTemplateFiles[] {
  validatePackParts(partNames);
  const parts = partNames.map((name) => {
    const part = parseModuleName(name);
    // A part names a responsibility (Tables), not a CRUD entity (Table).
    return { ...part, entity: part.module, folder: `${part.folder}_module` };
  });
  if (parts.some((part) => part.moduleClass === naming.moduleClass)) {
    throw new Error("A pack and its parts must have distinct module class names.");
  }
  return [
    {
      relativePath: `${naming.module}.module.ts`,
      content: `import { Module } from "osnv/core/di";
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

Версия паспорта: 1.0. Тип: составной.
Статус: сгенерирован каркас композиции; части ещё не реализованы.
Точка подключения: [${naming.module}.module.ts](${naming.module}.module.ts).
До изменения прочитать AGENTS.md и docs/architecture/MODULE_ARCHITECTURE.md.

## Ответственность и части

Корень объединяет самостоятельные обязанности; точные границы данных и
инварианты частей автор фиксирует в их паспортах до реализации.
Если обязанности не самостоятельны, использовать один атомарный модуль.

| Часть | Ответственность и данные | Публичные входы | Зависит от | Паспорт |
| --- | --- | --- | --- | --- |
${parts.map((part) => `| ${part.moduleClass} | Ещё не определены: ${part.input} | Класс модуля без аргументов | imports: [] | [MODULE.md](${part.folder}/MODULE.md) |`).join("\n")}

## Каталог и подключение

Корневые файлы: этот паспорт, ${naming.module}.module.ts.
${parts.map((part) => `Каталог ${part.folder}: ${part.module}.module.ts и MODULE.md.`).join("\n")}
imports: [${parts.map((part) => part.moduleClass).join(", ")}]. exports: [].
TypeScript-вход — ${naming.moduleClass}; фабрика и входные поля отсутствуют.
Публичные токены частей при необходимости реэкспортируются корнем явно.
Предметные providers, ORM, HTTP, config, background, UI, AI и события корню
не принадлежат; их владельцы — атомарные части. Потребитель подключает корень.
Оркестрация нескольких частей также получает отдельного атомарного владельца.

## Входы, выходы, ошибки и lifecycle

Корень только подключает классы; публичных операций и собственных эффектов нет.
Аргументы, данные, обязательность/null/default, валидация, результаты, ошибки,
scopes и эффекты будущих операций описываются в паспортах частей.
Связи между частями, общая инфраструктура и нужные экспорты пока не определены.

## Проверки

Не запускались для нового пакета. После реализации: codegen, проверка
композиции, exports, отсутствия циклов и дублирующих регистраций, тесты частей.
Генерация каркаса не подтверждает предметную готовность пакета.
`,
    },
    ...parts.flatMap((part) => buildModuleTemplates(part, "empty").map((file) => ({
      relativePath: `${part.folder}/${file.relativePath}`, content: file.content,
    }))),
  ];
}
