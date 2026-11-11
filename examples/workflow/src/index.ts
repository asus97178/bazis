import { runApp } from "bazis/core/app";
import { OrdersApp } from "./app/App";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(OrdersApp);
