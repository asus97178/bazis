import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { release } from "node:os";
import authority from "../../toolchain/bun.json";
import { hs256, rs256, generateRsaKeyPairPem, JwtEncoder, JwtValidator, JwtKeyRing, TokenIssuer, JwtError } from "../../src/osnova/library/jwt";

assert.equal(Bun.version, authority.runtime.version);
assert.equal(Bun.revision, authority.runtime.revision);
assert.equal(process.platform, "linux");
assert.equal(process.arch, "arm64");
const old = hs256(crypto.getRandomValues(new Uint8Array(32)));
const next = hs256(crypto.getRandomValues(new Uint8Array(32)));
const ring = await JwtKeyRing.create({ activeKeyId: "old", keys: [{ keyId: "old", algorithm: old }, { keyId: "next", algorithm: next }] });
const issuer = new TokenIssuer({ algorithm: ring, issuer: "stand-probe", audience: "admin", accessTtlSeconds: 600, refreshTtlSeconds: 3600, clockSkewSeconds: 0 });
const previous = await issuer.issue("probe");
assert.equal((await issuer.verifyAccess(previous.accessToken)).payload.sub, "probe");
await assert.rejects(issuer.verifyAccess(previous.refreshToken), JwtError);
await ring.replace({ activeKeyId: "next", keys: [{ keyId: "old", algorithm: old }, { keyId: "next", algorithm: next }] });
const current = await issuer.issue("probe");
await issuer.verifyAccess(previous.accessToken);
ring.revoke("old");
await assert.rejects(issuer.verifyAccess(previous.accessToken), JwtError);
await issuer.verifyAccess(current.accessToken);
await assert.rejects(issuer.verifyAccess(current.accessToken + "\n"), JwtError);
const rsaKeys = await generateRsaKeyPairPem();
const rsaToken = await new JwtEncoder(rs256({ ...rsaKeys, keyId: "rsa" })).encode({ sub: "probe-rsa", exp: Date.now() / 1000 + 60 });
assert.equal((await new JwtValidator(rs256({ publicKeyPem: rsaKeys.publicKeyPem, keyId: "rsa" })).validate(rsaToken)).payload.sub, "probe-rsa");
console.log(JSON.stringify({ status: "PASS", version: Bun.version, revision: Bun.revision, platform: process.platform,
  arch: process.arch, kernel: release(), executableSha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
  checked: ["HS256", "RS256 public-only", "access/refresh separation", "rotation overlap", "revocation", "malformed rejection"] }));
