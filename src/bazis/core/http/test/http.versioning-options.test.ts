import { describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer } from "@/core/di";
import { httpModule, type ApiVersioningOptions } from "../index";
import { assertVersioningOptions } from "../Versioning/VersionReader";

function startupError(versioning: ApiVersioningOptions): unknown {
  @Module({ imports: [httpModule({ port: 0, versioning })] })
  class App {}
  const container = createContainer(App);
  try {
    container.resolveAll(HOSTED_SERVICE);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    void container.dispose();
  }
}

describe("versioning options", () => {
  test("defaultVersion with the url source stops the server from starting", () => {
    const error = startupError({ source: "url", defaultVersion: "1" });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("HttpSetupError");
    expect((error as Error).message).toBe(
      'versioning.defaultVersion has no effect with source "url": the version is part of the path (/v1/...). '
        + 'Remove it, or use source "query" or "header".',
    );
  });

  test("a setting of another source is rejected with a pointer to the right one", () => {
    expect(() => assertVersioningOptions({ source: "header", parameterName: "v" })).toThrow(
      'versioning.parameterName has no effect with source "header": it names the query parameter of source "query". Use headerName for the header.',
    );
    expect(() => assertVersioningOptions({ source: "query", headerName: "x-v" })).toThrow(
      'versioning.headerName has no effect with source "query": it names the header of source "header". Use parameterName for the query parameter.',
    );
    expect(() => assertVersioningOptions({ source: "url", parameterName: "v" })).toThrow(
      'versioning.parameterName has no effect with source "url": it names the query parameter of source "query".',
    );
  });

  test("an unknown source is rejected", () => {
    expect(() => assertVersioningOptions({ source: "path" } as unknown as ApiVersioningOptions)).toThrow(
      'versioning.source must be "url", "query" or "header", got "path".',
    );
  });

  test("valid options pass", () => {
    for (const options of [
      undefined,
      { source: "url" },
      { source: "query", parameterName: "v", defaultVersion: "1" },
      { source: "header", headerName: "x-v", defaultVersion: "2" },
    ] as const) {
      expect(() => assertVersioningOptions(options)).not.toThrow();
    }
    expect(startupError({ source: "query", defaultVersion: "1" })).toBeUndefined();
  });
});
