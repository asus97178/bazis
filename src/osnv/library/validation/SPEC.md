# osnv validation module: specification

Declarative class validation: one `@Validator(options)` decorator on fields and the
static methods `Validator.validate` / `Validator.validateAsync`.

Quick navigation:
- [1. What it is and why](#1-what-it-is-and-why)
- [2. Quick start](#2-quick-start)
- [3. Decorator options reference](#3-decorator-options-reference)
- [4. Usage scenarios](#4-usage-scenarios)
- [5. Result: `ValidationResult` and `ValidationError`](#5-result-validationresult-and-validationerror)
- [6. Error messages and placeholders](#6-error-messages-and-placeholders)
- [7. Error codes](#7-error-codes)
- [8. Performance and binary build](#8-performance-and-binary-build)
- [9. Security and resilience](#9-security-and-resilience)
- [10. Limits and anti-patterns](#10-limits-and-anti-patterns)

---

## 1. What it is and why

The module solves one task: **check that an object (usually a DTO at the system
boundary: an HTTP request body, a queue message, a config) follows the rules**, and
return the full list of violations.

Why an own module instead of class-validator:

- **No external dependencies**: only Bun APIs, nothing is pulled into the binary.
- **No reflection**: no `emitDecoratorMetadata` / `reflect-metadata`.
  Rules are stored through standard TC39 decorators and `Symbol.metadata`, which Bun
  runs natively. So the module compiles freely with `bun build --compile`.
- **One pass, errors of all fields.** Validation does not stop at the first error.
  After a string exceeds its upper length bound, the content checks of the same
  decorator are skipped; the length error stays in the result.
- **Resilience.** An exception in a user function does not crash validation: it becomes
  a regular error with the `customError` code.
- **OOP style.** Rules live next to the class fields, the engine behind the
  `Validator` facade.

The whole public API is imported from one place:

```ts
import { Validator, ValidationError, ValidationResult, ValidationCodes } from "@/library/validation";
```

---

## 2. Quick start

```ts
import { Validator } from "osnv/library/validation";

class CreateUserDto {
  @Validator({ required: true, minLength: 3, maxLength: 50 })
  username!: string;

  @Validator({ required: true, email: true })
  email!: string;

  @Validator({ required: true, min: 18, integer: true })
  age!: number;
}

const dto = new CreateUserDto();
dto.username = "ab";            // shorter than 3
dto.age = 17.5;                 // below 18 and not an integer

const result = Validator.validate(dto);

result.isValid;                  // false
result.errors.length;            // 4 (minLength, required email, min, integer)
result.hasErrorsFor("email");    // true
result.getErrorsFor("age")[0].message;
// 'Field "age" must be at least 18'
```

Class rules are collected and compiled **once** on the first `validate` call (cached in
a WeakMap); repeated checks rebuild nothing.

---

## 3. Decorator options reference

One `@Validator({...})` is one rule set. A field may have several decorators; all of them run.

### General

| Option | Type | What it does |
|---|---|---|
| `required` | `boolean` | `undefined`/`null` is a `required` error. Without it a missing value skips all checks |
| `type` | `"string" \| "number" \| "boolean" \| "enum" \| "json" \| "phone" \| "email" \| "date" \| "any"` | a type hint; a mismatch is a `type` error. Optional: the type is also inferred from the rules (`minLength` ⇒ string, `min` ⇒ number) |
| `validateIf` | `(instance) => boolean` | returned `false`: all other rules **of this decorator** are skipped |
| `custom` | `(value, instance) => boolean \| string \| void \| ValidationError \| Promise<...>` | a user check, see [4.6](#46-custom-user-checks) |
| `message` | `string` | a local message template for all rules of the decorator; wins over the global ones |
| `nested` | `boolean` | recursive check of the value; turns on automatically when not set, `false` turns it off, see [4.9](#49-nested-objects-and-arrays-nested) |

### Strings

Any of these rules requires the value to be a string (otherwise one `type` error).

| Option | Type | Error when |
|---|---|---|
| `notEmpty` | `boolean` | the string is empty `""` |
| `minLength` / `maxLength` | `number` | the length is below/above the given one |
| `length` | `[number, number]` | the length is outside the range (inclusive) |
| `contains` / `notContains` | `string` | the substring is missing / present |
| `pattern` | `RegExp \| string` | the string does not match (a source string is compiled once) |
| `email` | `boolean` | not an email address |
| `url` | `boolean` | not a URL (checked with `URL.canParse`) |
| `uuid` | `boolean` | not a UUID of versions 1–8 (the nil UUID is allowed, case does not matter) |
| `json` | `boolean` | does not parse with `JSON.parse` |
| `phone` | `boolean` | not a phone number: an optional `+`, 7–15 digits; spaces, hyphens and parentheses are ignored |

`maxLength` and the upper bound of `length` limit the input of the later content checks
**of the same decorator**: `contains`, `notContains`, `pattern`, `email`, `url`, `uuid`,
`json`, `phone`. When exceeded, the length errors stay and the listed checks do not run.
The lower length bound, the other fields/decorators and `custom` keep their behavior.
For an untrusted `pattern`, set the upper bound in the same decorator; a separate
limiting decorator does not change the neighboring rules.

### Numbers

They require `typeof value === "number"` and not `NaN` (otherwise a `type` error).

| Option | Type | Error when |
|---|---|---|
| `min` / `max` | `number` | below/above the bound |
| `range` | `[number, number]` | outside the range (inclusive) |
| `positive` / `negative` | `boolean` | the value is `<= 0` / `>= 0` |
| `integer` | `boolean` | not an integer |

### Boolean

| Option | Error when |
|---|---|
| `mustBeTrue` | the value is not `true` (the typical case is accepting terms) |
| `mustBeFalse` | the value is not `false` |

### Enum

| Option | Type | What it does |
|---|---|---|
| `enumType` | `object` (a TypeScript enum) | the value must be one of the enum values; reverse keys of numeric enums are ignored |

---

## 4. Usage scenarios

### 4.1 Required and optional fields

`required` checks only `undefined` and `null`. Everything else is a separate rule (an
empty string is `notEmpty`, not `required`).

```ts
class Dto {
  @Validator({ required: true })
  id!: string;                 // no value -> required error

  @Validator({ minLength: 3 })
  comment?: string;            // no value -> valid; a value -> its length is checked
}
```

### 4.2 Strings

```ts
class ArticleDto {
  @Validator({ required: true, length: [5, 120], notContains: "<script" })
  title!: string;

  @Validator({ pattern: /^[a-z0-9-]+$/, message: "Slug: only lowercase letters, digits and hyphens" })
  slug!: string;

  @Validator({ contains: "@example.com" })
  authorEmail!: string;
}
```

`pattern` also accepts a source string: `@Validator({ pattern: "^\\d{4}$" })`.

### 4.3 Formats: email, url, uuid, json, phone, date

```ts
class ContactDto {
  @Validator({ email: true })
  email?: string;              // user@example.com

  @Validator({ url: true })
  site?: string;               // https://bun.sh/docs

  @Validator({ uuid: true })
  id?: string;                 // v4 (crypto.randomUUID) and v7 (Bun.randomUUIDv7)

  @Validator({ json: true })
  payload?: string;            // '{"a":1}'

  @Validator({ phone: true })
  phone?: string;              // "+1 (912) 345-67-89": parentheses/spaces/hyphens are allowed

  @Validator({ type: "date" })
  bornAt?: Date | string;      // a Date, an ISO string or a timestamp; Invalid Date is an error
}
```

### 4.4 Numbers and boolean

```ts
class PaymentDto {
  @Validator({ required: true, range: [1, 1_000_000], integer: true })
  amountCents!: number;

  @Validator({ negative: true })
  correction?: number;

  @Validator({ required: true, mustBeTrue: true, message: "Confirm the charge" })
  confirmed!: boolean;
}
```

`NaN` does not pass as a number: it gives a `type` error with `{actual}` = `NaN`.

### 4.5 Enum

```ts
enum Role { Admin = "admin", User = "user" }
enum Level { Low, High }       // a numeric enum

class MemberDto {
  @Validator({ required: true, enumType: Role })
  role!: string;               // "root" -> error: must be one of: admin, user

  @Validator({ enumType: Level })
  level?: number;              // 0 and 1 are allowed; the string "Low" is NOT allowed
}
```

### 4.6 `custom`: user checks

The function gets the field value **and the whole instance**; cross-field checks are
built on this. The return value is interpreted like this:

| Returned | Result |
|---|---|
| `true` or nothing (`void`) | the value is valid |
| `false` | a `custom` error with the standard message |
| `string` | a `custom` error with this message (wins over `message`) |
| `ValidationError` | added to the result as is (its own `code` and `property`) |
| an exception thrown | a `customError` error with the exception text; validation continues |

```ts
class SignupDto {
  @Validator({
    required: true,
    min: 18,
    custom: (value, instance) => {
      const dto = instance as SignupDto;
      if ((value as number) < 21 && dto.guardianConsent !== true) {
        return "Registration under 21 requires guardian consent";
      }
      return true;
    },
  })
  age!: number;

  @Validator({ validateIf: (i) => (i as SignupDto).age < 21, required: true })
  guardianConsent?: boolean;
}
```

A fully custom error code goes through `ValidationError`:

```ts
@Validator({
  custom: (value) =>
    RESERVED.has(value as string)
      ? new ValidationError("username", value, "This name is reserved", "reserved")
      : true,
})
username!: string;
```

### 4.7 `validateIf`: conditional validation

If the function returns `false`, **all** rules of this decorator are skipped.
Handy for fields that are required only in a certain object state:

```ts
class DeliveryDto {
  @Validator({ required: true, enumType: DeliveryType })
  type!: string;

  // the address is required only for courier delivery
  @Validator({ validateIf: (i) => (i as DeliveryDto).type === "courier", required: true, notEmpty: true })
  address?: string;
}
```

### 4.8 Several decorators on one field

All of them run and their errors add up. This lets you split rules with different
messages or conditions:

```ts
class LoginDto {
  @Validator({ minLength: 5, message: "The login is too short" })
  @Validator({ contains: "@corp", message: "The login must be a corporate one" })
  login!: string;
}
```

### 4.9 Nested objects and arrays (`nested`)

The field value is checked recursively as a class with its own decorators.
Errors come with the full path: `address.city`, `items[1].name`.

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
  deliveryPoints: AddressDto[] = [];   // an array is checked element by element
}

const result = Validator.validate(order);
result.getErrorsFor("address.city");        // errors of the nested field
result.hasErrorsFor("deliveryPoints[1].zip");
```

Three modes:

- **`nested: true`**: always recurse (for array elements too);
- **not set**: auto mode: recursion turns on if the value's class has `@Validator`
  decorators;
- **`nested: false`**: nested checking is off for the field.

Behavior details:
- circular references (`a.next.next === a`) are skipped safely;
- with several decorators on a field the nested check runs once, so errors are not
  duplicated;
- depth is not limited, paths accumulate: `a.b.c.d`.

### 4.10 Asynchronous validation

`custom` may be `async` (checking whether a name is taken in the database, an external
API). Such checks work **only** through `validateAsync`:

```ts
class RegisterDto {
  @Validator({
    custom: async (value) => {
      const taken = await usersRepo.exists(value as string);
      return taken ? "The name is taken" : true;
    },
  })
  username!: string;
}

const result = await Validator.validateAsync(dto);
```

Execution rules:
- all synchronous rules run at once, async `custom` checks run after them, sequentially
  (a deterministic error order);
- a `reject`/exception in an async function is a `customError` error, not a crash;
- async `custom` inside nested objects is awaited too;
- if an async `custom` ends up in the **synchronous** `validate()`, the field is not
  silently treated as valid: an `asyncCustomInSyncCall` error is added.

### 4.11 The `type` hint without other rules

When only a type check is needed:

```ts
class RawDto {
  @Validator({ type: "string" })  a: unknown;
  @Validator({ type: "number" })  b: unknown;   // NaN does not pass
  @Validator({ type: "boolean" }) c: unknown;
  @Validator({ type: "any" })     d: unknown;   // no type check
}
```

### 4.12 Inheritance

Parent class rules work in a subclass; subclass rules do not leak into the parent:

```ts
class BaseDto {
  @Validator({ required: true })
  id!: string;
}

class ChildDto extends BaseDto {
  @Validator({ min: 0 })
  extra!: number;
}

Validator.validate(new ChildDto());  // checks both id and extra
Validator.validate(new BaseDto());   // only id
```

---

## 5. Result: `ValidationResult` and `ValidationError`

```ts
const result = Validator.validate(dto);

result.isValid;                       // boolean: no rule is violated
result.errors;                        // readonly ValidationError[]: all errors at once
result.getErrorsFor("email");         // errors of a specific field (or an empty array)
result.getErrorsFor("address.city");  // the full path for nested fields
result.hasErrorsFor("age");           // boolean
```

`ValidationError`:

| Field | Type | Description |
|---|---|---|
| `property` | `string` | the field name; for nested fields the path (`address.city`, `items[2].name`) |
| `value` | `unknown` | the actual value at check time |
| `message` | `string` | the ready message (placeholders already substituted) |
| `code` | `string?` | the machine-readable rule code (`required`, `minLength`, ...) |

The "field → errors" index is built lazily on the first `getErrorsFor`/`hasErrorsFor`,
so a valid object pays no allocations for it.

---

## 6. Error messages and placeholders

Template priority: **the decorator's local `message` > global (`setDefaultMessages`) >
built-in**. A string returned from `custom` wins over all of them.
Built-in messages are English; `RU_VALIDATION_MESSAGES` is a Russian set for `setDefaultMessages`.

```ts
// Globally (once at application start):
Validator.setDefaultMessages({
  required: "{property} is required",
  minLength: "At least {min} characters",
});

// Locally (for a specific rule):
@Validator({ pattern: /^\d{6}$/, message: "A ZIP code is exactly 6 digits, got: {value}" })
zip!: string;

// Reset to the built-in ones (handy in tests):
Validator.resetDefaultMessages();
```

Placeholders:

| Placeholder | Substituted in | Value |
|---|---|---|
| `{property}` | all | the field name/path |
| `{value}` | all | the current value |
| `{min}` / `{max}` | `minLength`, `maxLength`, `length`, `min`, `max`, `range` | the bounds |
| `{pattern}` | `pattern` | the regular expression source |
| `{contains}` | `contains`, `notContains` | the substring looked for |
| `{allowed}` | `enum` | a comma-separated list of allowed values |
| `{expected}` / `{actual}` | `type` | the expected and actual type |
| `{error}` | `customError` | the text of the caught exception |

Unknown placeholders stay in the text as is (no exceptions).
`setDefaultMessages` also accepts your own codes, so you can set a template for a code
from your own `ValidationError`.

---

## 7. Error codes

| Code | When |
|---|---|
| `required` | the value is `undefined`/`null` with `required: true` |
| `notEmpty`, `minLength`, `maxLength`, `length` | the string length |
| `contains`, `notContains`, `pattern` | the string content |
| `email`, `url`, `uuid`, `json`, `phone`, `date` | the format |
| `type` | the value has the wrong type (including `NaN` for number rules) |
| `min`, `max`, `range`, `positive`, `negative`, `integer` | numeric bounds |
| `mustBeTrue`, `mustBeFalse` | boolean |
| `enum` | the value is not in `enumType` |
| `custom` | `custom` returned `false` or a string |
| `customError` | `custom` or `validateIf` threw an exception |
| `asyncCustomInSyncCall` | an async `custom` was called through the synchronous `validate()` |

The constants are available as `ValidationCodes.minLength` and so on; use them instead
of string literals:

```ts
import { ValidationCodes } from "@/library/validation";

if (result.getErrorsFor("age").some((e) => e.code === ValidationCodes.min)) { ... }
```

---

## 8. Performance and binary build

- **The class plan is compiled once.** On the first `validate` the rules are collected
  from the metadata, `pattern` strings are compiled into RegExp, and enum values go into
  a `Set` (O(1) membership checks). Everything is cached in a `WeakMap` by constructor,
  so classes are not kept from GC.
- **The hot path barely allocates.** For a valid object only the (empty) error array
  and the `ValidationResult` are created. Message parameter objects are created only
  on the error path.
- **Binary.** No reflection, `eval` or dynamic imports; Bun runs the standard decorators
  natively. The framework CI (`run ci`) compiles binaries that use this module.

---

## 9. Security and resilience

- **Prototype pollution.** The engine reads only the fields declared by decorators
  (service keys like `__proto__` are never traversed); walking passed objects
  (`enumType`, the message dictionary) uses `Object.prototype.hasOwnProperty.call`.
- **Exceptions in user code.** `custom` and `validateIf` are wrapped in try/catch: an
  exception becomes a `customError` error, and the other fields are still checked.
- **Async in sync.** A Promise from `custom` in the synchronous `validate()` is an
  explicit `asyncCustomInSyncCall` error, not a silent "valid".
- **Cycles in the object graph** with `nested` do not loop the validation.
- **No `eval`** and no dynamic compilation; `pattern: string` is the regular `RegExp`
  constructor.
- **Length before content.** Exceeding `maxLength`/the upper `length` does not run the
  regex and format parsers of the same decorator. The built-in `email` works with linear
  passes without backtracking; the accepted grammar is unchanged.
  User `pattern`, `custom` and `validateIf` stay the responsibility of the rule author:
  an upper bound does not prove an arbitrary regex is safe.
- A decorator on a static or private (`#x`) field throws immediately when the class is
  declared (fail-fast); such fields are not supported.

---

## 10. Limits and anti-patterns

**There is no `Reflect.getMetadata("design:type")`, on purpose.** Inferring the field
type automatically needs `emitDecoratorMetadata` and the external `reflect-metadata`
package, which breaks the framework principles (no dependencies, no reflection,
binary). The type is inferred from the rules or set with `type`.

**Anti-patterns:**

```ts
// BAD: heavy logic in validateIf: it runs on every validation
@Validator({ validateIf: (i) => expensiveComputation(i), required: true })

// BAD: a database query in a synchronous custom returns a Promise,
// and the field gets an asyncCustomInSyncCall error
@Validator({ custom: (v) => usersRepo.exists(v) })  // use validateAsync

// BAD: mutating the instance inside custom: validation must be pure
@Validator({ custom: (v, i) => { (i as Dto).normalized = v.trim(); return true; } })

// BAD: one giant custom instead of the built-in rules
// loses the error codes and message customization
@Validator({ custom: (v) => typeof v === "string" && v.length >= 3 && v.includes("@") })
// GOOD:
@Validator({ minLength: 3, contains: "@" })
```

**What the module does not do:**
- it does not transform values (trim, type conversion), it only checks;
- it does not validate private (`#field`) and static fields;
- it does not limit nesting depth (cycles are still safe).

The module file map is in [README.md](README.md). Scenarios with real assertions are in
[test/validation.test.ts](test/validation.test.ts).

Regressions of string limits and email compatibility:
[test/validation.string-limits.test.ts](test/validation.string-limits.test.ts).
The HTTP 400 check and rate limiting before binding:
[validation-admission.test.ts](../../core/http/test/validation-admission.test.ts).
