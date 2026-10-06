# Модели запросов и валидация

Данные из тела запроса описываются классом. Поля помечаются правилами
`@Validator`, и неверный запрос отклоняется с кодом 400 ещё до вызова
контроллера.

```ts
import { RequestModel } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

@RequestModel()
export class CreateTaskRequest {
  @Validator({ required: true, minLength: 1, maxLength: 200 })
  title!: string;

  @Validator({ uuid: true })
  projectId?: string;
}
```

```ts
@Post()
create(body: CreateTaskRequest) {
  // сюда попадает только проверенный экземпляр CreateTaskRequest
}
```

Параметр метода, тип которого — класс из исходников приложения, bazis
заполняет из JSON-тела. `@RequestModel()` делает это намерение явным; модель
работает и без него, но с ним сразу понятно, что класс — входной контракт.

## Что делает bazis с телом запроса

1. **Проверяет типы JSON.** Поле, объявленное как `string`, `number` или
   `boolean`, должно прийти с этим JSON-типом: `"42"` вместо `42` даст
   ошибку `type`. Если есть ошибки типов, дальше проверка не идёт — клиент
   получает только их.
2. **Создаёт экземпляр класса.** Вложенные объекты и элементы массивов,
   объявленные классами, тоже становятся экземплярами своих классов.
3. **Отбрасывает лишние поля.** Поля, которых нет в классе, в модель не
   попадают.
4. **Проверяет правила `@Validator`** всех полей, включая вложенные, и
   возвращает **все** нарушения сразу.

Ответ на неверный запрос:

```json
{
  "error": "Validation failed",
  "details": [
    { "property": "email", "message": "Field \"email\" must be a valid email address", "code": "email" },
    { "property": "address.city", "message": "Field \"address.city\" must be at least 2 characters long", "code": "minLength" },
    { "property": "items[0].qty", "message": "Field \"items[0].qty\" must be at least 1", "code": "min" }
  ]
}
```

`property` — путь к полю, `code` — машинный код правила (по нему удобно
подсвечивать поля в интерфейсе), `message` — текст для человека.

## Правила

Правила одного декоратора объединяются: `@Validator({ required: true, minLength: 3 })`.
Необязательное поле (`title?: string`) без значения не проверяется.

**Общие**

| Правило | Что проверяет |
| --- | --- |
| `required: true` | Поле есть и не `null` |
| `validateIf: (obj) => boolean` | Остальные правила декоратора проверяются, только если функция вернула `true` |
| `custom: (value, obj) => …` | Своя проверка: вернуть `true` — ок, `false` или строку — ошибка |
| `message: "..."` | Свой текст ошибки для всех правил декоратора |
| `type: "date" \| "email" \| …` | Явная подсказка типа, когда TypeScript-тип не даёт её |

**Строки**

| Правило | Что проверяет |
| --- | --- |
| `notEmpty: true` | Не пустая строка |
| `minLength`, `maxLength`, `length: [min, max]` | Длина |
| `pattern: /…/` | Регулярное выражение |
| `contains`, `notContains` | Подстрока |
| `email`, `url`, `uuid`, `phone`, `json` | Формат |

**Числа**

| Правило | Что проверяет |
| --- | --- |
| `min`, `max`, `range: [min, max]` | Границы |
| `integer: true` | Целое число |
| `positive: true`, `negative: true` | Знак |

**Логические значения и перечисления**

| Правило | Что проверяет |
| --- | --- |
| `mustBeTrue`, `mustBeFalse` | Конкретное значение — например, согласие с условиями |
| `enumType: MyEnum` | Значение входит в TypeScript-`enum` |

Отдельного правила для длины массива нет. Проверить, что массив не пустой,
можно через `custom`:

```ts
@Validator({ required: true, custom: (items) => (Array.isArray(items) && items.length > 0) || "{property}: нужен хотя бы один элемент" })
items!: ItemInput[];
```

Не ставьте строковые правила (`notEmpty`, `minLength`) на массив — bazis
примет поле за строку и вернёт непонятную ошибку типа.

## Вложенные модели и массивы

```ts
export class AddressInput {
  @Validator({ required: true, minLength: 2 }) city!: string;
  @Validator({ pattern: /^\d{6}$/ }) zip?: string;
}

export class ItemInput {
  @Validator({ required: true, min: 1, max: 99 }) qty!: number;
}

@RequestModel()
export class OrderRequest {
  @Validator({ required: true }) address!: AddressInput;
  @Validator({ required: true }) items!: ItemInput[];
}
```

Правила вложенных классов проверяются автоматически, ошибки приходят с
путём: `address.city`, `items[0].qty`.

## Условные и собственные проверки

```ts
export enum Priority { Low = "low", High = "high" }

@RequestModel()
export class TicketRequest {
  @Validator({ enumType: Priority })
  priority?: Priority;

  // причина обязательна только для срочных заявок
  @Validator({ validateIf: (t: TicketRequest) => t.priority === Priority.High, required: true, minLength: 5 })
  reason?: string;

  @Validator({ custom: (value) => value !== "admin" || "{property}: это имя занято" })
  nickname?: string;
}
```

`custom` получает значение и весь объект — так проверяются связи между
полями. Если функция вернула строку, она становится текстом ошибки с кодом
`custom`.

> [!WARNING]
> Асинхронная `custom`-проверка (`async (value) => …`) в моделях HTTP-запросов
> пока не поддерживается: клиент получит 400 с кодом
> `asyncCustomInSyncCall`. Проверки, которым нужна база данных или сеть,
> делайте в сервисе.

## Свои тексты и русский язык

Свой текст для правила — через `message`. В тексте работают подстановки
`{property}`, `{value}`, `{min}`, `{max}`, `{pattern}`, `{expected}`,
`{actual}`:

```ts
@Validator({ pattern: /^\d{6}$/, message: "{property}: нужен индекс из 6 цифр" })
zip?: string;
```

Русские тексты для всех правил включаются одной строкой в начале
`src/index.ts`:

```ts
import { MessageRegistry, RU_VALIDATION_MESSAGES } from "bazis/library/validation";

MessageRegistry.setDefaults(RU_VALIDATION_MESSAGES);
```

```text
Поле "email" должно быть корректным email-адресом
Поле "items[0].qty" должно быть не меньше 1
```

> [!NOTE]
> Пока переводятся только сообщения правил `@Validator`. Ошибки типов JSON
> (`Field "qty" must be a number`) и заголовок `"error": "Validation failed"`
> остаются на английском.

## Дальше

- [Контроллеры](controllers.md)
- Ответы *(в работе)*
