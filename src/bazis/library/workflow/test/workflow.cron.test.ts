import { expect, test } from "bun:test";
import { isTimeZone, parseCron, validateProcess, type ProcessDocument } from "@/library/workflow";

const next = (cron: string, after: string, zone?: string) => parseCron(cron, zone)!.next(new Date(after))?.toISOString();

test("the fields are read on the clocks of the zone", () => {
  expect(next("0 9 * * *", "2026-11-02T00:00:00Z", "Europe/Moscow")).toBe("2026-11-02T06:00:00.000Z");
  expect(next("0 9 * * *", "2026-11-02T06:00:00Z", "Europe/Moscow")).toBe("2026-11-03T06:00:00.000Z");
  expect(next("0 9 * * *", "2026-11-02T00:00:00Z")).toBe("2026-11-02T09:00:00.000Z");
  // A weekday and a date belong to the zone too: it is Monday in Tokyo while Sunday in UTC.
  expect(next("30 0 * * 1", "2026-11-01T00:00:00Z", "Asia/Tokyo")).toBe("2026-11-01T15:30:00.000Z");
  expect(parseCron("0 9 * * *", "Europe/Moscow")!.matches(new Date("2026-11-02T06:00:00Z"))).toBe(true);
  expect(parseCron("0 9 * * *", "Europe/Moscow")!.matches(new Date("2026-11-02T09:00:00Z"))).toBe(false);
});

test("a time the clocks skip fires right after the change, once", () => {
  // New York went from 02:00 to 03:00 on 2026-03-08 at 07:00Z.
  const zone = "America/New_York";
  expect(next("30 2 * * *", "2026-03-07T12:00:00Z", zone)).toBe("2026-03-08T07:00:00.000Z");
  expect(next("30 2 * * *", "2026-03-08T07:00:00Z", zone)).toBe("2026-03-09T06:30:00.000Z");
  expect(next("*/15 2 * * *", "2026-03-07T12:00:00Z", zone)).toBe("2026-03-08T07:00:00.000Z");
  // What is not skipped keeps its place on the clocks.
  expect(next("30 3 * * *", "2026-03-08T00:00:00Z", zone)).toBe("2026-03-08T07:30:00.000Z");
});

test("a time the clocks repeat fires the first time only", () => {
  // New York went from 02:00 back to 01:00 on 2026-11-01 at 06:00Z.
  const zone = "America/New_York";
  expect(next("30 1 * * *", "2026-11-01T00:00:00Z", zone)).toBe("2026-11-01T05:30:00.000Z");
  expect(next("30 1 * * *", "2026-11-01T05:30:00Z", zone)).toBe("2026-11-02T06:30:00.000Z");
  expect(parseCron("30 1 * * *", zone)!.matches(new Date("2026-11-01T06:30:00Z"))).toBe(false);
});

test("a schedule without a set hour follows the clocks through a change", () => {
  const zone = "America/New_York";
  expect(next("*/30 * * * *", "2026-03-08T06:45:00Z", zone)).toBe("2026-03-08T07:00:00.000Z");
  expect(next("30 * * * *", "2026-11-01T05:30:00Z", zone)).toBe("2026-11-01T06:30:00.000Z");
});

test("a rare schedule is found in a zone, and a day of a half-hour zone too", () => {
  expect(next("0 12 29 2 *", "2026-11-01T00:00:00Z", "Europe/Moscow")).toBe("2028-02-29T09:00:00.000Z");
  expect(next("0 0 1 1 *", "2026-11-01T00:00:00Z", "Asia/Kolkata")).toBe("2026-12-31T18:30:00.000Z");
  expect(next("0 0 30 2 *", "2026-11-01T00:00:00Z", "Europe/Moscow")).toBeUndefined();
});

test("a zone that does not exist is refused", () => {
  expect(parseCron("0 9 * * *", "Mars/Olympus")).toBeUndefined();
  expect(isTimeZone("Europe/Moscow")).toBe(true);
  expect(isTimeZone("Mars/Olympus")).toBe(false);
  expect(isTimeZone(5)).toBe(false);
});

function withStart(start: Record<string, unknown>, more: Record<string, unknown> = {}): ProcessDocument {
  return { schemaVersion: "bazis.workflow/v2", nodes: { Start: start, ...more, End: { kind: "end", title: "End" } }, flows: { a: { source: "Start", target: "End" } } } as unknown as ProcessDocument;
}

const problems = (start: Record<string, unknown>) => validateProcess(withStart({ title: "Start", ...start })).filter((issue) => issue.severity === "error").map((issue) => issue.message);

test("the settings of a schedule are checked", () => {
  const schedule = (config: Record<string, unknown>) => problems({ kind: "scheduleStart", config: { cron: "0 9 * * *", ...config } });
  expect(schedule({ timezone: "Europe/Moscow", from: "2026-11-01T09:00:00+03:00", until: "2026-12-01T00:00:00Z", overlap: "queue", catchUp: true, partitions: ["a", "b"] })).toEqual([]);
  expect(schedule({ partitions: "all" })).toEqual([]);
  expect(schedule({ timezone: "Mars/Olympus" })[0]).toContain("config.timezone");
  expect(schedule({ from: "2026-11-01" })[0]).toContain("config.from");
  expect(schedule({ from: "2026-12-01T00:00:00Z", until: "2026-11-01T00:00:00Z" })[0]).toContain("before config.until");
  expect(schedule({ overlap: "later" })[0]).toContain("config.overlap");
  expect(schedule({ catchUp: "yes" })[0]).toContain("config.catchUp");
  expect(schedule({ partitions: [] })[0]).toContain("config.partitions");
});

test("the settings of an event start are checked: only the event can be read", () => {
  const event = (config: Record<string, unknown>) => problems({ kind: "eventStart", config: { event: "orders.placed", ...config } });
  const big = { op: "gt", args: [{ path: "$event.amount" }, 100] };
  expect(event({ filter: big, debounce: { key: { path: "$event.id" }, window: "PT5M" }, delay: "PT1M", ignoreOwn: true })).toEqual([]);
  expect(event({ filter: { path: "$vars.x" } })[0]).toContain("config.filter");
  expect(event({ filter: { path: "$input.x" } })[0]).toContain("config.filter");
  expect(event({ debounce: { window: "PT5M" } })[0]).toContain("config.debounce.key");
  expect(event({ debounce: { key: { path: "$nodes.Start.x" }, window: "PT5M" } })[0]).toContain("config.debounce.key");
  expect(event({ debounce: { key: 1, window: "soon" } })[0]).toContain("config.debounce.window");
  expect(event({ delay: "soon" })[0]).toContain("config.delay");
  expect(event({ ignoreOwn: "yes" })[0]).toContain("config.ignoreOwn");
});

test("eventWait.until is an expression over what the step sees", () => {
  const document = (until: unknown) => ({
    schemaVersion: "bazis.workflow/v2",
    nodes: { Start: { kind: "manualStart", title: "Start" }, Wait: { kind: "eventWait", title: "Wait", config: { event: "orders.changed", until } }, End: { kind: "end", title: "End" } },
    flows: { a: { source: "Start", target: "Wait" }, b: { source: "Wait", target: "End" } },
  });
  expect(validateProcess(document({ op: "eq", args: [{ path: "$event.status" }, "approved"] })).filter((issue) => issue.severity === "error")).toEqual([]);
  expect(validateProcess(document({ op: "nope", args: [] })).some((issue) => issue.message.includes("config.until"))).toBe(true);
});
