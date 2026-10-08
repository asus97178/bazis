import { afterEach, expect, test } from "bun:test";
import { ConsoleLogger, runWithRequestContext } from "../index";

// Inside a request (createCorrelationIdMiddleware binds the context), every
// application log line carries the request id. Before, only the access log
// and the HTTP error lines had it.
const original = { info: console.info, error: console.error };
const lines: string[] = [];
console.info = (line: string) => { lines.push(line); };
console.error = (line: string) => { lines.push(line); };
afterEach(() => { lines.length = 0; });
process.on("exit", () => { console.info = original.info; console.error = original.error; });

test("a line written inside a request gets its requestId", () => {
  runWithRequestContext({ requestId: "req-7" }, () => new ConsoleLogger().info("payment accepted", { amount: 50 }));
  expect(lines).toEqual(['info: payment accepted {"amount":50,"requestId":"req-7"}']);
});

test("a line without fields gets them too, and traceparent comes along", () => {
  const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  runWithRequestContext({ requestId: "req-8", traceparent }, () => new ConsoleLogger().error("failed"));
  expect(lines).toEqual([`error: failed {"requestId":"req-8","traceparent":"${traceparent}"}`]);
});

test("an explicit requestId wins, and outside a request nothing is added", () => {
  runWithRequestContext({ requestId: "req-9" }, () => new ConsoleLogger().info("access", { requestId: "explicit" }));
  new ConsoleLogger().info("background work", { jobs: 2 });
  expect(lines).toEqual(['info: access {"requestId":"explicit"}', 'info: background work {"jobs":2}']);
});

test("requestContext: false turns it off", () => {
  runWithRequestContext({ requestId: "req-10" }, () => new ConsoleLogger({ requestContext: false }).info("plain"));
  expect(lines).toEqual(["info: plain"]);
});
