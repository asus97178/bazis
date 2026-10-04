import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerClient } from "../connectors/codex/CodexAppServerClient";
import type { CodexRunInput } from "../connectors/codex/contracts";

const binary = resolve(import.meta.dir, "fixtures/codex-server.py");
const stages = [
  { method: "initialize", occurrence: 1 },
  { method: "config/read", occurrence: 1 },
  { method: "skills/list", occurrence: 1 },
  { method: "skills/config/write", occurrence: 1 },
  { method: "skills/config/write", occurrence: 6 },
  { method: "skills/list", occurrence: 2 },
  { method: "account/read", occurrence: 1 },
  { method: "account/read", occurrence: 2 },
  { method: "model/list", occurrence: 1 },
  { method: "skills/list", occurrence: 3 },
  { method: "thread/start", occurrence: 1 },
];

test.each(stages)("preparation cancellation at $method #$occurrence settles without a later RPC", async stage => {
  const f = await fixture(stage), abort = new AbortController();
  const reason = new Error("fixture-preparation-cancelled");
  const running = f.client.run(input(abort.signal)).then(
    value => ({ state: "resolved" as const, value }),
    error => ({ state: "rejected" as const, error }),
  );
  try {
    const before = await f.blocked();
    abort.abort(reason);
    const outcome = await bounded(running);
    const activeRuns = Reflect.get(f.client, "activeRuns");
    // Release a non-cancellable baseline RPC so that the test also detects late work.
    await f.release();
    await bounded(running);
    const after = await f.wire();
    expect({ state: outcome.state, activeRuns, laterRpcs: after.slice(before.length) })
      .toEqual({ state: "rejected", activeRuns: 0, laterRpcs: [] });
    expect(after.some(item => item.method === "turn/start")).toBe(false);
  } finally {
    await f.close();
    await running;
  }
}, 10_000);

test("a cancelled run stops waiting for another caller's connection and releases its slot", async () => {
  const f = await fixture({ method: "initialize", occurrence: 1 }), abort = new AbortController();
  const connecting = f.client.connect();
  let running: Promise<unknown> | undefined;
  try {
    const before = await f.blocked();
    running = f.client.run(input(abort.signal)).then(
      value => ({ state: "resolved" as const, value }),
      error => ({ state: "rejected" as const, error }),
    );
    abort.abort(new Error("fixture-waiter-cancelled"));
    const outcome = await bounded(running);
    const activeRuns = Reflect.get(f.client, "activeRuns");
    const after = await f.wire();
    await f.release();
    await connecting;
    await bounded(running);
    expect({ outcome, activeRuns }).toMatchObject({ outcome: { state: "rejected" }, activeRuns: 0 });
    expect(after).toEqual(before);
    expect(await f.client.run(input(new AbortController().signal))).toBe("Ответ: fixture-message");
  } finally {
    await f.close();
    await connecting.catch(() => undefined);
    await running;
  }
}, 10_000);

async function fixture(stage: { method: string; occurrence: number }) {
  await chmod(binary, 0o700);
  const directory = await mkdtemp(join(tmpdir(), "osnova-codex-preparation-"));
  const home = join(directory, "home");
  await mkdir(home);
  await writeFile(join(home, "fixture-account"), "fixture");
  const hold = join(home, "fixture-hold-rpc");
  await writeFile(hold, JSON.stringify(stage));
  const client = new CodexAppServerClient({ enabled: true, binary, stateDirectory: directory });
  const wire = async (): Promise<{ method?: string }[]> => {
    let content: string;
    try { content = await readFile(join(home, "fixture-wire.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return content.slice(0, content.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
  };
  return {
    client, wire,
    release: () => rm(hold, { force: true }),
    async blocked() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const calls = await wire();
        if (calls.filter(call => call.method === stage.method).length === stage.occurrence) return calls;
        await Bun.sleep(5);
      }
      throw new Error(`Fixture did not reach ${stage.method} #${stage.occurrence}`);
    },
    async close() { await client.dispose(); await rm(directory, { recursive: true, force: true }); },
  };
}

function input(signal: AbortSignal): CodexRunInput {
  return { instructions: "", messages: [{ role: "user", text: "fixture-message" }], signal, onTextDelta() {} };
}

async function bounded<T>(operation: Promise<T>): Promise<T | { state: "pending" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<{ state: "pending" }>(resolve => {
      timer = setTimeout(() => resolve({ state: "pending" }), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
