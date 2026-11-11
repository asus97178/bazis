// Composition layer: the single application entry point. Depends on the kernel, HTTP, gRPC and
// the validation library (it is the composition root, so it may use everything), hiding
// infrastructure wiring from application code.
export { App, runApp, type AppClass, type AppOptions, type AppSettings } from "./runApp";
export type { AppLanguage, AppMessages } from "./messages";
export * from "./ui";
