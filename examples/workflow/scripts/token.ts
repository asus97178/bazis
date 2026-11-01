// An access token for trying the example: `bun run token anna manager`. Uses the development key.
import { hs256, TokenIssuer } from "bazis/library/jwt";

const [user, role] = process.argv.slice(2);
if (user === undefined || role === undefined) throw new Error("Usage: bun run token <user> <roles>");
const issuer = new TokenIssuer({ issuer: "orders", audience: "user", algorithm: hs256("dev-only-secret-at-least-32-bytes!!"), accessTtlSeconds: 3600, refreshTtlSeconds: 86400 });
console.log((await issuer.issue(user, { role })).accessToken);
