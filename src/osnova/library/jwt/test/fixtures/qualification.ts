import { JwtEncoder, JwtValidator, JwtKeyRing, JwtSignatureError, hs256, rs256, generateRsaKeyPairPem, type SigningAlgorithm } from "../../index";

const durationSeconds = Number(process.env.JWT_Q_DURATION_SECONDS ?? 120);
if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600) throw new Error("Invalid soak duration");
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
const policy = { issuer: "qualification", audience: "api", clockSkewSeconds: 0 };
const payload = (size: number) => ({ iss: policy.issuer, aud: policy.audience, sub: "subject", exp: Date.now() / 1000 + 7200, data: "x".repeat(size) });
const algorithms: SigningAlgorithm[] = [hs256(crypto.getRandomValues(new Uint8Array(32))), rs256(await generateRsaKeyPairPem())];
const measurements = [];
for (const algorithm of algorithms) {
  const ring = await JwtKeyRing.create({ keys: [{ keyId: "bench", algorithm }], activeKeyId: "bench" });
  const encoder = new JwtEncoder(ring); const validator = new JwtValidator(ring, policy);
  for (const payloadBytes of [256, 2048]) {
    const claims = payload(payloadBytes); const token = await encoder.encode(claims);
    for (let i = 0; i < 100; i++) { await encoder.encode(claims); await validator.validate(token); }
    for (const concurrency of [1, 16, 64]) {
      for (const operation of ["sign", "verify"] as const) {
        const count = 1024; let index = 0; const latencies: number[] = [];
        const start = performance.now();
        await Promise.all(Array.from({ length: concurrency }, async () => {
          while (index++ < count) {
            const began = performance.now();
            if (operation === "sign") await encoder.encode(claims); else await validator.validate(token);
            latencies.push(performance.now() - began);
          }
        }));
        const durationMs = performance.now() - start;
        latencies.sort((a, b) => a - b);
        const p99Ms = percentile(latencies, .99);
        measurements.push({ algorithm: algorithm.alg, operation, payloadBytes, tokenBytes: token.length, concurrency,
          count: latencies.length, durationMs, throughputPerSecond: count * 1000 / durationMs,
          p95Ms: percentile(latencies, .95), p99Ms, rssBytes: process.memoryUsage().rss,
          gate: concurrency === 16 ? (p99Ms <= (operation === "verify" ? 100 : 500) ? "PASS" : "FAIL") : "MEASURED" });
      }
    }
  }
}
console.error("JWT latency measurements complete; starting soak");

const old = { keyId: "soak-a", algorithm: hs256(crypto.getRandomValues(new Uint8Array(32))) };
const next = { keyId: "soak-b", algorithm: hs256(crypto.getRandomValues(new Uint8Array(32))) };
const ring = await JwtKeyRing.create({ keys: [old, next], activeKeyId: old.keyId });
const encoder = new JwtEncoder(ring); const validator = new JwtValidator(ring, policy);
const data = payload(2048);
for (let i = 0; i < 2000; i++) await validator.validate(await encoder.encode(data));
Bun.gc(true);
const initialRss = process.memoryUsage().rss;
const samples: { seconds: number; rssBytes: number; operations: number }[] = [];
const soakStart = performance.now(); let nextSample = soakStart; let nextRotation = soakStart + 5000;
let rotations = 0; let signed = 0; let verified = 0; let expectedRejections = 0;
let maxRss = initialRss;
while (performance.now() - soakStart < durationSeconds * 1000) {
  await Promise.all(Array.from({ length: 16 }, async (_, i) => {
    const token = await encoder.encode(data); signed++;
    await validator.validate(token); verified++;
    if (i === 0) {
      const position = token.lastIndexOf(".") + 1;
      const invalid = token.slice(0, position) + (token[position] === "A" ? "B" : "A") + token.slice(position + 1);
      try { await validator.validate(invalid); throw new Error("Invalid signature accepted under load"); }
      catch (error) { if (!(error instanceof JwtSignatureError)) throw error; expectedRejections++; }
    }
  }));
  const now = performance.now();
  if (now >= nextRotation) {
    rotations++; await ring.replace({ keys: [old, next], activeKeyId: rotations % 2 ? next.keyId : old.keyId });
    nextRotation = now + 5000;
  }
  if (now >= nextSample) {
    const rssBytes = process.memoryUsage().rss; maxRss = Math.max(maxRss, rssBytes);
    samples.push({ seconds: (now - soakStart) / 1000, rssBytes, operations: signed + verified + expectedRejections });
    nextSample = now + 1000;
  }
}
const soakDurationMs = performance.now() - soakStart;
Bun.gc(true);
const finalRss = process.memoryUsage().rss;
const soak = { durationSeconds, durationMs: soakDurationMs, concurrency: 16, payloadBytes: 2048, signed, verified, expectedRejections,
  unexpectedErrors: 0, rotations, initialRss, finalRss, maxRss, maxGrowthBytes: maxRss - initialRss, samples,
  throughputPerSecond: (signed + verified + expectedRejections) * 1000 / soakDurationMs,
  gate: maxRss - initialRss <= 128 * 1024 * 1024 ? "PASS" : "FAIL" };
const result = { profile: "local engineering qualification, not a production SLA", runtime: Bun.version, revision: Bun.revision,
  platform: process.platform, arch: process.arch, measurements, soak,
  gate: measurements.every(row => row.gate !== "FAIL") && soak.gate === "PASS" ? "PASS" : "FAIL" };
console.log(JSON.stringify(result, null, 2));
if (result.gate === "FAIL") process.exitCode = 1;
