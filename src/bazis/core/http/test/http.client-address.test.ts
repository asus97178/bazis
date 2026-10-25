import { describe, expect, test } from "bun:test";
import { HttpSetupError } from "../Errors/HttpError";
import { clientAddress, trustedProxies } from "../HttpContext/clientAddress";

// 0.120.0: behind nginx ctx.clientIp was nginx's address. The forwarded
// address is believed only from a trusted proxy, so a client that reaches the
// app directly cannot forge it.
const nginx = trustedProxies(["127.0.0.1", "10.0.0.0/8", "fd00::/8"]);

describe("client address behind trusted proxies", () => {
  test("a trusted proxy's X-Forwarded-For names the client", () => {
    expect(clientAddress("127.0.0.1", "203.0.113.7", nginx)).toBe("203.0.113.7");
    expect(clientAddress("::ffff:127.0.0.1", "203.0.113.7", nginx)).toBe("203.0.113.7");
  });
  test("a direct connection ignores the header: it cannot be forged", () => {
    expect(clientAddress("198.51.100.9", "1.2.3.4", nginx)).toBe("198.51.100.9");
  });
  test("entries a client added in front are not believed", () => {
    // The client sent "X-Forwarded-For: 1.2.3.4"; nginx appended the real address.
    expect(clientAddress("127.0.0.1", "1.2.3.4, 203.0.113.7", nginx)).toBe("203.0.113.7");
  });
  test("a chain of trusted proxies is skipped from the right", () => {
    expect(clientAddress("127.0.0.1", "203.0.113.7, 10.1.2.3", nginx)).toBe("203.0.113.7");
    expect(clientAddress("127.0.0.1", "10.1.2.3, 10.4.5.6", nginx)).toBe("10.1.2.3");
  });
  test("a malformed entry stops the walk at the last known address", () => {
    expect(clientAddress("127.0.0.1", "203.0.113.7, unknown", nginx)).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", "", nginx)).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", null, nginx)).toBe("127.0.0.1");
  });
  test("IPv6 clients and proxies", () => {
    expect(clientAddress("fd12::1", "2001:db8::42", nginx)).toBe("2001:db8::42");
    expect(clientAddress("2001:db8::1", "203.0.113.7", nginx)).toBe("2001:db8::1");
  });
  test("without trusted proxies the address is the connection's", () => {
    expect(clientAddress("127.0.0.1", "203.0.113.7", undefined)).toBe("127.0.0.1");
    expect(clientAddress(undefined, "203.0.113.7", nginx)).toBeUndefined();
  });
  test("an invalid entry in the setting stops the start", () => {
    expect(() => trustedProxies(["127.0.0.1", "nginx"])).toThrow(HttpSetupError);
    expect(() => trustedProxies(["10.0.0.0/33"])).toThrow('http.trustedProxies: "10.0.0.0/33" is not an IP address or a subnet such as "10.0.0.0/8".');
  });
});
