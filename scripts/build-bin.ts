import { compileBinary } from "../src/osnv/cli/build";

// Repository binaries go through the framework's compile helper, which keeps
// `bun build --compile` scratch files out of the checkout (see cli/build.ts).
const usage = "Usage: bun scripts/build-bin.ts <entrypoint> <outfile>";
const [entry, outfile, ...rest] = process.argv.slice(2);
if (entry === undefined || outfile === undefined || rest.length > 0) throw new Error(usage);
process.exit(compileBinary(process.execPath, entry, outfile));
