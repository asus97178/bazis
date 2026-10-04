import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { frameworkVersion, hashSources, warnIfGeneratedSourcesChanged, type GeneratedSourceFingerprint } from "../generatedFingerprint";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function project(withConfig = true): { root: string; generated: string; fingerprint: GeneratedSourceFingerprint } {
  const root = mkdtempSync(path.join(tmpdir(), "osnv-fingerprint-"));
  roots.push(root);
  mkdirSync(path.join(root, "src/generated/osnova"), { recursive: true });
  if (withConfig) writeFileSync(path.join(root, "osnova.codegen.json"), "{}");
  writeFileSync(path.join(root, "src/index.ts"), "export const a = 1;\n");
  const files = ["src/index.ts"];
  const fingerprint = { root: "../../..", framework: frameworkVersion() ?? "0.0.0", files, hash: hashSources(root, files)! };
  return { root, generated: path.join(root, "src/generated/osnova"), fingerprint };
}

test("silent while sources match what codegen saw", () => {
  const { generated, fingerprint } = project();
  const warnings: string[] = [];
  expect(warnIfGeneratedSourcesChanged(generated, fingerprint, (message) => warnings.push(message))).toBe(false);
  expect(warnings).toEqual([]);
});

test("warns when a source changed or disappeared after codegen", () => {
  const { root, generated, fingerprint } = project();
  const warnings: string[] = [];
  writeFileSync(path.join(root, "src/index.ts"), "export const a = 2;\n");
  expect(warnIfGeneratedSourcesChanged(generated, fingerprint, (message) => warnings.push(message))).toBe(true);
  expect(warnings[0]).toContain("generated code is out of date (application sources changed)");
  unlinkSync(path.join(root, "src/index.ts"));
  expect(warnIfGeneratedSourcesChanged(generated, fingerprint, () => {})).toBe(true);
});

test("warns when the framework version differs from the one codegen used", () => {
  const { generated, fingerprint } = project();
  const warnings: string[] = [];
  expect(warnIfGeneratedSourcesChanged(generated, { ...fingerprint, framework: "0.0.1-old" }, (message) => warnings.push(message))).toBe(true);
  expect(warnings[0]).toContain("osnv 0.0.1-old ->");
});

test("skipped where the sources are not on disk (compiled binary)", () => {
  const { root, generated, fingerprint } = project(false);
  writeFileSync(path.join(root, "src/index.ts"), "changed\n");
  expect(warnIfGeneratedSourcesChanged(generated, fingerprint, () => { throw new Error("must not warn"); })).toBe(false);
});
