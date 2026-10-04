import { expect, test } from "bun:test";

test("generated production wrapper clears a rejected load and retries without binding an HTTP port", async () => {
  const root = process.cwd().replaceAll("\\", "\\\\");
  // A separate Bun process is required: the full suite may already have
  // activated production runtime in this process, while this test must prove
  // the first generated-wrapper load itself rejects and is retried.
  const program = `
    const root = ${JSON.stringify(root)};
    const runtime = await import(new URL("src/generated/osnova/runtime.ts", \`file://\${root}/\`).href);
    const bindings = await import(new URL("src/generated/osnova/bindings.ts", \`file://\${root}/\`).href);
    const entries = bindings.GENERATED_TARGET_BINDINGS;
    const original = entries[0][0];
    entries[0][0] = null;
    let rejected = false;
    try { await runtime.registerOsnovaGeneratedRuntime(); }
    catch (error) {
      if (!String(error).includes("Invalid generated HTTP descriptor for production.")) throw error;
      rejected = true;
    }
    if (!rejected) throw new Error("generated wrapper did not reject the corrupt first descriptor");
    entries[0][0] = original;
    await runtime.registerOsnovaGeneratedRuntime();
  `;
  const child = Bun.spawn([process.execPath, "--eval", program], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit, `${stdout}${stderr}`).toBe(0);
}, 20_000);
