import {
  setActionAllowAnonymous,
  setActionAuthorize,
  setControllerAllowAnonymous,
  setControllerAuthorize,
  type AuthorizeCheck,
} from "./metadata";

type AnyClass = abstract new (...args: never[]) => unknown;
type AnyMethod = (...args: never[]) => unknown;
type ClassOrMethodDecorator = (
  value: AnyClass | AnyMethod,
  context: ClassDecoratorContext | ClassMethodDecoratorContext,
) => void;

/**
 * Защищает контроллер или отдельное действие: к маршруту применяется
 * функция-проверка {@link AuthorizeCheck}. HTTP-ядро не знает, *что* она
 * проверяет — JWT, логин/пароль, вход через Telegram и т. п. Можно передать
 * несколько проверок — пройти должны все.
 *
 * ```ts
 * @Authorize(requireTokenKind(TokenKind.Admin))   // вид access-токена
 * @Authorize(loginMatches)                         // логин/пароль совпали
 * @Authorize(telegramVerified)                     // вход через Telegram
 * ```
 *
 * Семантика результата проверки — см. {@link AuthorizeCheck}: `false` → 403,
 * `throw` → статус из брошенного `HttpError`.
 */
export function Authorize(check: AuthorizeCheck, ...rest: AuthorizeCheck[]): ClassOrMethodDecorator {
  const checks = [check, ...rest];

  return (_value, context) => {
    if (context.kind === "class") {
      setControllerAuthorize(context.metadata, { checks });
      return;
    }
    setActionAuthorize(context.metadata, context.name, { checks });
  };
}

/** Публичный маршрут: перекрывает `@Authorize`, объявленный на контроллере. */
export function AllowAnonymous(): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      setControllerAllowAnonymous(context.metadata);
      return;
    }
    setActionAllowAnonymous(context.metadata, context.name);
  };
}
