import { expect, test } from "bun:test";
import { PublishedVersions, type PublishedHead } from "@/core/workflow/definitions_module/internal/PublishedVersions";
import type { VersionDetails } from "@/core/workflow";

const version = (key: string, number: number): VersionDetails => ({ id: `${key}-${number}`, key, version: number, publishedAt: new Date(0), publishedBy: { kind: "system", id: "test" }, document: { schemaVersion: "bazis.workflow/v2", nodes: {}, flows: {} } });
const head = (key: string, latestVersion: number): PublishedHead => ({ id: `id-${key}`, key, latestVersion });

function setup() {
  const cache = new PublishedVersions();
  const loads: string[][] = [];
  const resolve = (heads: PublishedHead[], stored: VersionDetails[] = heads.map((item) => version(item.key, item.latestVersion))) =>
    cache.resolve(heads, async (missing) => {
      loads.push(missing.map((item) => `${item.key}@${item.latestVersion}`));
      return stored.filter((item) => missing.some((wanted) => wanted.key === item.key));
    });
  return { resolve, loads };
}

test("documents are read once and then only for what was published since", async () => {
  const { resolve, loads } = setup();
  expect((await resolve([head("a", 1), head("b", 1)])).map((item) => item.id)).toEqual(["a-1", "b-1"]);
  expect((await resolve([head("a", 1), head("b", 1)])).map((item) => item.id)).toEqual(["a-1", "b-1"]);
  expect((await resolve([head("a", 2), head("b", 1), head("c", 1)])).map((item) => item.id)).toEqual(["a-2", "b-1", "c-1"]);
  expect(loads).toEqual([["a@1", "b@1"], ["a@2", "c@1"]]);
});

test("an archived or deleted process leaves, and comes back read anew", async () => {
  const { resolve, loads } = setup();
  await resolve([head("a", 1), head("b", 1)]);
  expect((await resolve([head("b", 1)])).map((item) => item.id)).toEqual(["b-1"]);
  expect((await resolve([head("a", 1), head("b", 1)])).map((item) => item.id)).toEqual(["a-1", "b-1"]);
  expect(loads).toEqual([["a@1", "b@1"], ["a@1"]]);
});

test("a version replaced between the two queries is left out and read on the next call", async () => {
  const { resolve, loads } = setup();
  expect(await resolve([head("a", 1)], [version("a", 2)])).toEqual([]);
  expect((await resolve([head("a", 2)])).map((item) => item.id)).toEqual(["a-2"]);
  expect(loads).toEqual([["a@1"], ["a@2"]]);
});

test("the same objects come back: nothing is copied per call", async () => {
  const { resolve } = setup();
  const [first] = await resolve([head("a", 1)]);
  const [second] = await resolve([head("a", 1)]);
  expect(second).toBe(first!);
});
