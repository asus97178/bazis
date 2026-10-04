import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import authority from "../../toolchain/bun.json";
import { Histogram, splitDelay } from "./metrics";
import { LoopProbe } from "./LoopProbe";
import { SchedulerProbe } from "./SchedulerProbe";

assert.equal(Bun.version, authority.runtime.version);
assert.equal(Bun.revision, authority.runtime.revision);
const mode = process.argv[2] ?? "health";
const option = (name: string, fallback: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const base = option("url", "https://proxy:8443");
const location = new URL(base);
assert(["proxy", "app-a", "app-b", "127.0.0.1"].includes(location.hostname));
assert(!location.username && !location.password && ["http:", "https:"].includes(location.protocol));
type Pair = { accessToken: string; refreshToken: string };
type ResponseTiming = { replica?: string; upstreamHeadersMs?: number; proxyHeadersMs?: number;
  proxyEnteredEpochMs?: number; proxyReadyEpochMs?: number; clientStartedEpochMs?: number; clientHeadersEpochMs?: number;
  clientBodyEpochMs?: number; headersMs?: number; bodyMs?: number; validateMs?: number };
async function request(path: string, body?: unknown, token?: string, status = 200, timing?: ResponseTiming): Promise<any> {
  const started = performance.now();
  if (timing) timing.clientStartedEpochMs = Date.now();
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const headersReceived = performance.now();
  if (timing) timing.clientHeadersEpochMs = Date.now();
  const content = await response.text();
  const bodyReceived = performance.now();
  if (timing) {
    timing.clientBodyEpochMs = Date.now();
    timing.headersMs = headersReceived - started;
    timing.bodyMs = bodyReceived - headersReceived;
    timing.replica = response.headers.get("x-stand-replica") ?? undefined;
    for (const [header, key] of [["x-stand-upstream-ms", "upstreamHeadersMs"], ["x-stand-handler-ms", "proxyHeadersMs"],
      ["x-stand-entered-epoch-ms", "proxyEnteredEpochMs"], ["x-stand-ready-epoch-ms", "proxyReadyEpochMs"]] as const) {
      const raw = response.headers.get(header), value = Number(raw);
      if (raw !== null && Number.isFinite(value) && value >= 0) timing[key] = value;
    }
  }
  assert.equal(response.status, status, `${path}: expected ${status}, received ${response.status}`);
  assert(content.length <= 1024 * 1024, "Response too large");
  if (body !== undefined && status === 200) assert.equal(response.headers.get("cache-control"), "no-store");
  const result = content ? JSON.parse(content) : undefined;
  if (timing) timing.validateMs = performance.now() - bodyReceived;
  return result;
}
const account = async () => Bun.file("/stand/secrets/admin.json").json();

if (mode === "health") {
  assert.equal((await request("/health")).healthy, true);
  console.log(JSON.stringify({ status: "PASS", check: "health" }));
} else if (mode === "smoke") {
  const credentials = await account();
  const bootstrap = await request("/api/admin/auth/bootstrap");
  const pair: Pair = await request(bootstrap.available ? "/api/admin/auth/bootstrap" : "/api/admin/auth/login", credentials);
  await request("/api/admin/settings", undefined, pair.accessToken);
  await request("/api/admin/settings", undefined, "malformed-jwt", 401);
  const refreshed: Pair = await request("/api/admin/auth/refresh", { refreshToken: pair.refreshToken });
  await request("/api/admin/settings", undefined, refreshed.accessToken);
  const header = JSON.parse(Buffer.from(refreshed.accessToken.split(".")[0]!, "base64url").toString());
  assert.equal(header.kid, "stand-active");
  console.log(JSON.stringify({ status: "PASS", bootstrapUsed: bootstrap.available, checked: ["login/bootstrap", "protected access", "invalid JWT 401", "refresh", "active kid"] }));
} else if (mode === "load") {
  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(option(name, String(fallback)));
    assert(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${name}`);
    return value;
  };
  const seconds = number("seconds", 300, 10, 900), rps = number("rps", 100, 1, 1000), concurrency = number("concurrency", 16, 1, 64);
  const workload = option("workload", "auth");
  assert(workload === "auth" || workload === "proxy-status", "Invalid workload");
  assert(workload !== "proxy-status" || location.hostname === "proxy", "Status workload requires proxy");
  const pairs: (Pair | undefined)[] = Array.from({ length: concurrency });
  if (workload === "auth") {
    const credentials = await account();
    for (let i = 0; i < concurrency; i++) pairs[i] = await request("/api/admin/auth/login", credentials);
    await Promise.all(pairs.map(pair => request("/api/admin/settings", undefined, pair!.accessToken)));
  } else {
    await Promise.all(pairs.map(() => request("/__stand/status")));
  }
  const latency = new Histogram(), service = new Histogram(), lag = new Histogram();
  const queue = new Histogram(), wake = new Histogram();
  const headersTime = new Histogram(), bodyTime = new Histogram(), validateTime = new Histogram();
  const upstream = new Histogram(), proxy = new Histogram(), readTime = new Histogram(), refreshTime = new Histogram();
  const replicas: Record<string, number> = {};
  const slowest: (ResponseTiming & { index: number; operation: string; serviceMs: number; queueMs: number; wakeMs: number })[] = [];
  const windows = Array.from({ length: Math.ceil(seconds / 10) }, () => new Histogram());
  const errors: string[] = [];
  let reads = 0, refreshes = 0, maxRss = process.memoryUsage().rss;
  const cgroup = () => Object.fromEntries(["cpu.stat", "cpu.pressure", "memory.peak"].map(name => {
    try { return [name, readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim()]; } catch { return [name, null]; }
  }));
  const proxyLoopBefore = location.hostname === "proxy" ? await request("/__stand/diagnostics") : undefined;
  const schedulerDiagnostics = proxyLoopBefore?.scheduler !== undefined;
  const before = cgroup(), initialRss = maxRss, start = performance.now() + 100;
  const startedAt = new Date(Date.now() + 100).toISOString();
  const loop = new LoopProbe(performance.now(), Date.now(), schedulerDiagnostics ? new SchedulerProbe() : undefined);
  const loopTimer = setInterval(() => loop.sample(), loop.intervalMs);
  const memoryTimer = setInterval(() => { maxRss = Math.max(maxRss, process.memoryUsage().rss); }, 1000);
  const progressTimer = setInterval(() => { console.error(JSON.stringify({ seconds: Math.round((performance.now() - start) / 1000), requests: latency.count, errors: errors.length })); }, 30000);
  try {
    await Promise.all(pairs.map(async (initial, lane) => {
      let pair = initial;
      for (let i = lane; i < seconds * rps && errors.length === 0; i += concurrency) {
        const due = start + i * 1000 / rps;
        const ready = performance.now();
        if (ready < due) await Bun.sleep(due - ready);
        const begin = performance.now();
        const delay = splitDelay(due, ready, begin), timing: ResponseTiming = {};
        const refresh = workload === "auth" && (Math.floor(i / concurrency) + lane) % 20 === 0;
        try {
          if (workload === "proxy-status") { assert.equal((await request("/__stand/status", undefined, undefined, 200, timing)).ready, true); reads++; }
          else if (refresh) {
            pair = await request("/api/admin/auth/refresh", { refreshToken: pair!.refreshToken }, undefined, 200, timing); refreshes++;
          } else { await request("/api/admin/settings", undefined, pair!.accessToken, 200, timing); reads++; }
        } catch (error) { errors.push(error instanceof Error ? error.message : "Request failed"); }
        const end = performance.now();
        latency.add(Math.max(0, end - due)); service.add(end - begin); lag.add(Math.max(0, begin - due));
        queue.add(delay.queueMs); wake.add(delay.wakeMs);
        (refresh ? refreshTime : readTime).add(end - begin);
        if (timing.upstreamHeadersMs !== undefined) upstream.add(timing.upstreamHeadersMs);
        if (timing.proxyHeadersMs !== undefined) proxy.add(timing.proxyHeadersMs);
        if (timing.headersMs !== undefined) headersTime.add(timing.headersMs);
        if (timing.bodyMs !== undefined) bodyTime.add(timing.bodyMs);
        if (timing.validateMs !== undefined) validateTime.add(timing.validateMs);
        if (timing.replica) replicas[timing.replica] = (replicas[timing.replica] ?? 0) + 1;
        if (slowest.length < 16 || end - begin > slowest[slowest.length - 1]!.serviceMs) {
          slowest.push({ index: i, operation: workload === "proxy-status" ? "status" : refresh ? "refresh" : "read", serviceMs: end - begin, ...delay, ...timing });
          slowest.sort((a, b) => b.serviceMs - a.serviceMs); slowest.length = Math.min(16, slowest.length);
        }
        windows[Math.min(windows.length - 1, Math.floor(i / rps / 10))]!.add(Math.max(0, end - due));
      }
    }));
  } finally { clearInterval(memoryTimer); clearInterval(progressTimer); clearInterval(loopTimer); }
  const elapsed = performance.now() - start;
  const finishedAt = new Date().toISOString(), after = cgroup();
  let proxyLoopAfter, proxyDiagnosticError;
  try { if (location.hostname === "proxy") proxyLoopAfter = await request("/__stand/diagnostics"); }
  catch { proxyDiagnosticError = "Proxy diagnostics unavailable after load"; }
  const gates = { errors: errors.length === 0, completed: latency.count >= seconds * rps * .99,
    p95: latency.p(.95) <= 250, p99: latency.p(.99) <= 500,
    windows: windows.every(window => window.count > 0 && window.p(.99) <= 500), lag: lag.p(.99) <= 100,
    generatorRss: maxRss - initialRss <= 128 * 1024 * 1024 };
  console.log(JSON.stringify({ status: Object.values(gates).every(Boolean) ? "PASS" : "FAIL", profile: { seconds, rps, concurrency, workload, target: location.origin, schedulerDiagnostics },
    startedAt, finishedAt,
    elapsedSeconds: elapsed / 1000, planned: seconds * rps, completed: latency.count, throughput: latency.count * 1000 / elapsed,
    reads, refreshes, errors, latency: latency.result(), service: service.result(), lag: lag.result(), gates,
    diagnostics: { queue: queue.result(), wake: wake.result(), timerDelay: loop.snapshot().timerDelay,
      clientLoop: loop.snapshot(), proxyLoopBefore, proxyLoopAfter, proxyDiagnosticError,
      headers: headersTime.result(), body: bodyTime.result(), validate: validateTime.result(),
      upstreamHeaders: upstream.result(), proxyHeaders: proxy.result(), reads: readTime.result(), refreshes: refreshTime.result(), replicas, slowest },
    windows: windows.map((window, index) => ({ startSeconds: index * 10, ...(window.count ? window.result() : { count: 0 }) })),
    initialRss, maxRss, cgroupBefore: before, cgroupAfter: after, runtime: { version: Bun.version, revision: Bun.revision } }, null, 2));
  if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
} else { throw new Error("Expected health, smoke or load"); }
