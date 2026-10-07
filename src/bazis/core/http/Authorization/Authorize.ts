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
 * Protects a controller or a single action: the route gets the
 * {@link AuthorizeCheck} function. The HTTP kernel does not know *what* it
 * checks: JWT, login/password, Telegram sign-in and so on. Several checks
 * can be passed; all of them must pass. On a method of a protected controller
 * the checks are added to the controller's ones: the class checks run first.
 *
 * ```ts
 * @Authorize(requireTokenKind(TokenKind.Admin))   // access token kind
 * @Authorize(loginMatches)                         // login/password matched
 * @Authorize(telegramVerified)                     // Telegram sign-in
 * ```
 *
 * Check result semantics, see {@link AuthorizeCheck}: `false` → 403,
 * `throw` → the status of the thrown `HttpError`.
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

/** Public route: on a method, removes every check, including the controller's `@Authorize`. */
export function AllowAnonymous(): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      setControllerAllowAnonymous(context.metadata);
      return;
    }
    setActionAllowAnonymous(context.metadata, context.name);
  };
}
