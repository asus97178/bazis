import { defineConfig } from "../kernel";

/**
 * Where the HTTP server listens. `BAZIS_HTTP__HOST` and `BAZIS_HTTP__PORT` set it
 * from the environment. Outside `production` the server is reachable from this
 * machine only; in `production` it listens on every interface.
 *
 * A `port` or `hostname` written in `@App({ http })` is fixed in code and wins.
 */
export const httpConfig = defineConfig("http", {
  default: {
    host: "127.0.0.1",
    port: 3000,
  },
  production: {
    host: "0.0.0.0",
  },
  validate: {
    port: (port) => (Number.isInteger(port) && port >= 0 && port <= 65535 ? undefined : "must be a TCP port (0-65535)"),
    host: (host) => (host.trim() === "" ? "must not be empty" : undefined),
  },
});
