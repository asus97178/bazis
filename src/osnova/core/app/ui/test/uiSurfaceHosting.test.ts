import { describe, expect, test } from "bun:test";
import { normalizeUiSurfaceHostingOptions } from "../../runApp";

const allowSurface = (surface: string) => ({
  surface,
  authorize: () => true,
  policy: () => ({ resources: [] }),
  session: () => ({ id: "test", kind: "test", displayName: "Test" }),
});

describe("runApp UI surface hosting", () => {
  test("requires at least one explicitly protected surface", () => {
    expect(normalizeUiSurfaceHostingOptions(undefined, {})).toBeUndefined();
    expect(() => normalizeUiSurfaceHostingOptions({ surfaces: [] }, {})).toThrow(
      "at least one explicitly registered surface",
    );
  });

  test("derives the API base path from HTTP hosting options", () => {
    const options = normalizeUiSurfaceHostingOptions(
      { surfaces: [allowSurface("admin"), allowSurface("employee")] },
      {
        prefix: "v2/api",
      },
    );

    expect(options).toMatchObject({
      apiBasePath: "/v2/api",
      surfaces: [{ surface: "admin" }, { surface: "employee" }],
    });
  });

  test("normalizes application identity for the canonical object form", () => {
    expect(normalizeUiSurfaceHostingOptions({
      app: { name: "Backoffice" },
      surfaces: [allowSurface("admin")],
    }, {})).toMatchObject({
      app: { name: "Backoffice", version: "1.0.0" },
      surfaces: [{ surface: "admin" }],
    });
  });
});
