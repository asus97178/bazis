import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 0.101.0: codegen reads FromQuery/FromHeader/FromBody/FromRoute through the
// type checker, binds an application query model without @RequestModel(), and
// refuses every misuse with BAZIS_HTTP_BINDING_UNRESOLVED and the reason.
test("explicit sources: aliases, models without decorators, misuse", async () => {
  const repository = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), "bazis-sources-codegen-"));
  const source = path.join(root, "src/index.ts");
  const valid = `import { Validator } from "bazis/library/validation";
import { Controller, FromHeader, FromQuery as Q, Get } from "bazis/core/http";
import type { FromQuery as OwnFromQuery } from "./own";
export class SearchQuery {
  @Validator({ required: true, minLength: 2 }) q!: string;
  @Q("page_size") @Validator({ integer: true }) pageSize = 20;
}
@Controller("probe") export class ProbeController {
  @Get("search") search(query: Q<SearchQuery>) { return query; }
  @Get("renamed") renamed(size: Q<number, "page_size">, id: FromHeader<string, "X-Request-Id">) { return { size, id }; }
  @Get("own") own(limit: OwnFromQuery<number>) { return limit; }
}
`;
  const run = async () => {
    const child = Bun.spawn([process.execPath, path.join(repository, "src/bazis/core/scripts/di-generate.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, output: out + err };
  };
  try {
    await mkdir(path.join(root, "node_modules"));
    await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
    await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
    await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src/**/*.ts"] }));
    // An application type that happens to be called FromQuery is not a marker.
    await Bun.write(path.join(root, "src/own.ts"), "export type FromQuery<T> = T;\n");
    await Bun.write(source, valid);
    const generated = await run();
    expect(generated.exit, generated.output).toBe(0);
    const output = path.join(root, "src/generated/bazis/bindings.ts");
    const before = await Bun.file(output).text();
    expect(before).toContain('"search":[{"source":"queryModel","model":"SearchQuery","optional":false}]');
    expect(before).toContain('"renamed":[{"source":"query","name":"page_size","type":"number","optional":false},{"source":"header","name":"X-Request-Id","optional":false}]');
    // The own FromQuery is an ordinary type reference, not the marker of bazis/core/http.
    expect(before).toContain('"own":[{"source":"body","model":"OwnFromQuery"');
    // The application model needs no @RequestModel(): codegen registers it.
    expect(await Bun.file(path.join(root, "src/generated/bazis/httpRequestModels.ts")).text()).toContain("SearchQuery");

    await Bun.write(path.join(root, "runtime-probe.ts"), `
import { ProbeController, SearchQuery } from "./src/index";
import { registerBazisGeneratedRuntime } from "./src/generated/bazis/runtime";
import { resolveGeneratedBindings } from "./node_modules/bazis/core/http/Binding/autoBindings";
import { bindArguments } from "./node_modules/bazis/core/http/Binding/ParameterBinder";
import { HttpContext } from "./node_modules/bazis/core/http/HttpContext/HttpContext";
import { modelValidatorAdapter } from "bazis/library/validation";
await registerBazisGeneratedRuntime();
const bindings = resolveGeneratedBindings(ProbeController, "search");
const ctxFor = (query) => { const request = new Request("http://localhost/probe/search" + query); return new HttpContext(request, new URL(request.url), {}, {}, undefined, undefined, "127.0.0.1", modelValidatorAdapter); };
const [query] = await bindArguments(bindings, ctxFor("?q=dune&page_size=5"), {});
if (!(query instanceof SearchQuery) || query.q !== "dune" || query.pageSize !== 5) throw new Error("query model binding changed: " + JSON.stringify(query));
const failure = await bindArguments(bindings, ctxFor("?q=d"), {}).catch((error) => error);
if (failure.status !== 400 || failure.errors[0].code !== "minLength") throw new Error("query model validation changed");
console.log("query model without decorator: PASS");
`);
    const runtime = Bun.spawn([process.execPath, path.join(root, "runtime-probe.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [runtimeExit, runtimeOut, runtimeErr] = await Promise.all([runtime.exited, new Response(runtime.stdout).text(), new Response(runtime.stderr).text()]);
    expect(runtimeExit, runtimeOut + runtimeErr).toBe(0);
    expect(runtimeOut).toContain("query model without decorator: PASS");

    const rejected: readonly (readonly [string, string, string])[] = [
      ['size: Q<number, "page_size">', "size: FromHeader<string[]>", "FromHeader<string[]>: a header takes one value"],
      ["query: Q<SearchQuery>", 'query: Q<SearchQuery, "q">', 'FromQuery<SearchQuery, "…">: a query model takes no name; name its fields with @FromQuery("…")'],
      ['size: Q<number, "page_size">', "size: FromRoute<number>", 'FromRoute parameter "size" is not in the route template'],
      ["query: Q<SearchQuery>", "query: FromBody<string>", "FromBody<string> takes a request-model class; read a raw body through HttpContext"],
      ['size: Q<number, "page_size">', "size: Q<number, string>", 'the name in FromQuery<…, "name"> must be a non-empty string literal'],
    ];
    for (const [from, to, reason] of rejected) {
      const code = valid.replace(from, to).replace("FromQuery as Q, Get }", "FromQuery as Q, Get, type FromRoute, type FromBody }");
      await Bun.write(source, code);
      const result = await run();
      expect(result.exit, to).not.toBe(0);
      expect(result.output.replace(/\s*│\s*/g, " ").replace(/\s+/g, " "), to).toContain("BAZIS_HTTP_BINDING_UNRESOLVED");
      expect(result.output.replace(/[│\n]/g, " ").replace(/\s+/g, " "), to).toContain(reason);
      expect(await Bun.file(output).text()).toBe(before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
