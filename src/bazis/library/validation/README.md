# src/bazis/library/validation: class validation module

A self-contained OOP-style validation module: one `@Validator(options)` decorator
on class fields + the static `Validator.validate` / `Validator.validateAsync`.

The full specification (every scenario with examples, the options, error codes,
placeholders) is in [SPEC.md](SPEC.md).

Principles (shared by the whole framework):

- no external dependencies, only Bun APIs;
- no reflection: standard TC39 decorators + `Symbol.metadata`
  (no `experimentalDecorators`, `emitDecoratorMetadata` or `reflect-metadata`);
- compatible with `bun build --compile`;
- few allocations: a class's validation plan is compiled once and cached in a
  WeakMap, message objects are created only on the error path;
- resilience: exceptions in `custom`/`validateIf` are caught
  (code `customError`), and validation continues and collects all errors.

## Quick start

```ts
import { Validator } from "@/library/validation";

class CreateUserDto {
  @Validator({ required: true, minLength: 3, maxLength: 50 })
  username!: string;

  @Validator({ required: true, email: true })
  email!: string;
}

const result = Validator.validate(dto);      // ValidationResult
await Validator.validateAsync(dto);           // awaits async custom functions
Validator.setDefaultMessages({ required: "{property} is required" });
```

More scenarios (complex conditions, async, nested objects) are in
[test/validation.test.ts](test/validation.test.ts).

## Folder map

| File | Purpose |
|---|---|
| `Validator.ts` | public facade: the decorator + `validate`/`validateAsync`/`setDefaultMessages` |
| `ValidationError.ts` | one error: `property`, `value`, `message`, `code` |
| `ValidationResult.ts` | the outcome: `isValid`, `errors`, `getErrorsFor`, `hasErrorsFor` |
| `RuleEngine.ts` | the engine: one pass over the plan, sync/async, nested, cycle protection |
| `RuleCompiler.ts` | compiles class rules into a plan + WeakMap cache (RegExp, enum Set) |
| `MessageRegistry.ts` | message templates, placeholders, priority local > global > built-in; built-in texts are English, `RU_VALIDATION_MESSAGES` is a Russian set for `setDefaults` |
| `metadata.ts` | stores rules through `context.metadata` / `Symbol.metadata` |
| `types/ValidatorOptions.ts` | all decorator options |
| `types/ValidationCode.ts` | error codes |
| `test/validation.test.ts` | module tests |

## A note on `design:type`

`Reflect.getMetadata("design:type")` is deliberately not used: it requires
`emitDecoratorMetadata` and the external `reflect-metadata` package, which breaks
the "no dependencies, no reflection" principles. Instead the expected type is
inferred from the rules themselves (`minLength` ⇒ string, `min` ⇒ number,
`mustBeTrue` ⇒ boolean) or set with an explicit `type` hint.
