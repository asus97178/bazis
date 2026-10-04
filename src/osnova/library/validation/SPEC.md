# Модуль валидации Osnova — спецификация

Декларативная валидация классов: один декоратор `@Validator(options)` на полях
и статические методы `Validator.validate` / `Validator.validateAsync`.

Быстрая навигация:
- [1. Что это и зачем](#1-что-это-и-зачем)
- [2. Быстрый старт](#2-быстрый-старт)
- [3. Справочник опций декоратора](#3-справочник-опций-декоратора)
- [4. Сценарии использования](#4-сценарии-использования)
- [5. Результат: `ValidationResult` и `ValidationError`](#5-результат-validationresult-и-validationerror)
- [6. Сообщения об ошибках и плейсхолдеры](#6-сообщения-об-ошибках-и-плейсхолдеры)
- [7. Коды ошибок](#7-коды-ошибок)
- [8. Производительность и сборка в бинарник](#8-производительность-и-сборка-в-бинарник)
- [9. Безопасность и отказоустойчивость](#9-безопасность-и-отказоустойчивость)
- [10. Ограничения и анти-паттерны](#10-ограничения-и-анти-паттерны)

---

## 1. Что это и зачем

Модуль решает одну задачу: **проверить, что объект (обычно DTO на границе
системы — тело HTTP-запроса, сообщение из очереди, конфиг) соответствует
правилам**, и вернуть полный список нарушений.

Зачем свой модуль, а не class-validator:

- **Без внешних зависимостей** — только Bun API, ничего не тянется в бинарник.
- **Без рефлексии** — никаких `emitDecoratorMetadata` / `reflect-metadata`.
  Правила хранятся через стандартные TC39-декораторы и `Symbol.metadata`,
  которые Bun выполняет нативно. Поэтому модуль свободно компилируется
  через `bun build --compile`.
- **Один проход — ошибки всех полей.** Валидация не останавливается на первой
  ошибке. После превышения верхней границы длины строки проверки её содержимого
  в том же декораторе пропускаются; ошибка длины остаётся в результате.
- **Отказоустойчивость.** Исключение в пользовательской функции не роняет
  валидацию — оно превращается в обычную ошибку с кодом `customError`.
- **ООП-стиль.** Правила живут рядом с полями класса, движок — за фасадом
  `Validator`.

Импорт всего публичного API — из одной точки:

```ts
import { Validator, ValidationError, ValidationResult, ValidationCodes } from "@/library/validation";
```

---

## 2. Быстрый старт

```ts
import { Validator } from "@/library/validation";

class CreateUserDto {
  @Validator({ required: true, minLength: 3, maxLength: 50 })
  username!: string;

  @Validator({ required: true, email: true })
  email!: string;

  @Validator({ required: true, min: 18, integer: true })
  age!: number;
}

const dto = new CreateUserDto();
dto.username = "ab";            // короче 3
dto.age = 17.5;                 // меньше 18 и не целое

const result = Validator.validate(dto);

result.isValid;                  // false
result.errors.length;            // 4 (minLength, required email, min, integer)
result.hasErrorsFor("email");    // true
result.getErrorsFor("age")[0].message;
// 'Поле "age" должно быть не меньше 18'
```

Правила класса собираются и компилируются **один раз** при первом вызове
`validate` (кэш в WeakMap) — повторные проверки ничего не пересобирают.

---

## 3. Справочник опций декоратора

Один `@Validator({...})` — один набор правил. На поле можно вешать несколько
декораторов, выполняются все.

### Общие

| Опция | Тип | Что делает |
|---|---|---|
| `required` | `boolean` | `undefined`/`null` — ошибка `required`. Без него отсутствующее значение пропускает все проверки |
| `type` | `"string" \| "number" \| "boolean" \| "enum" \| "json" \| "phone" \| "email" \| "date" \| "any"` | подсказка типа; несоответствие — ошибка `type`. Опциональна: тип также выводится из правил (`minLength` ⇒ строка, `min` ⇒ число) |
| `validateIf` | `(instance) => boolean` | вернула `false` — все остальные правила **этого декоратора** пропускаются |
| `custom` | `(value, instance) => boolean \| string \| void \| ValidationError \| Promise<...>` | пользовательская проверка, см. [4.6](#46-custom-пользовательские-проверки) |
| `message` | `string` | локальный шаблон сообщения для всех правил декоратора; приоритетнее глобальных |
| `nested` | `boolean` | рекурсивная проверка значения; без указания включается автоматически, `false` — отключает, см. [4.9](#49-вложенные-объекты-и-массивы-nested) |

### Строки

Любое из этих правил требует, чтобы значение было строкой (иначе — одна ошибка `type`).

| Опция | Тип | Ошибка при |
|---|---|---|
| `notEmpty` | `boolean` | пустая строка `""` |
| `minLength` / `maxLength` | `number` | длина меньше/больше указанной |
| `length` | `[number, number]` | длина вне диапазона (включительно) |
| `contains` / `notContains` | `string` | подстрока отсутствует / присутствует |
| `pattern` | `RegExp \| string` | строка не матчится (строка-источник компилируется один раз) |
| `email` | `boolean` | не email-адрес |
| `url` | `boolean` | не URL (проверка через `URL.canParse`) |
| `uuid` | `boolean` | не UUID версий 1–8 (nil-UUID допустим, регистр не важен) |
| `json` | `boolean` | не парсится `JSON.parse` |
| `phone` | `boolean` | не телефон: опциональный `+`, 7–15 цифр; пробелы, дефисы и скобки игнорируются |

`maxLength` и верхняя граница `length` ограничивают вход последующих проверок
содержимого **этого же декоратора**: `contains`, `notContains`, `pattern`, `email`,
`url`, `uuid`, `json`, `phone`. При превышении остаются ошибки длины, а перечисленные
проверки не выполняются. Нижняя граница длины, остальные поля/декораторы и `custom`
сохраняют прежнее поведение. Для недоверенного `pattern` задавайте верхнюю границу
в одном декораторе с ним; отдельный декоратор ограничения не меняет соседние правила.

### Числа

Требуют `typeof value === "number"` и не-`NaN` (иначе — ошибка `type`).

| Опция | Тип | Ошибка при |
|---|---|---|
| `min` / `max` | `number` | меньше/больше границы |
| `range` | `[number, number]` | вне диапазона (включительно) |
| `positive` / `negative` | `boolean` | значение `<= 0` / `>= 0` |
| `integer` | `boolean` | не целое |

### Boolean

| Опция | Ошибка при |
|---|---|
| `mustBeTrue` | значение не `true` (типичный кейс — согласие с условиями) |
| `mustBeFalse` | значение не `false` |

### Enum

| Опция | Тип | Что делает |
|---|---|---|
| `enumType` | `object` (enum TypeScript) | значение должно входить в значения enum; обратные ключи числовых enum игнорируются |

---

## 4. Сценарии использования

### 4.1 Обязательные и опциональные поля

`required` проверяет только `undefined` и `null`. Всё остальное — отдельные
правила (пустая строка — это `notEmpty`, не `required`).

```ts
class Dto {
  @Validator({ required: true })
  id!: string;                 // нет значения -> ошибка required

  @Validator({ minLength: 3 })
  comment?: string;            // нет значения -> валидно; есть -> проверяется длина
}
```

### 4.2 Строки

```ts
class ArticleDto {
  @Validator({ required: true, length: [5, 120], notContains: "<script" })
  title!: string;

  @Validator({ pattern: /^[a-z0-9-]+$/, message: "Slug — только строчные буквы, цифры и дефис" })
  slug!: string;

  @Validator({ contains: "@corp.ru" })
  authorEmail!: string;
}
```

`pattern` принимает и строку-источник: `@Validator({ pattern: "^\\d{4}$" })`.

### 4.3 Форматы: email, url, uuid, json, phone, date

```ts
class ContactDto {
  @Validator({ email: true })
  email?: string;              // user@example.com

  @Validator({ url: true })
  site?: string;               // https://bun.sh/docs

  @Validator({ uuid: true })
  id?: string;                 // v4 (crypto.randomUUID) и v7 (Bun.randomUUIDv7)

  @Validator({ json: true })
  payload?: string;            // '{"a":1}'

  @Validator({ phone: true })
  phone?: string;              // "+7 (912) 345-67-89" — скобки/пробелы/дефисы допустимы

  @Validator({ type: "date" })
  bornAt?: Date | string;      // Date, ISO-строка или timestamp; Invalid Date — ошибка
}
```

### 4.4 Числа и boolean

```ts
class PaymentDto {
  @Validator({ required: true, range: [1, 1_000_000], integer: true })
  amountCents!: number;

  @Validator({ negative: true })
  correction?: number;

  @Validator({ required: true, mustBeTrue: true, message: "Подтвердите списание" })
  confirmed!: boolean;
}
```

`NaN` не проходит как число — будет ошибка `type` с `{actual}` = `NaN`.

### 4.5 Enum

```ts
enum Role { Admin = "admin", User = "user" }
enum Level { Low, High }       // числовой enum

class MemberDto {
  @Validator({ required: true, enumType: Role })
  role!: string;               // "root" -> ошибка: должно быть одним из: admin, user

  @Validator({ enumType: Level })
  level?: number;              // допустимы 0 и 1; строка "Low" — НЕ допустима
}
```

### 4.6 `custom`: пользовательские проверки

Функция получает значение поля **и весь экземпляр** — на этом строятся
перекрёстные проверки. Возвращаемое значение трактуется так:

| Вернула | Результат |
|---|---|
| `true` или ничего (`void`) | значение корректно |
| `false` | ошибка `custom` со стандартным сообщением |
| `string` | ошибка `custom` с этим сообщением (приоритетнее `message`) |
| `ValidationError` | добавляется в результат как есть (свой `code` и `property`) |
| брошено исключение | ошибка `customError` с текстом исключения; валидация продолжается |

```ts
class SignupDto {
  @Validator({
    required: true,
    min: 18,
    custom: (value, instance) => {
      const dto = instance as SignupDto;
      if ((value as number) < 21 && dto.guardianConsent !== true) {
        return "Для регистрации до 21 года необходимо согласие опекуна";
      }
      return true;
    },
  })
  age!: number;

  @Validator({ validateIf: (i) => (i as SignupDto).age < 21, required: true })
  guardianConsent?: boolean;
}
```

Полностью свой код ошибки — через `ValidationError`:

```ts
@Validator({
  custom: (value) =>
    RESERVED.has(value as string)
      ? new ValidationError("username", value, "Имя зарезервировано", "reserved")
      : true,
})
username!: string;
```

### 4.7 `validateIf`: условная валидация

Если функция вернула `false`, **все** правила этого декоратора пропускаются.
Удобно для полей, обязательных только в определённом состоянии объекта:

```ts
class DeliveryDto {
  @Validator({ required: true, enumType: DeliveryType })
  type!: string;

  // адрес обязателен только для курьерской доставки
  @Validator({ validateIf: (i) => (i as DeliveryDto).type === "courier", required: true, notEmpty: true })
  address?: string;
}
```

### 4.8 Несколько декораторов на одном поле

Выполняются все, ошибки суммируются. Это позволяет разделять правила
с разными сообщениями или условиями:

```ts
class LoginDto {
  @Validator({ minLength: 5, message: "Логин слишком короткий" })
  @Validator({ contains: "@corp", message: "Логин должен быть корпоративным" })
  login!: string;
}
```

### 4.9 Вложенные объекты и массивы (`nested`)

Значение поля проверяется рекурсивно как класс с собственными декораторами.
Ошибки приходят с полным путём: `address.city`, `items[1].name`.

```ts
class AddressDto {
  @Validator({ required: true, notEmpty: true })
  city!: string;

  @Validator({ pattern: /^\d{6}$/ })
  zip?: string;
}

class OrderDto {
  @Validator({ nested: true, required: true })
  address!: AddressDto;

  @Validator({ nested: true })
  deliveryPoints: AddressDto[] = [];   // массив — поэлементно
}

const result = Validator.validate(order);
result.getErrorsFor("address.city");        // ошибки вложенного поля
result.hasErrorsFor("deliveryPoints[1].zip");
```

Три режима:

- **`nested: true`** — рекурсия всегда (для элементов массива тоже);
- **не указан** — авто-режим: рекурсия включается, если на классе значения
  есть декораторы `@Validator`;
- **`nested: false`** — вложенная проверка для поля отключена.

Детали поведения:
- циклические ссылки (`a.next.next === a`) безопасно пропускаются;
- при нескольких декораторах на поле вложенная проверка выполняется один раз —
  ошибки не дублируются;
- глубина не ограничена, пути накапливаются: `a.b.c.d`.

### 4.10 Асинхронная валидация

`custom` может быть `async` (проверка занятости имени в БД, внешний API).
Такие проверки работают **только** через `validateAsync`:

```ts
class RegisterDto {
  @Validator({
    custom: async (value) => {
      const taken = await usersRepo.exists(value as string);
      return taken ? "Имя уже занято" : true;
    },
  })
  username!: string;
}

const result = await Validator.validateAsync(dto);
```

Правила выполнения:
- все синхронные правила выполняются сразу, асинхронные `custom` — после них,
  последовательно (детерминированный порядок ошибок);
- `reject`/исключение в async-функции — ошибка `customError`, не падение;
- async `custom` внутри вложенных объектов тоже дожидается;
- если async `custom` попал в **синхронный** `validate()` — поле не считается
  валидным молча: добавляется ошибка `asyncCustomInSyncCall`.

### 4.11 Подсказка `type` без других правил

Когда нужна только проверка типа:

```ts
class RawDto {
  @Validator({ type: "string" })  a: unknown;
  @Validator({ type: "number" })  b: unknown;   // NaN не проходит
  @Validator({ type: "boolean" }) c: unknown;
  @Validator({ type: "any" })     d: unknown;   // проверки типа нет
}
```

### 4.12 Наследование

Правила родительского класса работают в потомке; правила потомка
не «протекают» в родителя:

```ts
class BaseDto {
  @Validator({ required: true })
  id!: string;
}

class ChildDto extends BaseDto {
  @Validator({ min: 0 })
  extra!: number;
}

Validator.validate(new ChildDto());  // проверит и id, и extra
Validator.validate(new BaseDto());   // только id
```

---

## 5. Результат: `ValidationResult` и `ValidationError`

```ts
const result = Validator.validate(dto);

result.isValid;                       // boolean: ни одно правило не нарушено
result.errors;                        // readonly ValidationError[] — все ошибки разом
result.getErrorsFor("email");         // ошибки конкретного поля (или пустой массив)
result.getErrorsFor("address.city");  // для вложенных — полный путь
result.hasErrorsFor("age");           // boolean
```

`ValidationError`:

| Поле | Тип | Описание |
|---|---|---|
| `property` | `string` | имя поля; для вложенных — путь (`address.city`, `items[2].name`) |
| `value` | `unknown` | фактическое значение на момент проверки |
| `message` | `string` | готовое сообщение (плейсхолдеры уже подставлены) |
| `code` | `string?` | машиночитаемый код правила (`required`, `minLength`, ...) |

Индекс «поле → ошибки» строится лениво при первом `getErrorsFor`/`hasErrorsFor` —
валидный объект не платит за него аллокациями.

---

## 6. Сообщения об ошибках и плейсхолдеры

Приоритет шаблона: **локальный `message` декоратора > глобальный
(`setDefaultMessages`) > встроенный**. Строка из `custom` приоритетнее всех.

```ts
// Глобально (один раз при старте приложения):
Validator.setDefaultMessages({
  required: "Поле {property} обязательно для заполнения",
  minLength: "Минимальная длина {min} символов",
});

// Локально (для конкретного правила):
@Validator({ pattern: /^\d{6}$/, message: "Индекс — ровно 6 цифр, получено: {value}" })
zip!: string;

// Сброс к встроенным (полезно в тестах):
Validator.resetDefaultMessages();
```

Плейсхолдеры:

| Плейсхолдер | Подставляется в | Значение |
|---|---|---|
| `{property}` | все | имя/путь поля |
| `{value}` | все | текущее значение |
| `{min}` / `{max}` | `minLength`, `maxLength`, `length`, `min`, `max`, `range` | границы |
| `{pattern}` | `pattern` | источник регулярного выражения |
| `{contains}` | `contains`, `notContains` | искомая подстрока |
| `{allowed}` | `enum` | список допустимых значений через запятую |
| `{expected}` / `{actual}` | `type` | ожидаемый и фактический тип |
| `{error}` | `customError` | текст перехваченного исключения |

Неизвестные плейсхолдеры остаются в тексте как есть (без исключений).
`setDefaultMessages` принимает и собственные коды — можно задать шаблон для
кода из своей `ValidationError`.

---

## 7. Коды ошибок

| Код | Когда |
|---|---|
| `required` | значение `undefined`/`null` при `required: true` |
| `notEmpty`, `minLength`, `maxLength`, `length` | длина строки |
| `contains`, `notContains`, `pattern` | содержимое строки |
| `email`, `url`, `uuid`, `json`, `phone`, `date` | формат |
| `type` | значение неподходящего типа (в т.ч. `NaN` для числовых правил) |
| `min`, `max`, `range`, `positive`, `negative`, `integer` | числовые границы |
| `mustBeTrue`, `mustBeFalse` | boolean |
| `enum` | значение не входит в `enumType` |
| `custom` | `custom` вернула `false` или строку |
| `customError` | `custom` или `validateIf` бросила исключение |
| `asyncCustomInSyncCall` | async `custom` вызвана через синхронный `validate()` |

Константы доступны как `ValidationCodes.minLength` и т.д. — используйте их
вместо строковых литералов:

```ts
import { ValidationCodes } from "@/library/validation";

if (result.getErrorsFor("age").some((e) => e.code === ValidationCodes.min)) { ... }
```

---

## 8. Производительность и сборка в бинарник

- **План класса компилируется один раз.** При первом `validate` правила
  собираются из метаданных, `pattern`-строки компилируются в RegExp,
  значения enum складываются в `Set` (проверка членства за O(1)). Всё
  кэшируется в `WeakMap` по конструктору — классы не удерживаются от GC.
- **Горячий путь почти не аллоцирует.** Для валидного объекта создаются
  только массив ошибок (пустой) и `ValidationResult`. Объекты параметров
  сообщений создаются исключительно на пути ошибки.
- **Бинарник.** Никакой рефлексии, `eval` и динамических импортов; стандартные
  декораторы Bun выполняет нативно. Проверено:

```bash
bun build --compile src/examples/osnova/validation.ts --outfile bin/validation-demo
./bin/validation-demo
```

---

## 9. Безопасность и отказоустойчивость

- **Prototype pollution.** Движок читает только поля, объявленные декораторами
  (служебные ключи вроде `__proto__` не обходятся); при обходе переданных
  объектов (`enumType`, словарь сообщений) используется
  `Object.prototype.hasOwnProperty.call`.
- **Исключения в пользовательском коде.** `custom` и `validateIf` обёрнуты
  в try/catch: исключение становится ошибкой `customError`, остальные поля
  проверяются дальше.
- **Async в sync.** Promise из `custom` в синхронном `validate()` — явная
  ошибка `asyncCustomInSyncCall`, а не тихо «валидно».
- **Циклы в графе объектов** при `nested` не зацикливают валидацию.
- **Никаких `eval`** и динамической компиляции; `pattern: string` — это
  обычный конструктор `RegExp`.
- **Длина до содержимого.** Превышение `maxLength`/верхнего `length` не запускает
  regex и форматные парсеры того же декоратора. Встроенный `email` работает
  линейными проходами без перебора вариантов; допустимая грамматика сохранена.
  Пользовательские `pattern`, `custom` и `validateIf` остаются ответственностью
  автора правил: верхняя граница не доказывает безопасность произвольного regex.
- Декоратор на статическом или приватном (`#x`) поле — немедленное исключение
  при объявлении класса (fail-fast), такие поля не поддерживаются.

---

## 10. Ограничения и анти-паттерны

**Нет `Reflect.getMetadata("design:type")` — это осознанно.** Автоматический
вывод типа поля требует `emitDecoratorMetadata` и внешний пакет
`reflect-metadata`, что нарушает принципы фреймворка (без зависимостей,
без рефлексии, бинарник). Тип выводится из правил или задаётся `type`.

**Анти-паттерны:**

```ts
// ПЛОХО: тяжёлая логика в validateIf — она выполняется при каждой валидации
@Validator({ validateIf: (i) => expensiveComputation(i), required: true })

// ПЛОХО: запрос к БД в синхронном custom — вернётся Promise,
// поле получит ошибку asyncCustomInSyncCall
@Validator({ custom: (v) => usersRepo.exists(v) })  // используйте validateAsync

// ПЛОХО: мутировать экземпляр внутри custom — валидация должна быть чистой
@Validator({ custom: (v, i) => { (i as Dto).normalized = v.trim(); return true; } })

// ПЛОХО: один гигантский custom вместо встроенных правил —
// теряются коды ошибок и кастомизация сообщений
@Validator({ custom: (v) => typeof v === "string" && v.length >= 3 && v.includes("@") })
// ХОРОШО:
@Validator({ minLength: 3, contains: "@" })
```

**Что модуль не делает:**
- не трансформирует значения (trim, приведение типов) — только проверяет;
- не валидирует приватные (`#field`) и статические поля;
- не ограничивает глубину вложенности (циклы при этом безопасны).

Карта файлов модуля — в [README.md](README.md). Запускаемая демонстрация всех
сценариев: `bun src/examples/osnova/validation.ts`.

Регрессии ограничения строк и совместимости email:
[test/validation.string-limits.test.ts](test/validation.string-limits.test.ts).
Проверка HTTP 400 и ограничения запросов до binding:
[validation-admission.test.ts](../../core/http/test/validation-admission.test.ts).
