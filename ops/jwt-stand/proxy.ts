import assert from "node:assert/strict";
import authority from "../../toolchain/bun.json";
import { LoopProbe } from "./LoopProbe";
import { SchedulerProbe } from "./SchedulerProbe";

assert.equal(Bun.version, authority.runtime.version);
assert.equal(Bun.revision, authority.runtime.revision);
const schedulerMode = process.env.OSNV_JWT_STAND_SCHEDULER;
assert(schedulerMode === undefined || schedulerMode === "0" || schedulerMode === "1", "Invalid OSNV_JWT_STAND_SCHEDULER");
const peers = ["http://app-a:3000", "http://app-b:3000"];
const healthy = new Set<string>();
let cursor = 0, probing = false;
async function probe() {
  if (probing) return;
  probing = true;
  try {
    await Promise.all(peers.map(async peer => {
      try {
        const response = await fetch(peer + "/health", { signal: AbortSignal.timeout(1500), redirect: "error" });
        const body = await response.json() as { healthy?: boolean };
        if (response.ok && body.healthy === true) healthy.add(peer); else healthy.delete(peer);
      } catch { healthy.delete(peer); }
    }));
  } finally { probing = false; }
}
await probe();
const interval = setInterval(probe, 2000);
const loop = new LoopProbe(performance.now(), Date.now(), schedulerMode === "1" ? new SchedulerProbe() : undefined);
const loopTimer = setInterval(() => loop.sample(), loop.intervalMs);
const server = Bun.serve({ hostname: "0.0.0.0", port: 8443, maxRequestBodySize: 1024 * 1024,
  tls: { key: Bun.file("/stand/certs/server.key"), cert: Bun.file("/stand/certs/server.crt") },
  async fetch(request) {
    const started = performance.now();
    const startedEpochMs = Date.now();
    const url = new URL(request.url);
    const clockHeaders = () => ({ "x-stand-entered-epoch-ms": String(startedEpochMs), "x-stand-ready-epoch-ms": String(Date.now()) });
    if (url.pathname === "/__stand/diagnostics") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      return Response.json(loop.snapshot(), { headers: { "cache-control": "no-store", ...clockHeaders() } });
    }
    if (url.pathname === "/__stand/status") return Response.json({ ready: healthy.size === peers.length, replicas: peers.map(peer => ({ name: new URL(peer).hostname, healthy: healthy.has(peer) })) }, { headers: clockHeaders() });
    const available = peers.filter(peer => healthy.has(peer));
    if (available.length === 0) return Response.json({ error: "No healthy replica" }, { status: 503 });
    const peer = available[cursor++ % available.length]!;
    const headers = new Headers(request.headers);
    for (const name of ["host", "connection", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]) headers.delete(name);
    try {
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
      const upstreamStarted = performance.now();
      const response = await fetch(peer + url.pathname + url.search, { method: request.method, headers,
        body,
        redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
      const received = performance.now();
      const outputHeaders = new Headers(response.headers);
      outputHeaders.set("x-stand-replica", new URL(peer).hostname);
      outputHeaders.set("x-stand-upstream-ms", (received - upstreamStarted).toFixed(3));
      outputHeaders.set("x-stand-handler-ms", (received - started).toFixed(3));
      for (const [name, value] of Object.entries(clockHeaders())) outputHeaders.set(name, value);
      return new Response(response.body, { status: response.status, headers: outputHeaders });
    } catch { return Response.json({ error: "Upstream request failed" }, { status: 502 }); }
  },
});
async function stop() { clearInterval(interval); clearInterval(loopTimer); await server.stop(false); process.exit(0); }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
