import { resolve } from "node:path";
import { preview } from "../../client-ui/node_modules/vite/dist/node/index.js";

// Serve the production client bundle against the disposable integration fixture.
const server = await preview({ configFile: false, root: resolve(import.meta.dir, "../../client-ui"),
  preview: { host: "127.0.0.1", port: 4301, strictPort: true, proxy: {
    "/api": { target: "http://127.0.0.1:3102", changeOrigin: true, ws: true,
      bypass(request) {
        if ((request.headers.upgrade || request.headers.origin) && request.headers.origin !== `http://${request.headers.host}`) return false;
      }, headers: { Origin: "http://127.0.0.1:3102" },
    },
  } },
});
process.on("SIGTERM", () => { server.httpServer.closeAllConnections(); server.httpServer.close(() => process.exit(0)); });
console.log("Client browser fixture ready on http://127.0.0.1:4301/");
