# src/validation — модуль валидации классов

Самодостаточный модуль валидации в ООП-стиле: один декоратор `@Validator(options)`
на полях класса + статические `Validator.validate` / `Validator.validateAsync`.

Полная спецификация (все сценарии с примерами, описание опций, коды ошибок,
плейсхолдеры) — в [SPEC.md](SPEC.md).

Принципы (общие для всего фреймворка):

- без внешних зависимостей — только Bun API;
- без рефлексии: стандартные TC39-декораторы + `Symbol.metadata`
  (никаких `experimentalDecorators`, `emitDecoratorMetadata`, `reflect-metadata`);
- совместимость с `bun build --compile` (проверено бинарником `validation-demo`);
- минимум аллокаций: план валидации класса компилируется один раз и кэшируется
  в WeakMap, объекты сообщений создаются только на пути ошибки;
- отказоустойчивость: исключения в `custom`/`validateIf` перехватываются
  (код `customError`), валидация продолжается и собирает все ошибки.

## Быстрый старт

```ts
import { Validator } from "@/library/validation";

class CreateUserDto {
  @Validator({ required: true, minLength: 3, maxLength: 50 })
  username!: string;

  @Validator({ required: true, email: true })
  email!: string;
}

const result = Validator.validate(dto);      // ValidationResult
await Validator.validateAsync(dto);           // ждёт async custom-функции
Validator.setDefaultMessages({ required: "Поле {property} обязательно" });
```

Полная демонстрация (сложные условия, async, вложенные объекты):
`bun src/examples/osnv/validation.ts`.

## Карта папки

| Файл | Назначение |
|---|---|
| `Validator.ts` | публичный фасад: декоратор + `validate`/`validateAsync`/`setDefaultMessages` |
| `ValidationError.ts` | одна ошибка: `property`, `value`, `message`, `code` |
| `ValidationResult.ts` | итог: `isValid`, `errors`, `getErrorsFor`, `hasErrorsFor` |
| `RuleEngine.ts` | движок: один проход по плану, sync/async, nested, защита от циклов |
| `RuleCompiler.ts` | компиляция правил класса в план + WeakMap-кэш (RegExp, enum-Set) |
| `MessageRegistry.ts` | шаблоны сообщений, плейсхолдеры, приоритет local > global > built-in; встроенные на английском, `RU_VALIDATION_MESSAGES` — русский набор для `setDefaults` |
| `metadata.ts` | хранение правил через `context.metadata` / `Symbol.metadata` |
| `types/ValidatorOptions.ts` | все опции декоратора |
| `types/ValidationCode.ts` | коды ошибок |
| `test/validation.test.ts` | тесты модуля |

## Замечание про `design:type`

`Reflect.getMetadata("design:type")` сознательно не используется: он требует
`emitDecoratorMetadata` и внешний пакет `reflect-metadata`, что нарушает
принципы «без зависимостей и рефлексии». Вместо этого ожидаемый тип
выводится из самих правил (`minLength` ⇒ строка, `min` ⇒ число,
`mustBeTrue` ⇒ boolean) или задаётся явной подсказкой `type`.
