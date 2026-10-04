import { describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  base64UrlDecode, base64UrlDecodeToString, base64UrlEncode, base64UrlEncodeString,
  hs256, rs256, JwtEncoder, JwtValidator, JwtMalformedError, JwtClaimError,
  JwtSignatureError, JwtExpiredError, JwtNotYetValidError, TokenIssuer,
  type JwtValidationOptions, type TokenIssuerConfig, type SigningAlgorithm,
} from "../index";

const SECRET = "jwt-regression-synthetic-key-32!!";
const algorithm = hs256(SECRET);
const options = { issuer: "test", audience: "client", expectedTokenUse: "access", clockSkewSeconds: 0 } as const;
const future = () => Math.floor(Date.now() / 1000) + 600;
const payload = (extra: Record<string, unknown> = {}) => ({
  iss: "test", aud: "client", sub: "u1", token_use: "access", exp: future(), ...extra,
});
function rawToken(payloadJson: string, headerJson = '{"alg":"HS256","typ":"JWT"}', key: string | Uint8Array = SECRET): string {
  const input = base64UrlEncodeString(headerJson) + "." + base64UrlEncodeString(payloadJson);
  return input + "." + createHmac("sha256", key).update(input).digest("base64url");
}
function token(value: unknown = payload(), header: unknown = { alg: "HS256", typ: "JWT" }): string {
  return rawToken(JSON.stringify(value), JSON.stringify(header));
}
function issuerConfig(extra: Partial<TokenIssuerConfig> = {}): TokenIssuerConfig {
  return { issuer: "test", audience: "client", algorithm, accessTtlSeconds: 600, refreshTtlSeconds: 3600, clockSkewSeconds: 0, ...extra };
}
function validator(extra: JwtValidationOptions = {}): JwtValidator {
  return new JwtValidator(algorithm, { ...options, ...extra });
}

describe("JWT strict format", () => {
  test("base64url round trips all byte values and empty input", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 255, 256, 257]) {
      const bytes = Uint8Array.from({ length }, (_, i) => i & 255);
      expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    }
    const text = "\uFEFFПривет, 🌍";
    expect(base64UrlDecodeToString(base64UrlEncodeString(text))).toBe(text);
  });

  for (const encoded of ["A", "AA==", "AA+", "AA/", "A A", "AA\n", "AAA\n", "AA\r\n", "AA!", "AB", "AAB"]) {
    test("rejects invalid base64url " + JSON.stringify(encoded), () => {
      expect(() => base64UrlDecode(encoded)).toThrow();
    });
  }

  for (const value of [null, [], "text", 123, false]) {
    test("rejects non-object header " + JSON.stringify(value), async () => {
      await expect(validator().validate(token(payload(), value))).rejects.toBeInstanceOf(JwtMalformedError);
    });
    test("rejects non-object payload even without exp " + JSON.stringify(value), async () => {
      await expect(new JwtValidator(algorithm, { requireExpiration: false }).validate(token(value))).rejects.toBeInstanceOf(JwtMalformedError);
    });
  }

  test("rejects non-string token and empty segments with JwtMalformedError", async () => {
    for (const raw of [null, 17, {}, "", "x.y", ".e30.AA", "e30..AA", "e30.e30."]) {
      await expect(validator().validate(raw as string)).rejects.toBeInstanceOf(JwtMalformedError);
    }
  });

  test("signature formatting fails as a JWT error without replacing cryptographic errors", async () => {
    const [h, p, s] = token().split(".") as [string, string, string];
    for (const signature of ["!", s.slice(0, 4) + " " + s.slice(4), s + "=", s + "\n"]) {
      await expect(validator().validate(h + "." + p + "." + signature)).rejects.toBeInstanceOf(JwtMalformedError);
    }
    await expect(validator().validate(h + "." + p + "." + base64UrlEncode(new Uint8Array(32)))).rejects.toBeInstanceOf(JwtSignatureError);
  });

  test("invalid UTF-8 is rejected in both header and signed payload", async () => {
    const badJson = (prefix: string, suffix: string) => base64UrlEncode(new Uint8Array([
      ...new TextEncoder().encode(prefix), 0xff, ...new TextEncoder().encode(suffix),
    ]));
    const validHeader = base64UrlEncodeString('{"alg":"HS256"}');
    const validPayload = base64UrlEncodeString(JSON.stringify(payload()));
    for (const [h, p] of [
      [badJson('{"alg":"HS256","kid":"', '"}'), validPayload],
      [validHeader, badJson('{"sub":"', '","exp":' + future() + "}")],
    ]) {
      const input = h + "." + p;
      const raw = input + "." + createHmac("sha256", SECRET).update(input).digest("base64url");
      await expect(new JwtValidator(algorithm).validate(raw)).rejects.toBeInstanceOf(JwtMalformedError);
    }
  });

  for (const extra of [
    { crit: ["extension"], extension: true }, { crit: [] }, { crit: null }, { crit: "extension" },
    { b64: false }, { b64: "true" }, { alg: null }, { kid: 12 }, { typ: null }, { cty: false },
  ]) {
    test("rejects unsupported or malformed JOSE fields " + JSON.stringify(extra), async () => {
      await expect(validator().validate(token(payload(), { alg: "HS256", typ: "JWT", ...extra }))).rejects.toBeInstanceOf(JwtMalformedError);
    });
  }

  test("accepts optional typ, ordinary extensions and duplicate claims with last-value semantics", async () => {
    for (const header of [{ alg: "HS256" }, { alg: "HS256", typ: "at+jwt", b64: true, extension: "ignored" }]) {
      expect((await validator().validate(token(payload(), header))).payload.sub).toBe("u1");
    }
    const json = '{"sub":"old","sub":"new","exp":' + future() + "}";
    expect((await new JwtValidator(algorithm).validate(rawToken(json))).payload.sub).toBe("new");
  });
});

describe("JWT claims and clock", () => {
  for (const name of ["exp", "nbf", "iat"]) {
    test(name + " requires a finite NumericDate when present", async () => {
      for (const value of [null, "3000000000", true, [], {}]) {
        await expect(validator().validate(token(payload({ [name]: value })))).rejects.toBeInstanceOf(JwtClaimError);
      }
      for (const literal of ["1e400", "-1e400"]) {
        const json = JSON.stringify(payload({ [name]: 0 })).replace('"' + name + '":0', '"' + name + '":' + literal);
        await expect(validator().validate(rawToken(json))).rejects.toBeInstanceOf(JwtClaimError);
      }
    });
  }

  for (const name of ["iss", "sub", "jti"]) {
    test(name + " is a string even without an expected value", async () => {
      for (const value of [null, 42, false, [], {}]) {
        await expect(new JwtValidator(algorithm).validate(token(payload({ [name]: value })))).rejects.toBeInstanceOf(JwtClaimError);
      }
    });
  }

  test("audience never coerces values and validates every array member", async () => {
    for (const audience of [null, 123, [], [123], ["client", 123], [["client"]], { toString: "client" }]) {
      await expect(validator().validate(token(payload({ aud: audience })))).rejects.toBeInstanceOf(JwtClaimError);
    }
    await expect(validator({ audience: "123" }).validate(token(payload({ aud: [123] })))).rejects.toBeInstanceOf(JwtClaimError);
    expect((await validator().validate(token(payload({ aud: ["other", "client"] })))).payload.sub).toBe("u1");
  });

  test("expiration and nbf use exact fractional boundaries and configured leeway", async () => {
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_500;
    try {
      const now = Date.now() / 1000;
      await expect(validator().validate(token(payload({ exp: now })))).rejects.toBeInstanceOf(JwtExpiredError);
      await expect(validator({ clockSkewSeconds: 2 }).validate(token(payload({ exp: now - 2 })))).rejects.toBeInstanceOf(JwtExpiredError);
      expect((await validator({ clockSkewSeconds: 2 }).validate(token(payload({ exp: now - 1.5 })))).payload.sub).toBe("u1");
      expect((await validator().validate(token(payload({ exp: now + 0.25, nbf: now, iat: now + 1 })))).payload.sub).toBe("u1");
      await expect(validator().validate(token(payload({ nbf: now + 0.25 })))).rejects.toBeInstanceOf(JwtNotYetValidError);
      expect((await validator({ clockSkewSeconds: 0.25 }).validate(token(payload({ nbf: now + 0.25 })))).payload.sub).toBe("u1");
    } finally { Date.now = realNow; }
  });

  test("legacy option allows a missing exp but still checks a present exp and nbf", async () => {
    const legacy = new JwtValidator(algorithm, { requireExpiration: false, clockSkewSeconds: 0 });
    expect((await legacy.validate(token({ sub: "u1" }))).payload.sub).toBe("u1");
    await expect(legacy.validate(token({ exp: null }))).rejects.toBeInstanceOf(JwtClaimError);
    await expect(legacy.validate(token({ nbf: "tomorrow" }))).rejects.toBeInstanceOf(JwtClaimError);
  });
});

describe("JWT configuration ownership", () => {
  test("validation options reject malformed types, non-finite skew and sparse audiences", () => {
    const invalid: unknown[] = [
      null, [], { issuer: "" }, { issuer: null }, { audience: "" }, { audience: [] },
      { audience: [null] }, { audience: [123] }, { audience: new Array(1) },
      { expectedTokenUse: "unknown" }, { expectedTokenUse: null }, { requireExpiration: null },
      ...[NaN, Infinity, -Infinity, -1, "60", null].map(clockSkewSeconds => ({ clockSkewSeconds })),
    ];
    for (const value of invalid) expect(() => new JwtValidator(algorithm, value as JwtValidationOptions)).toThrow();
  });

  test("validation options and audience arrays are stable after caller mutation", async () => {
    const audience = ["client"];
    const mutable = { issuer: "test", audience, expectedTokenUse: "access", requireExpiration: true, clockSkewSeconds: 0 };
    const held = new JwtValidator(algorithm, mutable as JwtValidationOptions);
    mutable.issuer = "other";
    mutable.expectedTokenUse = "refresh";
    mutable.requireExpiration = false;
    mutable.clockSkewSeconds = Infinity;
    audience[0] = "admin";
    expect((await held.validate(token())).payload.sub).toBe("u1");
    await expect(held.validate(token(payload({ aud: "admin" })))).rejects.toBeInstanceOf(JwtClaimError);
    await expect(held.validate(token({ iss: "test", aud: "client", token_use: "access" }))).rejects.toBeInstanceOf(JwtClaimError);
  });

  test("issuer validates both TTLs and required config fields before use", () => {
    for (const field of ["accessTtlSeconds", "refreshTtlSeconds"]) {
      for (const value of [-1, 0, NaN, Infinity, -Infinity, null, "600"]) {
        expect(() => new TokenIssuer({ ...issuerConfig(), [field]: value } as TokenIssuerConfig)).toThrow();
      }
    }
    for (const value of [null, [], { ...issuerConfig(), issuer: "" }, { ...issuerConfig(), audience: null }, { ...issuerConfig(), refreshAlgorithm: null }]) {
      expect(() => new TokenIssuer(value as TokenIssuerConfig)).toThrow();
    }
  });

  test("issuer snapshots configuration and preserves fractional positive TTLs", async () => {
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_500;
    try {
      const mutable = { ...issuerConfig(), accessTtlSeconds: 0.25 };
      const held = new TokenIssuer(mutable);
      mutable.issuer = "other";
      mutable.audience = "admin";
      mutable.accessTtlSeconds = Infinity;
      mutable.algorithm = hs256("a-different-synthetic-secret-32!!");
      const pair = await held.issue("u1");
      const verified = await held.verifyAccess(pair.accessToken);
      expect(pair.expiresIn).toBe(0.25);
      expect(verified.payload.exp).toBe(Date.now() / 1000 + 0.25);
      expect(verified.payload.iat).toBe(Date.now() / 1000);
      expect((await held.verifyRefresh(pair.refreshToken)).payload.sub).toBe("u1");
    } finally { Date.now = realNow; }
  });

  test("invalid issue/rotate subjects use the JWT claim error contract", async () => {
    const issuer = new TokenIssuer(issuerConfig());
    for (const subject of ["", null, 12]) {
      await expect(issuer.issue(subject as string)).rejects.toBeInstanceOf(JwtClaimError);
    }
    await expect(issuer.rotate(token(payload({ sub: "", token_use: "refresh" })))).rejects.toBeInstanceOf(JwtClaimError);
  });

  test("operational signing strategy failure is preserved", async () => {
    const failure = new Error("synthetic provider unavailable");
    const failing: SigningAlgorithm = {
      alg: "HS256", canSign: true,
      sign: async () => { throw failure; },
      verify: async () => { throw failure; },
    };
    await expect(new JwtValidator(failing).validate(token())).rejects.toBe(failure);
    await expect(new TokenIssuer(issuerConfig({ algorithm: failing })).issue("u1")).rejects.toBe(failure);
  });
});

describe("JWT key ownership and RSA strength", () => {
  test("clearing caller Uint8Array, Buffer or subarray cannot replace the HMAC key", async () => {
    const backing = new Uint8Array(48).fill(77);
    for (const bytes of [new Uint8Array(32).fill(65), Buffer.alloc(32, 66), backing.subarray(8, 40)]) {
      const original = new Uint8Array(bytes);
      const held = hs256(bytes);
      bytes.fill(0);
      const valid = rawToken(JSON.stringify(payload()), undefined, original);
      const forged = rawToken(JSON.stringify(payload()), undefined, new Uint8Array(32));
      expect((await new JwtValidator(held, options).validate(valid)).payload.sub).toBe("u1");
      await expect(new JwtValidator(held, options).validate(forged)).rejects.toBeInstanceOf(JwtSignatureError);
      const signed = await new JwtEncoder(held).encode({ sub: "u1", exp: future() });
      expect((await new JwtValidator(hs256(original)).validate(signed)).payload.sub).toBe("u1");
    }
  });

  test("RSA-1024 is rejected independently on sign and verify-only paths", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const signer = rs256({ privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey });
    await expect(new JwtEncoder(signer).encode({ exp: future() })).rejects.toThrow("at least 2048 bits");
    const input = base64UrlEncodeString('{"alg":"RS256"}') + "." + base64UrlEncodeString(JSON.stringify(payload()));
    const raw = input + "." + sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url");
    await expect(new JwtValidator(rs256({ publicKeyPem: pair.publicKey })).validate(raw)).rejects.toThrow("at least 2048 bits");
    await expect(signer.exportPublicJwk()).rejects.toThrow("at least 2048 bits");
  });

  test("RSA material is snapshotted and RSA-2048 interoperates with node:crypto", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const mutable = { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey, keyId: "first" };
    const held = rs256(mutable);
    mutable.privateKeyPem = "changed";
    mutable.publicKeyPem = "changed";
    mutable.keyId = "second";
    const raw = await new JwtEncoder(held).encode({ sub: "u1", exp: future() });
    const [h, p, s] = raw.split(".") as [string, string, string];
    expect(verify("RSA-SHA256", Buffer.from(h + "." + p), pair.publicKey, Buffer.from(s, "base64url"))).toBe(true);
    expect((await new JwtValidator(held).validate(raw)).header.kid).toBe("first");
    expect((await held.exportPublicJwk()).kid).toBe("first");
    const input = base64UrlEncodeString('{"alg":"RS256","kid":"first"}') + "." + base64UrlEncodeString(JSON.stringify(payload()));
    const external = input + "." + sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url");
    expect((await new JwtValidator(held, options).validate(external)).payload.sub).toBe("u1");
  });
});
