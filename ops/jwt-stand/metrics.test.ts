import { expect, test } from "bun:test";
import { Histogram, splitDelay } from "./metrics";
import { LoopProbe } from "./LoopProbe";
import { counterDelta } from "./SchedulerProbe";

test("a slow preceding request contributes to queue, not timer wakeup", () => {
  expect(splitDelay(100, 450, 452)).toEqual({ queueMs: 350, wakeMs: 2 });
  expect(splitDelay(100, 10, 102)).toEqual({ queueMs: 0, wakeMs: 2 });
  expect(splitDelay(100, 10, 99.8)).toEqual({ queueMs: 0, wakeMs: 0 });
});

test("the split conserves total positive lag across different timelines", () => {
  for (const due of [0, 100, 1e6]) {
    for (const ready of [due - 20, due, due + 200]) {
      for (const begin of [ready, ready + 100, ready + 800]) {
        const delay = splitDelay(due, ready, begin);
        expect(delay.queueMs + delay.wakeMs).toBe(Math.max(0, begin - due));
      }
    }
  }
});

test("histogram uses upper bounds and does not hide slow overflow", () => {
  const histogram = new Histogram();
  expect(histogram.result()).toEqual({ count: 0 });
  for (let i = 0; i < 98; i++) histogram.add(.2);
  histogram.add(12000); histogram.add(15000);
  expect(histogram.count).toBe(100);
  expect(histogram.p(.95)).toBe(1);
  expect(histogram.p(.99)).toBe(15000);
  expect(histogram.result().maxMs).toBe(15000);
});

test("invalid timing inputs fail instead of producing false good metrics", () => {
  const histogram = new Histogram();
  for (const value of [NaN, Infinity, -1]) expect(() => histogram.add(value)).toThrow();
  expect(() => histogram.p(.99)).toThrow();
  expect(() => splitDelay(0, 2, 1)).toThrow();
});

test("timer gaps retain the observed wall-clock bracket, including clock changes", () => {
  const probe = new LoopProbe(0, 1000);
  probe.sample(20, 1020);
  probe.sample(320, 1320);
  probe.sample(420, 1220);
  expect(probe.snapshot().events).toEqual([
    { sequence: 1, fromEpochMs: 1020, toEpochMs: 1320, delayMs: 280 },
    { sequence: 2, fromEpochMs: 1320, toEpochMs: 1220, delayMs: 80 },
  ]);
  expect(probe.snapshot().timerDelay.count).toBe(3);
  expect(() => probe.sample(419, 1500)).toThrow();
});

test("timer trace is bounded and reports omitted events instead of silent loss", () => {
  const probe = new LoopProbe(0, 0);
  for (let i = 1; i <= 600; i++) probe.sample(i * 100, i * 100);
  const snapshot = probe.snapshot();
  expect(snapshot.events.length).toBe(512);
  expect(snapshot.eventsSeen).toBe(600);
  expect(snapshot.dropped).toBe(88);
  expect(snapshot.events[0]!.sequence).toBe(89);
  expect(snapshot.timerDelay.count).toBe(600);
  snapshot.events.pop();
  expect(probe.snapshot().events.length).toBe(512);
});

test("missing or reset kernel counters cannot masquerade as zero scheduler pressure", () => {
  expect(counterDelta({ processCpuMs: 5, runQueueMs: 10, mainCpuMs: 100 },
    { processCpuMs: 8, runQueueMs: 22, mainCpuMs: 90, throttledMs: 0 }))
    .toEqual({ processCpuMs: 3, runQueueMs: 12 });
  expect(counterDelta({ processCpuMs: NaN }, { processCpuMs: 20 })).toEqual({});
});
