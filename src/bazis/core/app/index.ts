// Composition layer: the single application entry point. Depends on the kernel, HTTP, gRPC and
// the validation library (it is the composition root, so it may use everything), hiding
// infrastructure wiring from application code.
export { runApp, type RunAppOptions } from "./runApp";
export * from "./ui";
