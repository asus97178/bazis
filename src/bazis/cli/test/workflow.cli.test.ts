import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateModule, generateModulePack } from "../generateModule";
import { generateProcess } from "../generateProcess";
import { registerInModuleField } from "../moduleRegistration";
import { parseCliArgs } from "../parseCli";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bazis-cli-process-")));
  roots.push(root);
  const modulesRoot = path.join(root, "modules");
  await mkdir(modulesRoot, { recursive: true });
  await Bun.write(path.join(modulesRoot, "App.module.ts"), 'import { Module } from "bazis/core/di";\n@Module({ imports: [], exports: [] })\nexport class AppModule {}\n');
  return { modulesRoot };
}

test("g process and workflow commands are parsed; wrong use is refused", () => {
  expect(parseCliArgs(["g", "process", "OrderApproval", "--module", "Orders"])).toEqual({
    kind: "process",
    args: { name: "OrderApproval", module: "Orders", pack: undefined, modulesRoot: undefined, force: false, dryRun: false },
  });
  expect(parseCliArgs(["g", "pr", "Refund", "--module", "Payments", "--pack", "Billing", "--dry-run"])).toMatchObject({ kind: "process", args: { pack: "Billing", dryRun: true } });
  expect(parseCliArgs(["workflow", "check"])).toEqual({ kind: "workflow", action: "check" });
  expect(parseCliArgs(["workflow", "diagram", "order-approval", "--app-module", "src/App.module.ts"])).toEqual({ kind: "workflow", action: "diagram", key: "order-approval", appModule: "src/App.module.ts" });
  expect(parseCliArgs(["g", "process", "OrderApproval"])).toEqual({ kind: "error", message: "g process needs the module that owns the process: --module <Name>." });
  expect(parseCliArgs(["g", "process", "OrderApproval", "--module", "Orders", "--full"])).toEqual({ kind: "error", message: "Option --full is not supported by g process." });
  expect(parseCliArgs(["g", "module", "Orders", "--module", "X"])).toEqual({ kind: "error", message: "--module is only supported by g process." });
  expect(parseCliArgs(["workflow", "diagram"]).kind).toBe("error");
  expect(parseCliArgs(["workflow", "check", "--force"])).toEqual({ kind: "error", message: "Option --force is not supported by workflow." });
});

test("g process writes the process file and lists it in the module's processes", async () => {
  const { modulesRoot } = await fixture();
  await generateModule({ name: "Orders", profile: "empty", modulesRoot });
  const result = await generateProcess({ name: "OrderApproval", module: "Orders", modulesRoot });
  const moduleFile = path.join(modulesRoot, "orders/Orders.module.ts");
  expect(result.changes.map((change) => [path.basename(change.path), change.action])).toEqual([["OrderApproval.process.ts", "create"], ["Orders.module.ts", "update"]]);
  const source = await readFile(path.join(modulesRoot, "orders/processes/OrderApproval.process.ts"), "utf8");
  expect(source).toContain('export const OrderApprovalProcess = defineProcess({\n  key: "order-approval",\n  title: "Order approval",');
  expect(source).toContain('import { defineProcess } from "bazis/core/workflow";');
  expect(await readFile(moduleFile, "utf8")).toBe('import { Module } from "bazis/core/di";\nimport { OrderApprovalProcess } from "./processes/OrderApproval.process";\n\n@Module({ imports: [], exports: [], processes: [OrderApprovalProcess] })\nexport class OrdersModule {}\n');

  await generateProcess({ name: "Refund", module: "Orders", modulesRoot });
  expect(await readFile(moduleFile, "utf8")).toContain("processes: [OrderApprovalProcess, RefundProcess] })");
  await expect(generateProcess({ name: "Refund", module: "Orders", modulesRoot })).rejects.toThrow("File already exists");
  await expect(generateProcess({ name: "Refund", module: "Missing", modulesRoot })).rejects.toThrow("Module MissingModule not found");
});

test("g process --pack puts the process into a part of a composite module", async () => {
  const { modulesRoot } = await fixture();
  await generateModulePack({ name: "Billing", parts: ["payments", "invoices"], modulesRoot });
  const planned = await generateProcess({ name: "Refund", module: "Payments", pack: "Billing", modulesRoot, dryRun: true });
  expect(planned.dryRun).toBe(true);
  expect(await Bun.file(path.join(modulesRoot, "billing_modules/payments_module/processes/Refund.process.ts")).exists()).toBe(false);
  await generateProcess({ name: "Refund", module: "Payments", pack: "Billing", modulesRoot });
  expect(await readFile(path.join(modulesRoot, "billing_modules/payments_module/Payments.module.ts"), "utf8")).toContain("processes: [RefundProcess]");
});

test("a one-line @Module gets the member after its last one", () => {
  const file = "/app/Orders.module.ts";
  const add = (source: string) => registerInModuleField(source, file, "/app/processes/A.process.ts", "AProcess", { field: "processes", hostClass: "OrdersModule" });
  expect(add('import { Module } from "bazis/core/di";\n@Module({})\nexport class OrdersModule {}\n')).toContain("@Module({processes: [AProcess]})");
  expect(add('import { Module } from "bazis/core/di";\n@Module({ exports: [], })\nexport class OrdersModule {}\n')).toContain("@Module({ exports: [], processes: [AProcess], })");
  expect(add('import { Module } from "bazis/core/di";\n@Module({ processes: [] })\nexport class OrdersModule {}\n')).toContain("@Module({ processes: [AProcess] })");
});
