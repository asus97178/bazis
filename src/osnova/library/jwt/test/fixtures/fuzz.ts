import { createHmac } from "node:crypto";
import { JwtValidator, JwtError, JwtKeyRing, hs256 } from "../../index";

/** Reproducible malformed-input campaign and independently encoded HMAC controls. */
export async function runJwtFuzz(iterations = 30_000, seed = 0x51a7_2026) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000_000) throw new Error("Invalid fuzz iteration count");
  let state = seed >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const bytes = (size: number) => Buffer.from(Array.from({ length: size }, () => random() & 255));
  // Synthetic test key only. Seed controls input generation, never production secrets.
  const secret = bytes(32);
  const ring = await JwtKeyRing.create({ keys: [{ keyId: "fuzz", algorithm: hs256(secret) }] });
  const validators = [new JwtValidator(hs256(secret), { issuer: "fuzz", audience: "api", clockSkewSeconds: 0 }),
    new JwtValidator(ring, { issuer: "fuzz", audience: "api", clockSkewSeconds: 0 })];
  const header = { alg: "HS256", kid: "fuzz", typ: "JWT" };
  const payload = { sub: "subject", iss: "fuzz", aud: "api", exp: Date.now() / 1000 + 3600 };
  function sign(headerText: string | Buffer, payloadText: string | Buffer) {
    const input = `${Buffer.from(headerText).toString("base64url")}.${Buffer.from(payloadText).toString("base64url")}`;
    return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
  }
  const valid = sign(JSON.stringify(header), JSON.stringify(payload));
  const invalidJson = ["null", "[]", "true", "0", '"text"', "{", "", "undefined"];
  const badClaims = [
    { exp: null }, { exp: "999999999999" }, { nbf: "0" }, { iat: false }, { aud: ["api", 3] },
    { iss: [] }, { sub: {} }, { jti: 1 }, { exp: 0 }, { nbf: Number.MAX_SAFE_INTEGER }, { aud: "other" },
  ];
  let rejected = 0; let controls = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const pick = random(); let token: string;
    switch (i % 6) {
      case 0: token = bytes(pick % 2048).toString("utf8"); break;
      case 1: token = sign(invalidJson[pick % invalidJson.length]!, JSON.stringify(payload)); break;
      case 2: token = sign(JSON.stringify(header), pick % 2 ? invalidJson[pick % invalidJson.length]! : JSON.stringify({ ...payload, ...badClaims[(pick >>> 4) % badClaims.length] })); break;
      case 3: token = sign(JSON.stringify({ ...header, crit: [bytes(8).toString("hex")] }), JSON.stringify(payload)); break;
      case 4: {
        const index = valid.lastIndexOf(".") + 1;
        token = valid.slice(0, index) + (valid[index] === "A" ? "B" : "A") + valid.slice(index + 1);
        break;
      }
      default: {
        const segments = valid.split(".");
        const part = pick % 3;
        segments[part] = segments[part]! + ["\n", "\r", " ", "=", "\t", "\u0000", "\u00a0", "\u200b"][pick % 8]!;
        token = segments.join(".");
      }
    }
    try {
      await validators[i % 2]!.validate(token);
      throw new Error(`Fuzz accepted invalid input at iteration ${i}, seed ${seed}`);
    } catch (error) {
      if (!(error instanceof JwtError)) throw new Error(`Unexpected fuzz outcome at iteration ${i}, seed ${seed}`, { cause: error });
      rejected++;
    }
    if (i % 30 === 0) {
      const subject = `subject-${bytes(12).toString("hex")}-Ж😀`;
      const control = sign(JSON.stringify(header), JSON.stringify({ ...payload, sub: subject }));
      const verified = await validators[(i / 30) % 2]!.validate(control);
      if (verified.payload.sub !== subject) throw new Error("Fuzz control identity changed");
      controls++;
    }
  }
  return { seed, iterations, rejected, controls, unexpected: 0, durationMs: performance.now() - start };
}

if (import.meta.main) console.log(JSON.stringify(await runJwtFuzz(Number(process.env.JWT_FUZZ_ITERATIONS ?? 100_000)), null, 2));
