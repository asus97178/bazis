import { build } from "../../admin-ui/node_modules/vite/dist/node/index.js";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
await build({ configFile: resolve(root, "admin-ui/vite.config.ts"), root: resolve(root, "admin-ui"),
  build: { outDir: process.argv[2]!, emptyOutDir: true, rollupOptions: { input: resolve(root, "admin-ui/test/record-recovery/index.html") } } });
