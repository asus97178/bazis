// In-memory storage can compact deletion history without confusing a fresh
// session with an old snapshot, including many creations in the same millisecond.
// This token is internal metadata; distributed adapters use their own CAS/TTL.
const incarnation = `${crypto.randomUUID()}:`;
let sequence = 0;

export function issueSessionCreationToken(): string {
  if (!Number.isSafeInteger(++sequence)) throw new Error("WebSocket creation sequence exhausted.");
  return `${incarnation}${sequence}`;
}

export function localSessionCreationOrder(token: string | undefined): number | undefined {
  if (typeof token !== "string" || !token.startsWith(incarnation)) return undefined;
  const order = Number(token.slice(incarnation.length));
  return Number.isSafeInteger(order) && order > 0 && order <= sequence ? order : undefined;
}
