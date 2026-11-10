import { ConflictError, HttpError } from "../http/Errors/HttpError";
import { englishHttpMessage, STATUS_MESSAGE_KEYS } from "../http/Errors/messages";
import { UniqueViolationError } from "../../library/orm";
import { databaseErrorStatus } from "./databaseErrorStatus";

/**
 * A database error as the HTTP answer for it: the statuses of
 * {@link databaseErrorStatus}, and for a unique violation the text of
 * `@Index({ conflict })` with the properties of the index in the details:
 * `{ error, details: { code: "unique", fields: ["name"] } }`. The ORM registers
 * it for every application with HTTP; the message never carries values of the row.
 */
export function databaseHttpError(error: unknown): HttpError | undefined {
  if (error instanceof UniqueViolationError) {
    return new ConflictError(error.conflict, { code: "unique", fields: [...error.properties] });
  }
  const status = databaseErrorStatus(error);
  if (status === undefined) return undefined;
  const key = STATUS_MESSAGE_KEYS[status] ?? (status >= 500 ? "serverError" : "clientError");
  return new HttpError(status, englishHttpMessage(key), undefined, { key });
}
