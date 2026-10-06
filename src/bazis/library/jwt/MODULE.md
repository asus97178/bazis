# JWT

Passport version: 1.2. Date: 2026-09-14.
Type: an atomic library feature without its own DI module.
Path: src/bazis/library/jwt. Public entry: [index.ts](index.ts), bazis/library/jwt.
Status: JWT-01–JWT-06 are fixed; key rotation and operational checks were added.
Scope: keys and their lifecycle, validate, issue/rotate and the base64url helpers.
Calls with a single SigningAlgorithm are kept; JwtKeyRing and a size limit were added.
Scaffold creation: a historical library; the creation command is unknown. No new module is created.

## 1. Responsibility and structure

The library owns signing and verifying compact JWS, JWT claims and issuing an
access/refresh pair. It is one technical feature. SigningAlgorithm stays the
cryptography port; JwtValidator checks an untrusted token, TokenIssuer owns the issue
settings, TokenService picks the issuer by token kind.

HTTP, DI, roles, account state, refresh storage, session revocation and the choice of
environment belong to the application. There are no imports or DI exports; the
osnova application's [AuthModule](https://github.com/asus97178/osnova/blob/d01528af91e8aed69e21d5f5c8ac256a6f3f2fd0/src/app/modules/auth/Auth.module.ts) registers TokenService
through its existing factory. ORM, HTTP controllers, background services and AI are not used here.

OOP/SOLID and simplicity: the invariants stay with their existing owners; there are no
new submodules or external dependencies. Key and settings snapshots are created once.
The hot path is linear in the token size; Web Crypto keys are cached after import.
Unknown critical JOSE extensions are rejected: no handler for them is declared.
Binary execution uses the standard Web Crypto/TextEncoder/TextDecoder, without reading
sources or key files during verification.

## 2. Components

| Component | File | Responsibility / input |
| --- | --- | --- |
| Hs256Algorithm / hs256 | [signing/Hs256Algorithm.ts](signing/Hs256Algorithm.ts) | A secret snapshot, HMAC-SHA256; the signingInput string and the signature bytes |
| Rs256Algorithm / rs256 | [signing/Rs256Algorithm.ts](signing/Rs256Algorithm.ts) | A snapshot of the PEM settings; RSA import of at least 2048 bits, sign/verify/exportPublicJwk |
| JwtKeyRing | [JwtKeyRing.ts](JwtKeyRing.ts) | A trusted key set, preparation, atomic replacement, revocation and safe metadata |
| JwtValidator | [JwtValidator.ts](JwtValidator.ts) | A snapshot of the validation options, the strict format and registered claims |
| JwtEncoder | [JwtEncoder.ts](JwtEncoder.ts) | Serializes the given claims and signs; business rules of the claims belong to the caller |
| TokenIssuer | [TokenIssuer.ts](TokenIssuer.ts) | Checked configuration, subject, access/refresh, stateless rotate |
| TokenService | [TokenService.ts](TokenService.ts) | The registry of token kinds; the application assigns algorithms and audiences |
| base64url | [base64url.ts](base64url.ts) | Canonical base64url without padding; exact UTF-8 |
| limits | [limits.ts](limits.ts) | DEFAULT_MAX_TOKEN_LENGTH = 16384; the positive safe integer check |
| Errors and types | [errors.ts](errors.ts), [claims.ts](claims.ts) | Public JWT errors and the existing TypeScript contracts |

## 3. Keys and lifecycle

The application calls the algorithm constructors. Keys are trusted configuration,
not data from kid or other token fields. Network, JWKS discovery and file input are
not used. With a single strategy, kid is compared with the configured value; in
JwtKeyRing it selects exactly one trusted strategy from a local Map.

| Field | Type / format | Required | null / default | Checks and ownership |
| --- | --- | --- | --- | --- |
| secret | a UTF-8 string or Uint8Array | yes, HS256 | no / none | At least 32 bytes; an own copy, including Buffer/subarray |
| keys.publicKeyPem | string, SPKI PEM | yes, RS256 | no / none | A non-empty string; Web Crypto import; modulusLength >= 2048 |
| keys.privateKeyPem | string, PKCS#8 PEM | for sign | no / absent | A non-empty string when present; import and modulusLength >= 2048 |
| keys.keyId | string | no | no / absent | A non-empty string; a snapshot, written into kid |
| signingInput | string, header.payload | sign/verify | no / none | The UTF-8 bytes are passed to the crypto algorithm |
| signature | Uint8Array | verify | no / none | A signature mismatch returns false |

The minimum RSA size is checked on the lazy import before use.
Key configuration errors are TypeError/RangeError or Web Crypto errors.
They are not disguised as errors of an untrusted JWT. Keys are kept in the instance
memory; there is no API for cancellation, explicit CryptoKey cleanup or automatic
rotation. Importing again after a failure is possible on the next call; a partially
completed pair issue never returns a successful result.

### JwtKeyRing

The application calls `await JwtKeyRing.create(config)` before publishing TokenService.
`JwtEncoder`, `JwtValidator`, `TokenIssuerConfig.algorithm/refreshAlgorithm` accept this
object instead of a single strategy. While preparing a signing key, it signs a random
service string: the correct signature must verify, and a changed message must be
rejected. A public-only key is imported by verifying an empty signature, which must
give false. This checks that the key is usable, but does not replace trust in the
SigningAlgorithm implementation.

| Field | Type / source | Required | null / default | Check / example |
| --- | --- | --- | --- | --- |
| config.keys | readonly JwtKeyEntry[], the create/replace argument | yes | no / none | 1…32 elements |
| config.keys[].keyId | string, trusted configuration | yes | no / none | 1…128 ASCII letters/digits/`._-`; unique; `auth-2026-09` |
| config.keys[].algorithm | SigningAlgorithm | yes | no / none | A non-empty alg other than none; boolean canSign; sign/verify; algorithm.keyId matches when present |
| config.activeKeyId | string | for issuing | no / absent | The id of an existing canSign key; without the field the ring only verifies |
| config.legacy | object {keyId, acceptUntil} | no | no / absent | An explicit migration of JWTs without kid; both nested fields are required |
| config.legacy.keyId | string | with legacy | no / none | One existing key, id format as above |
| config.legacy.acceptUntil | number, Unix seconds | with legacy | no / none | A finite number > 0; when now >= acceptUntil a JWT without kid is rejected |
| revoke(keyId) | string, an operator command | yes | no / none | The same id check; a boolean result: whether the key was in the set |

`replace(config): Promise<void>` checks the new snapshot, then replaces the current one
with a single assignment. A preparation error keeps the current snapshot. A concurrent
replace/revoke changes the revision; a late preparation is rejected with a plain Error,
with no automatic retry. For a planned rotation pass the old and the new keys, with
activeKeyId pointing to the new one. Strategy instances that stay are not imported
again. Key lookup is O(1), and token processing is bounded by length.

`revoke` synchronously removes the key, revokes its id and stops further issuing if
it was active. Finishing encode/validate calls recheck the chosen key after await; a
removed key gives JwtClaimError. Already finished operations are not cancelled. Ids
removed by replace also cannot return to this instance; new keys use new ids. A new
id is mandatory when the algorithm changes. The application must not replace the key
material under an existing id: the library does not compare the hidden private keys
of user SigningAlgorithm implementations.

`status()` without arguments returns the frozen revision:number,
activeKeyId:string|undefined, keys:readonly {keyId,alg,canSign}[] and an optional
frozen legacy:{keyId,acceptUntil}. There are no secrets or PEM in the result.
`signingKey`, `verificationKey`, `assertCurrent` are internal Encoder/Validator
methods, not an application authorization API.
An invalid configuration gives TypeError; crypto/self-test/conflict give provider
errors or Error. An unknown kid or a missing kid without an active legacy gives
JwtClaimError, an alg substitution gives JwtAlgorithmError. No brute force over all
keys and no fetching of jku/x5u/jwk from the JWT happen. Unknown configuration fields are not used.

Legacy is off by default. When set, only a missing kid selects the one given key until
the fixed acceptUntil; an unknown or empty kid uses no fallback. The signature, alg and
all claims stay mandatory per the validator settings. The deadline/choice is rechecked
after crypto, and clock skew is not added to that deadline. New JWTs get activeKeyId.
Removing the key or legacy from the snapshot ends the migration; revoking the legacy
key also removes its legacy policy.

The ring state belongs to the process. Distributing the set and the revocation list,
storing them safely and restoring them after a restart belong to the host.
The mandatory rollout sequence, TTL/clock skew and the actions on compromise:
[operations guide](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-jwt/OPERATIONS.md).

## 4. Settings and public operations

### JwtValidator(algorithm, options?) and validate(token)

algorithm is a SigningAlgorithm or a prepared JwtKeyRing, a mandatory trusted strategy.
options is an object, {} by default; null and an array are not allowed. Known fields
and the audience array are copied at creation; unknown fields are not used.

| options field | Type | Required | null / default | Check |
| --- | --- | --- | --- | --- |
| issuer | string | no | no / absent | A non-empty string, exact iss comparison |
| audience | string or readonly string[] | no | no / absent | Non-empty strings; a non-empty array; at least one audience matches |
| expectedTokenUse | access or refresh | no | no / absent | Exact token_use comparison |
| clockSkewSeconds | number, seconds | no | no / 60 | A finite number >= 0; no automatic conversion and no upper bound |
| requireExpiration | boolean | no | no / true | false turns off only the exp requirement |
| maxTokenLength | number, ASCII characters of the compact JWS | no | no / 16384 | A positive safe integer; rejection before split/JSON/crypto |
| token | string, compact JWS | yes, validate | no / none | Three non-empty segments; base64url without spaces, padding and non-canonical pad bits |

Settings example: { issuer: "auth", audience: ["client"], expectedTokenUse: "access", clockSkewSeconds: 0 }.
The constructor rejects invalid settings with TypeError/RangeError.

The header and payload must decode to JSON objects, not null/arrays.
The signature is verified before the payload is used for claims. Unknown regular
fields are kept; JSON.parse uses the last value of a duplicate key.
Unknown critical extensions and an unencoded payload are not supported.

| Token field | Runtime type / rule | Required |
| --- | --- | --- |
| header.alg | string, matches algorithm.alg | yes |
| header.kid | string; matches algorithm.keyId if it is set | conditional |
| header.typ / header.cty | string when present; they do not grant rights | no |
| header.crit | an unsupported extension; its presence is rejected | not allowed |
| header.b64 | only true is allowed; false/an unencoded payload is not supported | no |
| payload.exp | a finite NumericDate; now < exp + clockSkewSeconds | yes by default |
| payload.nbf | a finite NumericDate; now + clockSkewSeconds >= nbf | no |
| payload.iat | a finite NumericDate; the type is checked, not the token age | no |
| payload.iss / sub / jti | string when present; no type coercion | iss is required with options.issuer |
| payload.aud | a string or a non-empty array of strings; no element coercion | with options.audience |
| payload.token_use | exactly expectedTokenUse if it is set | conditional |

null is not allowed for the listed fields when present. NumericDate is Unix seconds;
fractional values are allowed. There is no age limit by iat.
Unknown custom claims are not interpreted; applications validate their own fields.
The existing JwtHeader describes the header issued by the encoder (typ: JWT);
checking the incoming typ does not replace an application JWT profile.

The validate result: Promise<VerifiedToken> with the original decoded header/payload.
JwtMalformedError: format/UTF-8/JOSE; JwtAlgorithmError: alg;
JwtSignatureError: a wrong signature; JwtClaimError: a claim or kid type/value;
JwtExpiredError/JwtNotYetValidError: time. Cryptographic operational failures pass
through as provider errors. The HTTP adapter maps JwtError to 401.

### TokenIssuer(config), issue(subject, claims?), verifyAccess, verifyRefresh, rotate

config is a mandatory object; the known fields are fixed at creation.

| Field | Type | Required | null / default | Checks |
| --- | --- | --- | --- | --- |
| config.issuer / audience | string | yes | no / none | Non-empty strings, without trim |
| config.algorithm | SigningAlgorithm or JwtKeyRing | yes | no / none | A strategy with a signing key or a prepared set |
| config.refreshAlgorithm | SigningAlgorithm or JwtKeyRing | no | no / algorithm | A separate strategy or a set of refresh keys |
| config.accessTtlSeconds / refreshTtlSeconds | number, seconds | yes | no / none | Finite numbers > 0; fractions are allowed |
| config.clockSkewSeconds | number, seconds | no | no / 60 | As in JwtValidator |
| config.maxTokenLength | number | no | no / 16384 | As in JwtValidator; also the limit of the issued token |
| subject | string | yes, issue | no / none | A non-empty string; the caller sets the server identity |
| claims | CustomClaims | no | no / absent | Extra access fields; the built-in sub/iss/aud/iat/exp/jti/token_use override fields of the same name |
| token / refreshToken | string, compact JWS | yes, verify/rotate | no / none | The general validate rules plus issuer/audience/token_use |

CustomClaims is the existing dictionary of string, number, boolean, readonly string[]
or null values. User registered fields must follow the validator's runtime rules; the
encoder is not their separate validator.

issue/rotate return Promise<TokenPair>: accessToken and refreshToken are strings,
tokenType is Bearer, expiresIn is accessTtlSeconds. verify returns VerifiedToken.
Token errors are JwtError; a settings/keys error is not treated as an invalid account.
A missing subject on rotate also gives JwtClaimError.

Every issue creates new jti values. rotate does not revoke the original refresh;
idempotency, reuse detection and storage transactions belong to the application.
The method signatures and the TypeScript/DI exports are kept.

`JwtEncoder(algorithm, { maxTokenLength? })` has the same limit. Exceeding it on
encode/issue gives RangeError; exceeding it on validate/verify gives JwtMalformedError.
**Behavior change:** the library used to accept tokens without a size limit.
A consumer of tokens larger than 16 KiB must set a suitable limit explicitly on both
sides. Trusted claims are serialized before the issue size check; limiting the HTTP
body stays the transport's job.

### Helpers base64url

encode(Uint8Array)/encodeString(string) return unpadded base64url.
decode(string) returns a Uint8Array; an empty string is allowed only in the helper.
An invalid alphabet, length or pad bits give a format error. decodeToString accepts
only valid UTF-8 and keeps a BOM as a character. JwtValidator maps the errors of these
helpers on its untrusted input to JwtMalformedError.
timingSafeEqual stays a compatible export; HMAC verify uses Web Crypto.

## 5. Checks and limits

The current result after connecting the regular Auth and the bounded legacy migration:
[INTEGRATION.md](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-jwt/INTEGRATION.md).
The numbers below refer to the earlier qualification snapshot before that connection.

JWT, regressions, the HTTP boundary, config isolation/TTL and Admin access validation:
**103 PASS / 0 FAIL / 388 assertions**. The existing Admin HTTP/PostgreSQL suite:
**8 PASS / 0 FAIL / 51 assertions**. The two-process scenario with key rotation,
reuse, revocation, restart, database errors and load: **1 PASS / 0 FAIL / 289 assertions**
both from TypeScript and on two binaries. A standalone HS256/RS256 JWT binary also ran
outside the source directory. This is the Auth host, not the full AppModule/CLI.

Fuzzing: **100000 expected rejections + 3334 valid controls, 0 unexpected results**.
A separate tsc of the affected graph and the final full tsc: PASS.
Load c1/16/64 and an HS256 soak of 120 s with 23 rotations: PASS against predefined
local engineering thresholds, without claiming a production SLA. The peak RSS growth
after warm-up was 5.75 MiB; this does not prove the absence of all leaks.

Evidence, commands, SHA-256 and limits:
[qualification](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-jwt/QUALIFICATION.md).
The history of the original six fixes and 30 audit probes:
[FIXES.md](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-jwt/FIXES.md).
There is no independent external review, production key rollout or SLO.
The DI constructors did not change; codegen results were not edited by hand.

## 6. Sources

- [Initial JWT audit](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-jwt/REPORT.md).
- [Module architecture](../../../../docs/architecture/MODULE_ARCHITECTURE.md).
- [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html).
- [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515.html).
- [RFC 7518](https://www.rfc-editor.org/rfc/rfc7518.html).
