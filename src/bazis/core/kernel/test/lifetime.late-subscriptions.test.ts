import { expect, test } from "bun:test";
import { ApplicationLifetime } from "../ApplicationLifetime";

// A subscription made after its moment has passed runs right away. Before, a
// service first created by a request subscribed to onStarted and was never called.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("onStarted after the start runs right away", async () => {
  const lifetime = new ApplicationLifetime();
  const calls: string[] = [];
  lifetime.onStarted(() => { calls.push("early"); });
  await lifetime.notifyStarted();
  lifetime.onStarted(() => { calls.push("late"); });
  await tick();
  expect(calls).toEqual(["early", "late"]);
});

test("onStopping and onStopped after their moment run right away", async () => {
  const lifetime = new ApplicationLifetime();
  const calls: string[] = [];
  await lifetime.notifyStarted();
  await lifetime.notifyStopping();
  lifetime.onStopping(() => { calls.push("stopping"); });
  await lifetime.notifyStopped();
  lifetime.onStopped(() => { calls.push("stopped"); });
  await tick();
  expect(calls).toEqual(["stopping", "stopped"]);
});

test("subscriptions made in time still wait for their moment, once", async () => {
  const lifetime = new ApplicationLifetime();
  const calls: string[] = [];
  lifetime.onStarted(() => { calls.push("started"); });
  lifetime.onStopping(() => { calls.push("stopping"); });
  await tick();
  expect(calls).toEqual([]);
  await lifetime.notifyStarted();
  await lifetime.notifyStopping();
  await tick();
  expect(calls).toEqual(["started", "stopping"]);
});
