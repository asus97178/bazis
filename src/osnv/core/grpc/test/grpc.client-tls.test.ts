import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecureServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { GrpcClient, GrpcStatus, type GrpcClientTlsOptions } from "../index";
import { echoService } from "./fixtures/contract";

test("GrpcClient TLS: trusted identity succeeds, untrusted/wrong identity fails, mTLS requires a client certificate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "osnv-grpc-tls-"));
  try {
    const config = path.join(root, "openssl.cnf"), certPath = path.join(root, "cert.pem"), keyPath = path.join(root, "key.pem");
    // The system openssl is only a test-certificate generator, never a runtime dependency.
    await Bun.write(config, "[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth,clientAuth\n");
    const child = Bun.spawn(["/usr/bin/openssl", "req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=localhost", "-config", config, "-extensions", "v3", "-keyout", keyPath, "-out", certPath], { stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, output).toBe(0);
    const ca = Buffer.from(await Bun.file(certPath).arrayBuffer()), key = Buffer.from(await Bun.file(keyPath).arrayBuffer());
    for (const mutual of [false, true]) {
      const server = createSecureServer({ cert: ca, key, ca, requestCert: mutual, rejectUnauthorized: mutual });
      const sessions = new Set<ServerHttp2Session>();
      server.on("session", session => { sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session)); });
      server.on("tlsClientError", () => {});
      server.on("stream", rawStream => {
        const stream = rawStream as ServerHttp2Stream;
        stream.on("error", () => {}); stream.resume();
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
        stream.end(Buffer.from("00000000050a01781007", "hex"));
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const clients: GrpcClient[] = [];
      const client = (tls?: GrpcClientTlsOptions) => {
        const value = new GrpcClient(echoService, { address, tls, timeoutMs: 1500 }); clients.push(value); return value;
      };
      try {
        const trusted = client({ ca, servername: "localhost", ...(mutual ? { cert: ca, key } : {}) });
        expect((await trusted.unary("Echo", {})).data).toEqual({ text: "x", count: 7 });
        expect((await client({ servername: "localhost" }).unary("Echo", {}).then(() => null, error => error))?.code).toBe(GrpcStatus.UNAVAILABLE);
        expect((await client({ ca, servername: "wrong.invalid" }).unary("Echo", {}).then(() => null, error => error))?.code).toBe(GrpcStatus.UNAVAILABLE);
        if (mutual) expect((await client({ ca, servername: "localhost" }).unary("Echo", {}).then(() => null, error => error))?.code).toBe(GrpcStatus.UNAVAILABLE);
      } finally {
        for (const client of clients) client.close();
        for (const session of sessions) session.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
