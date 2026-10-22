# Русская локализация

API на русском:
- ответы с ошибками;
- проверка данных;
- даты, деньги и числительные;
- вывод CLI.

Пример — каталог книг из рецепта
[Если вы пришли с NestJS](from-nestjs.md).

Все примеры проверены на bazis 0.111.2 и Bun 1.4.3.

## Язык ответов

Одна опция в `src/index.ts`:

```ts
await runApp(AppModule, {
  language: "ru",
  http: { /* … */ middleware: [bookErrors] },
});
```

По-русски становится всё, что фреймворк пишет в ответ сам:

```text
GET  /nope                           → 404 {"error":"Не найдено"}
DELETE /books                        → 405 {"error":"Метод не поддерживается"}
GET  /books                          → 400 … {"property":"q","message":"Поле \"q\" обязательно для заполнения","code":"required"}
GET  /books?q=a&limit=x              → 400 … {"property":"limit","message":"Поле \"limit\": ожидается число, получено: строка","code":"type"}
POST /books  без ключа               → 401 {"error":"Требуется аутентификация"}
POST /books  x-admin-key: x          → 403 {"error":"Доступ запрещён"}
POST /books  not json                → 400 {"error":"Тело запроса — некорректный JSON"}
POST /books  []                      → 400 {"error":"Тело запроса должно быть JSON-объектом"}
```

Ошибки проверки — тоже, вместе с заголовком:

```text
POST /books {"title":"","year":"abc"}
→ 400 {"error":"Проверка данных не пройдена","details":[
    {"property":"year","message":"Поле \"year\": ожидается число, получено: строка","code":"type"},
    {"property":"title","message":"Поле \"title\": минимальная длина — 1","code":"minLength"},
    {"property":"author","message":"Поле \"author\" обязательно для заполнения","code":"required"}]}

{"year":1200}   → Поле "year" должно быть в диапазоне от 1450 до 2100
{"year":1961.5} → Поле "year" должно быть целым числом
```

- **Код ошибки не переводится.** `code` (`minLength`, `required`, `type`)
  остаётся прежним: по нему клиент решает, что делать, а `message`
  показывает человеку.
- **Числа в шаблонах стоят после тире** («минимальная длина — 1»), поэтому
  склонять их не нужно. Названия типов тоже по-русски: «число», «строка»,
  «массив».
- **Без `language` тексты английские**, как раньше: `Not Found`,
  `Validation failed`.

Язык задаётся для каждого приложения отдельно, а не для всего процесса.
Два приложения в одном процессе — например, в тестах — отвечают каждое на
своём языке.

### Язык по `Accept-Language`

Если клиентам нужны разные языки, перечислите их:

```ts
await runApp(AppModule, { language: { default: "ru", supported: ["ru", "en"] }, http: { /* … */ } });
```

Каждый запрос получает лучший язык из `Accept-Language` (с учётом `q`,
`ru-RU` → `ru`), а без заголовка или с неподдерживаемым языком — `default`:

```text
GET /projects                                        → 401 Content-Language: ru  {"error":"Требуется аутентификация"}
GET /projects   accept-language: en-US,en;q=0.9      → 401 Content-Language: en  {"error":"Unauthorized"}

POST /auth/register {"email":"bad","password":"x"}
  без заголовка → {"error":"Проверка данных не пройдена","details":[{"property":"email","message":"Поле \"email\" должно быть корректным email-адресом",…
  en            → {"error":"Validation failed","details":[{"property":"email","message":"Field \"email\" must be a valid email address",…
```

- Ответы с текстом фреймворка получают `Content-Language` и
  `Vary: Accept-Language`: кэши не отдадут английский ответ русскому
  клиенту.
- Успешные ответы контроллеров эти заголовки не получают и по-прежнему
  попадают в [кэш ответов](../http/output-cache.md). Если ответ зависит от
  языка, используйте `ctx.language` — выбранный язык — и сами добавьте
  `Vary: Accept-Language`.
- Тексты `CodexError` — на языке `default`: они общие на процесс.

> [!NOTE]
> Выбор по `Accept-Language` — с версии 0.108.0.

> [!NOTE]
> Опция `language` — с версии 0.100.7. Раньше переводились только
> сообщения проверки (через `MessageRegistry.setDefaults`), а `404`, `401` и
> ошибки привязки параметров оставались английскими.

## Свои тексты

### Текст фреймворка

Отдельный текст можно заменить поверх выбранного языка:

```ts
await runApp(AppModule, {
  language: "ru",
  messages: { notFound: "Такой страницы нет" },
  http: { /* … */ },
});
```

```text
GET /nope        → 404 {"error":"Такой страницы нет"}
GET /books/abc   → 404 {"error":"Такой страницы нет"}     ← :id(int) не совпал
```

Ключи и исходные тексты:
- для HTTP — в `EN_HTTP_MESSAGES` и `RU_HTTP_MESSAGES` из `bazis/core/http`;
- для проверки — в `EN_VALIDATION_MESSAGES` и `RU_VALIDATION_MESSAGES` из
  `bazis/library/validation`.

Подстановки те же: `{property}`, `{min}`, `{name}`…

```ts
messages: { required: "Заполните поле {property}" }
```

### Текст приложения

Сообщения, которые приложение задаёт само, не переводятся и не меняются:

```ts
export class BookNotFound extends Error {
  constructor(readonly id: number) {
    super(`Книга ${id} не найдена`);
  }
}
// middleware: throw new NotFoundError(error.message, { id: error.id })
```

```text
GET /books/99 → 404 {"error":"Книга 99 не найдена","details":{"id":99}}
```

### Название поля

В шаблонах стоит имя свойства: `Поле "title"`. Чтобы назвать поле
по-человечески, дайте правилу свой `message`. Он заменяет текст всех
проверок этого декоратора:

```ts
@Validator({ required: true, minLength: 1, maxLength: 200, message: "Укажите название книги, до 200 символов" })
title!: string;
```

```text
{"property":"title","message":"Укажите название книги, до 200 символов","code":"required"}
```

## Даты, деньги, числительные

Bun собран с полными данными ICU, поэтому `Intl` знает русский без
дополнительных пакетов. Удобно собрать форматтеры в одном файле:

```ts
// src/app/shared/ru.ts
const plurals = new Intl.PluralRules("ru-RU");
const dates = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Moscow" });
const rubles = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const collator = new Intl.Collator("ru-RU");

/** "1 книга", "3 книги", "5 книг", "21 книга". */
export function plural(count: number, one: string, few: string, many: string): string {
  const form = plurals.select(count);
  return `${count} ${form === "one" ? one : form === "many" ? many : few}`;
}

/** "17 октября 2026 г. в 12:05" by Moscow time. */
export const formatDate = (date: Date): string => dates.format(date);

/** "1 234 567,50 ₽". */
export const formatRubles = (amount: number): string => rubles.format(amount);

/** Sorts Russian text in dictionary order: "арбуз", "ёж", "Ель", "Яблоко". */
export const compareRu = (a: string, b: string): number => collator.compare(a, b);
```

```ts
@Get()
@ActionFilter({ after: (_ctx, result: Book[]) => ({ items: result, summary: `Найдено: ${plural(result.length, "книга", "книги", "книг")}` }) })
search(q: string, limit = 10) {
  return this.books.search(q, limit);
}
```

```text
GET /books?q=du → {"items":[{"id":1,"title":"Dune","author":"Herbert"}],"summary":"Найдено: 1 книга"}
```

- **Часовой пояс задавайте явно.** Без `timeZone` время форматируется в
  поясе сервера, а в контейнере это обычно UTC.
- **Дробные числа** `PluralRules` относит к форме `other`; `plural` выше
  берёт для неё форму «книги».
- **`Intl.Collator`** ставит «ё» рядом с «е», а заглавные буквы — рядом
  со строчными. Обычный `sort()` поставил бы «Ель» и «Яблоко» перед «арбуз».

> [!WARNING]
> Между разрядами и перед `₽` `Intl` ставит неразрывный пробел (U+00A0), а
> не обычный. Тест, который сравнивает строку с `"1 234 567,50 ₽"`,
> набранной с клавиатуры, упадёт. Пишите `"1 234 567,50 ₽"`.

## Тесты

`startTestApp` не читает `src/index.ts`. Передайте язык и свои тексты и
в тест:

```ts
const app = await startTestApp(AppModule, {
  language: "ru",
  messages: { notFound: "Такой страницы нет" },
  http: { middleware: [bookErrors] },
});
expect(await (await app.fetch("/nope")).json()).toEqual({ error: "Такой страницы нет" });
expect((await (await app.fetch("/books")).json()).details).toEqual([{ property: "q", message: 'Поле "q" обязательно для заполнения', code: "required" }]);
```

Чтобы настройки не расходились, вынесите их в одну функцию, как
`startPlanner()` в рецепте [JWT](jwt-auth.md).

## CLI на русском

Язык вывода `bazis` — экран запуска, `codegen`, `test`, `build` — задаётся
отдельно от языка ответов. Можно переменной `BAZIS_LANG=ru` или полем
`language` в `bazis.config.json`:

```json
{ "version": 1, "language": "ru", "defaultTarget": "production", "targets": { … } }
```

```text
    ✔  УСПЕХ   все тесты прошли · 184 ms
```

Подробнее — в главе [Команды CLI](../cli/commands.md#язык).

## Чего пока нет

- **Перевода внутри сервиса.** `Validator.validate()`, вызванный в коде
  сервиса, а не при привязке запроса, берёт тексты из глобального реестра
  и по умолчанию отвечает по-английски. Для русского вызовите один раз при
  старте `MessageRegistry.setDefaults(RU_VALIDATION_MESSAGES)`:

  ```text
  до:    Field "author" must be at least 1 characters long
  после: Поле "author": минимальная длина — 1
  ```

- **Русского журнала и ошибок конфигурации.** Строки журнала (`info: bazis
  started`) и ошибки запуска остаются английскими: их читают
  разработчики и системы сбора логов.

## Дальше

- [Проверка данных](../overview/validation.md)
- [Ошибки](../overview/errors.md)
- [Команды CLI](../cli/commands.md)
