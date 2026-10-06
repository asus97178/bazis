import { InspectableRedirectProtocol as protocol } from "../../../library/http-client";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Called after the normal middleware chain, before transferring the scope. */
export function inspectableRedirectResponse(response: Response, request: Request): Response {
  const negotiated = request.headers.get(protocol.header) === protocol.version;
  const redirect = negotiated && REDIRECT_STATUSES.has(response.status) && response.headers.has("location");
  const headers = new Headers(response.headers);
  appendHeaderToken(headers, "vary", protocol.header);
  // These names belong to this transport; application headers cannot forge
  // a redirect status on an ordinary response.
  headers.delete(protocol.header);
  headers.delete(protocol.statusHeader);
  if (negotiated) {
    headers.set(protocol.header, protocol.version);
    headers.set("cache-control", "no-store");
    for (const name of [protocol.header, protocol.statusHeader, "location"]) {
      appendHeaderToken(headers, "access-control-expose-headers", name);
    }
    if (redirect) headers.set(protocol.statusHeader, String(response.status));
  }
  if (!redirect) {
    try {
      // Preserve the actual Response/Bun.file body path, including Range.
      for (const name of ["vary", protocol.header, protocol.statusHeader, "cache-control", "access-control-expose-headers"]) {
        const value = headers.get(name);
        if (value === null) response.headers.delete(name);
        else response.headers.set(name, value);
      }
      return response;
    } catch {
      // Fetch responses may have immutable headers. Keep their original stream.
    }
  }
  return new Response(response.body, {
    status: redirect ? 200 : response.status,
    statusText: redirect ? "OK" : response.statusText,
    headers,
  });
}

function appendHeaderToken(headers: Headers, name: string, token: string): void {
  const current = headers.get(name)?.split(",").map(value => value.trim().toLowerCase()) ?? [];
  if (current.includes(token.toLowerCase()) || (name === "vary" && current.includes("*"))) return;
  headers.append(name, token);
}
