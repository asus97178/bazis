import { describe, expect, test } from "bun:test";
import {
  JwtKeyRing, JwtEncoder, JwtValidator, TokenIssuer, hs256, rs256, generateRsaKeyPairPem,
  JwtClaimError, JwtAlgorithmError, JwtMalformedError, base64UrlEncodeString, base64UrlEncode,
  type SigningAlgorithm, type JwtKeyRingConfig,
} from "../index";

const claims = () => ({ sub: "alice", iss: "issuer", aud: "api", exp: Date.now() / 1000 + 300 });
const options = { issuer: "issuer", audience: "api", clockSkewSeconds: 0 };
const entry = (keyId: string) => ({ keyId, algorithm: hs256(crypto.getRandomValues(new Uint8Array(32))) });

describe("JWT trusted key lifecycle", () => {
  test("staged rotation keeps old and new tokens valid across independently prepared verifiers", async () => {
    const old = entry("old"); const next = entry("next");
    const issuer = await JwtKeyRing.create({ keys: [old], activeKeyId: "old" });
    const left = await JwtKeyRing.create({ keys: [old, next] });
    const right = await JwtKeyRing.create({ keys: [old, next] });
    const encoder = new JwtEncoder(issuer);
    const before = await encoder.encode(claims());
    await issuer.replace({ keys: [old, next], activeKeyId: "next" });
    const after = await encoder.encode(claims());
    for (const ring of [issuer, left, right]) {
      const validator = new JwtValidator(ring, options);
      expect((await validator.validate(before)).header.kid).toBe("old");
      expect((await validator.validate(after)).header.kid).toBe("next");
      ring.revoke("old");
      await expect(validator.validate(before)).rejects.toBeInstanceOf(JwtClaimError);
      expect((await validator.validate(after)).payload.sub).toBe("alice");
    }
    await expect(issuer.replace({ keys: [old, next], activeKeyId: "next" })).rejects.toThrow("revoked");
  });

  test("TokenIssuer supports separate rotating access and refresh key rings", async () => {
    const access = entry("access"); const refresh = entry("refresh");
    const ring = await JwtKeyRing.create({ keys: [access], activeKeyId: "access" });
    const refreshRing = await JwtKeyRing.create({ keys: [refresh], activeKeyId: "refresh" });
    const issuer = new TokenIssuer({ ...options, algorithm: ring, refreshAlgorithm: refreshRing, accessTtlSeconds: 30, refreshTtlSeconds: 120 });
    const pair = await issuer.issue("alice");
    expect((await issuer.verifyAccess(pair.accessToken)).header.kid).toBe("access");
    await expect(issuer.verifyAccess(pair.refreshToken)).rejects.toBeInstanceOf(JwtClaimError);
    const next = entry("refresh-next");
    await refreshRing.replace({ keys: [refresh, next], activeKeyId: next.keyId });
    const rotated = await issuer.rotate(pair.refreshToken);
    expect((await issuer.verifyRefresh(rotated.refreshToken)).header.kid).toBe(next.keyId);
    refreshRing.revoke("refresh");
    await expect(issuer.verifyRefresh(pair.refreshToken)).rejects.toBeInstanceOf(JwtClaimError);
    expect((await issuer.verifyAccess(pair.accessToken)).payload.sub).toBe("alice");
  });

  test("RSA public-only verifier imports keys and participates in rotation", async () => {
    const pem = await generateRsaKeyPairPem();
    const signer = await JwtKeyRing.create({ keys: [{ keyId: "rsa", algorithm: rs256(pem) }], activeKeyId: "rsa" });
    const verifier = await JwtKeyRing.create({ keys: [{ keyId: "rsa", algorithm: rs256({ publicKeyPem: pem.publicKeyPem }) }] });
    const token = await new JwtEncoder(signer).encode(claims());
    expect((await new JwtValidator(verifier, options).validate(token)).payload.sub).toBe("alice");
    await expect(new JwtEncoder(verifier).encode(claims())).rejects.toThrow("no active");
  });

  test("a mismatched RSA pair cannot replace working keys", async () => {
    const good = entry("good");
    const ring = await JwtKeyRing.create({ keys: [good], activeKeyId: "good" });
    const first = await generateRsaKeyPairPem(); const second = await generateRsaKeyPairPem();
    await expect(ring.replace({ keys: [{ keyId: "broken", algorithm: rs256({ privateKeyPem: first.privateKeyPem, publicKeyPem: second.publicKeyPem }) }], activeKeyId: "broken" })).rejects.toThrow("self-test");
    expect(ring.status().activeKeyId).toBe("good");
    expect((await new JwtValidator(ring, options).validate(await new JwtEncoder(ring).encode(claims()))).payload.sub).toBe("alice");
  });

  test("invalid public PEM fails before publishing a verifier", async () => {
    await expect(JwtKeyRing.create({ keys: [{ keyId: "rsa", algorithm: rs256({ publicKeyPem: "broken" }) }] })).rejects.toBeDefined();
  });

  test("unknown/missing ids and algorithm confusion are rejected before verification", async () => {
    const key = entry("key");
    const ring = await JwtKeyRing.create({ keys: [key] });
    const validator = new JwtValidator(ring, options);
    const token = async (header: object) => {
      const input = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims()))}`;
      return `${input}.${base64UrlEncode(await key.algorithm.sign(input))}`;
    };
    for (const kid of [undefined, "missing", "__proto__", "../../secret", "https://example.test/key"]) {
      await expect(validator.validate(await token({ alg: "HS256", kid, typ: "JWT" }))).rejects.toBeInstanceOf(JwtClaimError);
    }
    await expect(validator.validate(await token({ alg: "RS256", kid: "key" }))).rejects.toBeInstanceOf(JwtAlgorithmError);
    expect((await validator.validate(await token({ alg: "HS256", kid: "key", jku: "https://untrusted.invalid", jwk: { k: "attacker" } }))).payload.sub).toBe("alice");
  });

  test("all config containers are snapshotted and status excludes key material", async () => {
    const key = entry("one"); const config = { keys: [key], activeKeyId: "one" };
    const pending = JwtKeyRing.create(config);
    config.keys.length = 0; config.activeKeyId = "attacker"; key.keyId = "changed";
    const ring = await pending;
    expect(ring.status()).toEqual({ revision: 0, activeKeyId: "one", keys: [{ keyId: "one", alg: "HS256", canSign: true }] });
    expect(JSON.stringify(ring.status())).not.toContain("algorithm");
    expect(Object.isFrozen(ring.status().keys)).toBe(true);
  });

  test("rejects malformed metadata and permissive crypto strategies", async () => {
    const key = entry("key");
    const bad: unknown[] = [null, [], {}, { keys: [] }, { keys: Array(33).fill(key) }, { keys: [key, key] },
      { keys: [{ ...key, keyId: "\n" }] }, { keys: [{ ...key, keyId: "x".repeat(129) }] },
      { keys: [key], activeKeyId: "absent" }, { keys: [key], activeKeyId: null },
      { keys: [{ keyId: "key", algorithm: { ...key.algorithm, alg: "none" } }] },
      { keys: [{ keyId: "key", algorithm: null }] }, { keys: new Array(1) },
      { keys: [{ ...key, algorithm: { alg: "HS256", keyId: "other", canSign: true, sign: async () => new Uint8Array(), verify: async () => true } }] }];
    for (const config of bad) await expect(JwtKeyRing.create(config as JwtKeyRingConfig)).rejects.toBeDefined();
    const acceptsAll: SigningAlgorithm = { alg: "custom", canSign: true, sign: async () => new Uint8Array(1), verify: async () => true };
    await expect(JwtKeyRing.create({ keys: [{ keyId: "bad", algorithm: acceptsAll }] })).rejects.toThrow("self-test");
    await expect(JwtKeyRing.create({ keys: [{ keyId: "bad", algorithm: { ...acceptsAll, canSign: false } }] })).rejects.toThrow("empty signature");
  });

  test("revocation invalidates in-flight verify and sign, and prevents future issuance", async () => {
    const controlled = delayedAlgorithm();
    const ring = await JwtKeyRing.create({ keys: [{ keyId: "key", algorithm: controlled.algorithm }], activeKeyId: "key" });
    const encoder = new JwtEncoder(ring); const validator = new JwtValidator(ring, options);
    const token = await encoder.encode(claims());
    controlled.pause();
    const verifying = validator.validate(token); const signing = encoder.encode(claims());
    const outcomes = Promise.allSettled([verifying, signing]);
    ring.revoke("key"); controlled.release();
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(JwtClaimError);
    }
    await expect(encoder.encode(claims())).rejects.toThrow("no active");
    await expect(validator.validate(token)).rejects.toBeInstanceOf(JwtClaimError);
  });

  test("revocation during preparation cancels stale replacement", async () => {
    const first = entry("first"); const controlled = delayedAlgorithm();
    const ring = await JwtKeyRing.create({ keys: [first], activeKeyId: "first" });
    controlled.pause();
    const replacement = ring.replace({ keys: [first, { keyId: "second", algorithm: controlled.algorithm }], activeKeyId: "second" });
    ring.revoke("first"); controlled.release();
    await expect(replacement).rejects.toThrow("changed during preparation");
    expect(ring.status().keys).toEqual([]);
  });

  test("concurrent replacements cannot silently overwrite one another", async () => {
    const old = entry("old"); const slow = delayedAlgorithm();
    const ring = await JwtKeyRing.create({ keys: [old], activeKeyId: "old" });
    slow.pause();
    const stale = ring.replace({ keys: [old, { keyId: "slow", algorithm: slow.algorithm }], activeKeyId: "slow" });
    const next = entry("next");
    await ring.replace({ keys: [old, next], activeKeyId: "next" });
    slow.release();
    await expect(stale).rejects.toThrow("changed during preparation");
    expect(ring.status().activeKeyId).toBe("next");
  });

  test("switching the active key preserves in-flight operations on retained keys", async () => {
    const old = delayedAlgorithm(); const next = entry("next");
    const oldEntry = { keyId: "old", algorithm: old.algorithm };
    const ring = await JwtKeyRing.create({ keys: [oldEntry, next], activeKeyId: "old" });
    old.pause(); const pending = new JwtEncoder(ring).encode(claims());
    await ring.replace({ keys: [oldEntry, next], activeKeyId: "next" }); old.release();
    expect((await new JwtValidator(ring, options).validate(await pending)).header.kid).toBe("old");
  });

  test("failed key preparation propagates the provider error and keeps working configuration", async () => {
    const old = entry("old"); const outage = new Error("signer unavailable");
    const ring = await JwtKeyRing.create({ keys: [old], activeKeyId: "old" });
    await expect(ring.replace({ keys: [{ keyId: "new", algorithm: { alg: "HS256", canSign: true, sign: async () => { throw outage; }, verify: async () => false } }], activeKeyId: "new" })).rejects.toBe(outage);
    expect(ring.status().revision).toBe(0);
  });
});

describe("bounded JWT inputs", () => {
  test("oversized inputs are rejected before crypto; exact limit is accepted", async () => {
    const key = entry("k"); const data = claims(); const token = await new JwtEncoder(key.algorithm).encode(data);
    const validator = new JwtValidator(key.algorithm, { ...options, maxTokenLength: token.length });
    expect((await validator.validate(token)).payload.sub).toBe("alice");
    await expect(validator.validate(`${token}a`)).rejects.toBeInstanceOf(JwtMalformedError);
    const unavailable: SigningAlgorithm = { alg: "HS256", canSign: true, sign: async () => { throw new Error("crypto must not be called"); }, verify: async () => { throw new Error("crypto must not be called"); } };
    await expect(new JwtValidator(unavailable).validate("a".repeat(1_000_000))).rejects.toBeInstanceOf(JwtMalformedError);
    await expect(new JwtEncoder(unavailable, { maxTokenLength: 64 }).encode(data)).rejects.toBeInstanceOf(RangeError);
    await expect(new JwtEncoder(key.algorithm, { maxTokenLength: token.length - 1 }).encode(data)).rejects.toBeInstanceOf(RangeError);
  });

  test("invalid limits fail at construction; larger explicit policies support large tokens", async () => {
    const key = entry("key").algorithm;
    for (const maxTokenLength of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "100"] as unknown as number[]) {
      expect(() => new JwtValidator(key, { maxTokenLength })).toThrow(RangeError);
      expect(() => new JwtEncoder(key, { maxTokenLength })).toThrow(RangeError);
    }
    const issuer = new TokenIssuer({ ...options, algorithm: key, accessTtlSeconds: 10, refreshTtlSeconds: 20, maxTokenLength: 32_768 });
    const pair = await issuer.issue("alice", { data: "x".repeat(14_000) });
    expect(pair.accessToken.length).toBeGreaterThan(16_384);
    expect(String((await issuer.verifyAccess(pair.accessToken)).payload.data).length).toBe(14_000);
    await expect(new JwtValidator(key, options).validate(pair.accessToken)).rejects.toBeInstanceOf(JwtMalformedError);
  });
});

function delayedAlgorithm() {
  const key = entry("unused").algorithm;
  let wait: Promise<void> | undefined; let release = () => {};
  return {
    algorithm: { alg: key.alg, canSign: true,
      sign: async (input: string) => { await wait; return key.sign(input); },
      verify: async (input: string, signature: Uint8Array) => { await wait; return key.verify(input, signature); },
    },
    pause() { wait = new Promise<void>(resolve => { release = () => { wait = undefined; resolve(); }; }); },
    release() { release(); },
  };
}
