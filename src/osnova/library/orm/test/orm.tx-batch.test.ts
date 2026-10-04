import { expect, test } from "bun:test";
import { ExecutionStrategy, PostCommitError, isCommittedOutcome } from "../index";
import { registerPostCommitFinalizer, runPostCommitCallbacks } from "../Providers/transactionCallbacks";

test("committed outcome detection preserves the marker without invoking hostile accessors", async () => {
  const committed = new PostCommitError([new Error("callback failed")]);
  expect(isCommittedOutcome(committed)).toBe(true);
  let getterReads = 0;
  const transient = Object.defineProperty(new Error("transient"), "committed", { get() { getterReads += 1; throw new Error("getter must not run"); } });
  const strategy = new ExecutionStrategy({ maxRetries: 1, baseDelayMs: 1, isTransient: () => true });
  await expect(strategy.execute(async () => { throw transient; })).rejects.toBe(transient);
  expect(getterReads).toBe(0);
});

test("commit finalizers and public callbacks all run after earlier callback failures", async () => {
  const calls: string[] = [];
  const finalizeFirst = () => { calls.push("finalize first"); throw undefined; };
  const finalizeSecond = () => { calls.push("finalize second"); };
  registerPostCommitFinalizer(finalizeFirst); registerPostCommitFinalizer(finalizeSecond);
  const firstError = new Error("public callback failed");
  const work = runPostCommitCallbacks([
    () => { calls.push("public first"); throw firstError; },
    finalizeFirst,
    () => { calls.push("public second"); },
    finalizeSecond,
  ]);
  let failure: unknown;
  try { await work; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PostCommitError);
  expect((failure as PostCommitError).errors).toEqual([undefined, firstError]);
  expect(calls).toEqual(["finalize first", "finalize second", "public first", "public second"]);
});
