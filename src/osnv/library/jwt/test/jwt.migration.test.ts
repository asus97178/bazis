import { expect, spyOn, test } from "bun:test";
import { JwtClaimError, JwtEncoder, JwtKeyRing, JwtValidator, hs256 } from "../index";

const secret = "synthetic-legacy-0123456789-abcdefghijklmnopqrstuvwxyz";

test("missing kid requires an explicit key and deadline; unknown kid never falls back", async () => {
  const algorithm = hs256(secret);
  const old = await new JwtEncoder(algorithm).encode({ exp: Date.now() / 1000 + 3600 });
  const keys = [{ keyId: "old", algorithm }];
  const strict = await JwtKeyRing.create({ keys, activeKeyId: "old" });
  await expect(new JwtValidator(strict).validate(old)).rejects.toBeInstanceOf(JwtClaimError);
  const legacy = { keyId: "old", acceptUntil: Date.now() / 1000 + 3600 };
  const ring = await JwtKeyRing.create({ keys, activeKeyId: "old", legacy });
  legacy.acceptUntil = 1; legacy.keyId = "changed";
  expect((await new JwtValidator(ring).validate(old)).header.kid).toBeUndefined();
  const unexpected = await new JwtEncoder({ alg: "HS256", canSign: true, keyId: "unknown",
    sign: input => algorithm.sign(input), verify: (input, sig) => algorithm.verify(input, sig),
  }).encode({ exp: Date.now() / 1000 + 3600 });
  await expect(new JwtValidator(ring).validate(unexpected)).rejects.toBeInstanceOf(JwtClaimError);
  const current = await new JwtEncoder(ring).encode({ exp: Date.now() / 1000 + 3600 });
  expect((await new JwtValidator(ring).validate(current)).header.kid).toBe("old");
  expect(Object.isFrozen(ring.status().legacy)).toBe(true);
});

test("legacy cutoff is exact, has no clock leeway, and does not expire keyed tokens", async () => {
  const algorithm = hs256(secret);
  const ring = await JwtKeyRing.create({ keys: [{ keyId: "old", algorithm }], activeKeyId: "old", legacy: { keyId: "old", acceptUntil: 2000 } });
  const old = await new JwtEncoder(algorithm).encode({ exp: 4000 });
  const keyed = await new JwtEncoder(ring).encode({ exp: 4000 });
  const now = spyOn(Date, "now").mockReturnValue(1_999_999);
  try {
    const validator = new JwtValidator(ring, { clockSkewSeconds: 3600 });
    await validator.validate(old);
    now.mockReturnValue(2_000_000);
    await expect(validator.validate(old)).rejects.toBeInstanceOf(JwtClaimError);
    expect((await validator.validate(keyed)).header.kid).toBe("old");
  } finally { now.mockRestore(); }
});

test("migration expiry during verification is enforced after crypto", async () => {
  const key = hs256(secret);
  let delay = false;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const algorithm = { alg: "HS256", canSign: true, sign: (value: string) => key.sign(value),
    async verify(value: string, signature: Uint8Array) {
      if (delay) { entered.resolve(); await release.promise; }
      return key.verify(value, signature);
    } };
  const ring = await JwtKeyRing.create({ keys: [{ keyId: "old", algorithm }], activeKeyId: "old", legacy: { keyId: "old", acceptUntil: 2000 } });
  const token = await new JwtEncoder(key).encode({ exp: 4000 });
  const now = spyOn(Date, "now").mockReturnValue(1_999_999);
  try {
    delay = true;
    const result = Promise.allSettled([new JwtValidator(ring).validate(token)]);
    await entered.promise;
    now.mockReturnValue(2_000_000); release.resolve();
    expect((await result)[0]).toMatchObject({ status: "rejected", reason: expect.any(JwtClaimError) });
  } finally { release.resolve(); now.mockRestore(); }
});

test("removing migration policy or revoking its key stops legacy verification", async () => {
  const algorithm = hs256(secret), next = hs256(secret + "-next");
  const keys = [{ keyId: "old", algorithm }, { keyId: "next", algorithm: next }];
  const ring = await JwtKeyRing.create({ keys, activeKeyId: "next", legacy: { keyId: "old", acceptUntil: Date.now() / 1000 + 3600 } });
  const validator = new JwtValidator(ring);
  const token = await new JwtEncoder(algorithm).encode({ exp: Date.now() / 1000 + 3600 });
  await validator.validate(token);
  await ring.replace({ keys, activeKeyId: "next" });
  await expect(validator.validate(token)).rejects.toBeInstanceOf(JwtClaimError);
  await ring.replace({ keys, activeKeyId: "next", legacy: { keyId: "old", acceptUntil: Date.now() / 1000 + 3600 } });
  ring.revoke("old");
  await expect(validator.validate(token)).rejects.toBeInstanceOf(JwtClaimError);
  expect(ring.status().legacy).toBeUndefined();
});

test("invalid migration configuration fails before a key set can be used", async () => {
  const keys = [{ keyId: "old", algorithm: hs256(secret) }];
  for (const legacy of [null, [], {}, { keyId: "absent", acceptUntil: 2000 }, { keyId: "old", acceptUntil: 0 },
    { keyId: "old", acceptUntil: Infinity }, { keyId: "old", acceptUntil: "2000" }]) {
    await expect(JwtKeyRing.create({ keys, legacy } as never)).rejects.toThrow();
  }
});
