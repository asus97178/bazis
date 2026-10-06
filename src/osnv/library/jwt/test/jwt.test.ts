import { describe, expect, test } from "bun:test";
import {
  generateRsaKeyPairPem,
  hs256,
  Hs256Algorithm,
  JwtAlgorithmError,
  JwtClaimError,
  JwtEncoder,
  JwtExpiredError,
  JwtMalformedError,
  JwtSignatureError,
  JwtValidator,
  RegisteredClaims,
  rs256,
  TOKEN_USE_CLAIM,
  TokenIssuer,
  TokenService,
  base64UrlDecode,
  base64UrlEncode,
  timingSafeEqual,
} from "@/library/jwt";

const SECRET = "01234567890123456789012345678901"; // 32 bytes

function futureExp(seconds = 600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

describe("base64url", () => {
  test("round-trips bytes without url-unsafe chars", () => {
    const input = new Uint8Array([0, 1, 2, 250, 255]);
    const encoded = base64UrlEncode(input);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect([...base64UrlDecode(encoded)]).toEqual([...input]);
  });

  test("timingSafeEqual compares contents", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("Hs256Algorithm", () => {
  test("rejects short keys", () => {
    expect(() => new Hs256Algorithm("too-short")).toThrow(RangeError);
  });

  test("encode + validate round-trip", async () => {
    const alg = hs256(SECRET);
    const token = await new JwtEncoder(alg).encode({ sub: "u1", role: "x", exp: futureExp() });
    const { payload, header } = await new JwtValidator(alg).validate(token);
    expect(header.alg).toBe("HS256");
    expect(payload.sub).toBe("u1");
    expect(payload.role).toBe("x");
  });

  test("rejects tampered signature", async () => {
    const alg = hs256(SECRET);
    const token = await new JwtEncoder(alg).encode({ sub: "u1" });
    const [h, p, s] = token.split(".") as [string, string, string];
    // Change significant signature bits, not potentially unused base64url padding bits.
    const tampered = `${h}.${p}.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`;
    await expect(new JwtValidator(alg).validate(tampered)).rejects.toBeInstanceOf(JwtSignatureError);
  });

  test("rejects algorithm confusion", async () => {
    const token = await new JwtEncoder(hs256(SECRET)).encode({ sub: "u1" });
    const { publicKeyPem } = await generateRsaKeyPairPem();
    const rsaValidator = new JwtValidator(rs256({ publicKeyPem }));
    await expect(rsaValidator.validate(token)).rejects.toBeInstanceOf(JwtAlgorithmError);
  });

  test("rejects malformed token", async () => {
    await expect(new JwtValidator(hs256(SECRET)).validate("not.a.jwt.token")).rejects.toBeInstanceOf(
      JwtMalformedError,
    );
  });
});

describe("JwtValidator claims", () => {
  const alg = hs256(SECRET);

  test("enforces issuer and audience", async () => {
    const token = await new JwtEncoder(alg).encode({ iss: "auth", aud: "user", sub: "u1", exp: futureExp() });
    await expect(
      new JwtValidator(alg, { issuer: "other" }).validate(token),
    ).rejects.toBeInstanceOf(JwtClaimError);
    await expect(
      new JwtValidator(alg, { audience: "admin" }).validate(token),
    ).rejects.toBeInstanceOf(JwtClaimError);
    const ok = await new JwtValidator(alg, { issuer: "auth", audience: ["user", "x"] }).validate(token);
    expect(ok.payload.sub).toBe("u1");
  });

  test("rejects expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new JwtEncoder(alg).encode({ sub: "u1", exp: now - 120 });
    await expect(new JwtValidator(alg, { clockSkewSeconds: 0 }).validate(token)).rejects.toBeInstanceOf(
      JwtExpiredError,
    );
  });

  test("requires exp by default and allows explicit legacy validation", async () => {
    const token = await new JwtEncoder(alg).encode({ sub: "u1" });
    await expect(new JwtValidator(alg).validate(token)).rejects.toBeInstanceOf(JwtClaimError);
    const ok = await new JwtValidator(alg, { requireExpiration: false }).validate(token);
    expect(ok.payload.sub).toBe("u1");
  });

  test("rejects non-numeric exp", async () => {
    const token = await new JwtEncoder(alg).encode({ sub: "u1", exp: "soon" });
    await expect(new JwtValidator(alg).validate(token)).rejects.toBeInstanceOf(JwtClaimError);
  });

  test("enforces token_use", async () => {
    const token = await new JwtEncoder(alg).encode({ sub: "u1", exp: futureExp(), [TOKEN_USE_CLAIM]: "refresh" });
    await expect(
      new JwtValidator(alg, { expectedTokenUse: "access" }).validate(token),
    ).rejects.toBeInstanceOf(JwtClaimError);
  });
});

describe("RS256", () => {
  test("signs with private key, verifies with public key only", async () => {
    const { privateKeyPem, publicKeyPem } = await generateRsaKeyPairPem();
    const signer = rs256({ privateKeyPem, publicKeyPem, keyId: "k1" });
    const verifier = rs256({ publicKeyPem });
    const token = await new JwtEncoder(signer).encode({ sub: "rsa-user", exp: futureExp() });
    const { header, payload } = await new JwtValidator(verifier).validate(token);
    expect(header.kid).toBe("k1");
    expect(payload.sub).toBe("rsa-user");
    expect(verifier.canSign).toBe(false);
  });

  test("enforces kid when verifier config has keyId", async () => {
    const { privateKeyPem, publicKeyPem } = await generateRsaKeyPairPem();
    const signer = rs256({ privateKeyPem, publicKeyPem, keyId: "k1" });
    const token = await new JwtEncoder(signer).encode({ sub: "rsa-user", exp: futureExp() });

    await expect(new JwtValidator(rs256({ publicKeyPem, keyId: "other" })).validate(token)).rejects.toBeInstanceOf(
      JwtClaimError,
    );
    const ok = await new JwtValidator(rs256({ publicKeyPem, keyId: "k1" })).validate(token);
    expect(ok.payload.sub).toBe("rsa-user");
  });
});

describe("TokenIssuer", () => {
  function issuer(): TokenIssuer {
    return new TokenIssuer({
      issuer: "osnv",
      audience: "user",
      algorithm: hs256(SECRET),
      accessTtlSeconds: 900,
      refreshTtlSeconds: 1_209_600,
      clockSkewSeconds: 0,
    });
  }

  test("issues a verifiable access + refresh pair", async () => {
    const svc = issuer();
    const pair = await svc.issue("u1", { role: "member" });
    expect(pair.tokenType).toBe("Bearer");
    expect(pair.expiresIn).toBe(900);

    const access = await svc.verifyAccess(pair.accessToken);
    expect(access.payload.sub).toBe("u1");
    expect(access.payload.role).toBe("member");
    expect(access.payload[TOKEN_USE_CLAIM]).toBe("access");

    const refresh = await svc.verifyRefresh(pair.refreshToken);
    expect(refresh.payload[TOKEN_USE_CLAIM]).toBe("refresh");
  });

  test("refresh token cannot be used as access token and vice versa", async () => {
    const svc = issuer();
    const pair = await svc.issue("u1");
    await expect(svc.verifyAccess(pair.refreshToken)).rejects.toBeInstanceOf(JwtClaimError);
    await expect(svc.verifyRefresh(pair.accessToken)).rejects.toBeInstanceOf(JwtClaimError);
  });

  test("rotate verifies refresh and mints a new pair", async () => {
    const svc = issuer();
    const first = await svc.issue("u1");
    const rotated = await svc.rotate(first.refreshToken);
    const access = await svc.verifyAccess(rotated.accessToken);
    expect(access.payload.sub).toBe("u1");
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
  });
});

describe("TokenService: token kinds are isolated", () => {
  test("USER and ADMIN tokens are not interchangeable", async () => {
    const tokens = new TokenService({
      user: {
        issuer: "osnv",
        audience: "user",
        algorithm: hs256("user-secret-user-secret-user-sec!"),
        accessTtlSeconds: 900,
        refreshTtlSeconds: 1_209_600,
        clockSkewSeconds: 0,
      },
      admin: {
        issuer: "osnv",
        audience: "admin",
        algorithm: hs256("admin-secret-admin-secret-admin!"),
        accessTtlSeconds: 600,
        refreshTtlSeconds: 86_400,
        clockSkewSeconds: 0,
      },
    });

    expect([...tokens.kinds()].sort()).toEqual(["admin", "user"]);

    const userPair = await tokens.forKind("user").issue("u1");

    // Different signing key → signature rejected by admin validator.
    await expect(tokens.forKind("admin").verifyAccess(userPair.accessToken)).rejects.toBeInstanceOf(
      JwtSignatureError,
    );
    // Sanity: the right kind accepts it.
    const ok = await tokens.forKind("user").verifyAccess(userPair.accessToken);
    expect(ok.payload[RegisteredClaims.Audience]).toBe("user");
  });

  test("multiple isolated kinds, all with refresh", async () => {
    const KINDS = ["user", "admin", "employee", "system"] as const;
    const config = (audience: string) => ({
      issuer: "osnv",
      audience,
      algorithm: hs256(`${audience}-`.padEnd(40, "k")),
      accessTtlSeconds: 600,
      refreshTtlSeconds: 86_400,
      clockSkewSeconds: 0,
    });
    const tokens = new TokenService<(typeof KINDS)[number]>({
      user: config("user"),
      admin: config("admin"),
      employee: config("employee"),
      system: config("system"),
    });

    expect([...tokens.kinds()].sort()).toEqual(["admin", "employee", "system", "user"]);

    for (const kind of KINDS) {
      const pair = await tokens.forKind(kind).issue(`subject-${kind}`);
      const access = await tokens.forKind(kind).verifyAccess(pair.accessToken);
      const refresh = await tokens.forKind(kind).verifyRefresh(pair.refreshToken);
      expect(access.payload[RegisteredClaims.Audience]).toBe(kind);
      expect(refresh.payload[TOKEN_USE_CLAIM]).toBe("refresh");
    }

    // A system access token is rejected by every other kind's validator.
    const system = await tokens.forKind("system").issue("svc-1");
    await expect(tokens.forKind("user").verifyAccess(system.accessToken)).rejects.toBeInstanceOf(
      JwtSignatureError,
    );
  });

  test("unknown kind throws", () => {
    const tokens = new TokenService({
      user: {
        issuer: "osnv",
        audience: "user",
        algorithm: hs256(SECRET),
        accessTtlSeconds: 900,
        refreshTtlSeconds: 1_209_600,
      },
    });
    expect(() => tokens.forKind("admin" as "user")).toThrow();
  });
});
