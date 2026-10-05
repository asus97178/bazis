import { expect, test } from "bun:test";
import { DbUpdateError, OrmError, UniqueViolationError } from "../index";
import { isConfirmedCommitRejection, isConfirmedStatementRejection } from "../Providers/transactionOutcome";

function driverError(errno: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), { errno, code: "ERR_POSTGRES_SERVER_ERROR", ...extra });
}

test("SQLSTATE 23505 becomes UniqueViolationError with constraint, table and cause", () => {
  const cause = driverError("23505", { constraint: "ix_projects_name", table: "projects" });
  const error = UniqueViolationError.from(cause);
  expect(error).toBeInstanceOf(UniqueViolationError);
  expect(error).toBeInstanceOf(DbUpdateError);
  const unique = error as UniqueViolationError;
  expect(unique.constraint).toBe("ix_projects_name");
  expect(unique.table).toBe("projects");
  expect(unique.cause).toBe(cause);
  expect(unique.message).toBe('Unique constraint "ix_projects_name" violated.');
});

test("wrapping keeps the server rejection visible to transaction-outcome checks", () => {
  const cause = driverError("23505");
  const error = UniqueViolationError.from(cause);
  expect(isConfirmedStatementRejection(error)).toBe(isConfirmedStatementRejection(cause));
  expect(isConfirmedCommitRejection(error)).toBe(isConfirmedCommitRejection(cause));
  expect(isConfirmedStatementRejection(error)).toBe(true);
});

test("other errors pass through unchanged", () => {
  const check = driverError("23514");
  const orm = new OrmError("already mapped");
  const inherited = Object.create({ errno: "23505" }) as object;
  expect(UniqueViolationError.from(check)).toBe(check);
  expect(UniqueViolationError.from(orm)).toBe(orm);
  expect(UniqueViolationError.from(inherited)).toBe(inherited);
  expect(UniqueViolationError.from("text")).toBe("text");
  expect((UniqueViolationError.from(driverError("23505")) as UniqueViolationError).constraint).toBeUndefined();
});
