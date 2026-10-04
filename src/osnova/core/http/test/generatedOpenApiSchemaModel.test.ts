import { describe, expect, test } from "bun:test";
import {
  getGeneratedOpenApiSchemaName,
  registerGeneratedOpenApiSchemaModel,
} from "../OpenApi/generatedOpenApiRegistry";

describe("generated OpenAPI schema model registry", () => {
  test("resolves a schema by constructor identity", () => {
    class FirstResponse {}
    class SameNameResponse {}
    const OtherSameNameResponse = class SameNameResponse {};

    registerGeneratedOpenApiSchemaModel(FirstResponse, "FirstResponseSchema");
    registerGeneratedOpenApiSchemaModel(SameNameResponse, "FirstSameNameSchema");
    registerGeneratedOpenApiSchemaModel(OtherSameNameResponse, "SecondSameNameSchema");

    expect(getGeneratedOpenApiSchemaName(FirstResponse)).toBe("FirstResponseSchema");
    expect(getGeneratedOpenApiSchemaName(SameNameResponse)).toBe("FirstSameNameSchema");
    expect(getGeneratedOpenApiSchemaName(OtherSameNameResponse)).toBe("SecondSameNameSchema");
  });

  test("rejects conflicting schema identities for the same constructor", () => {
    class Response {}
    registerGeneratedOpenApiSchemaModel(Response, "ResponseV1");

    expect(() => registerGeneratedOpenApiSchemaModel(Response, "ResponseV2"))
      .toThrow("already bound to schema ResponseV1");
  });
});
