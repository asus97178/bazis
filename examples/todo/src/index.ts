import { runApp } from "bazis/core/app";
import { TodoApp } from "./app/App";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(TodoApp);
