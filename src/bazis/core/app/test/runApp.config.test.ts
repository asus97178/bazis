import { describe, expect, test } from "bun:test";
import { Module } from "@/core/di";
import { runApp } from "../runApp";

describe("runApp config validation", () => {
  test("validates configs declared by modules with the configured kernel environment", async () => {
    let environment: string | undefined;
    const brokenConfig = {
      ensureValid(current?: "development" | "test" | "production") {
        environment = current;
        throw new Error("auth config is invalid");
      },
    };

    @Module({ config: brokenConfig })
    class AppModule {}

    await expect(runApp(AppModule, { kernel: { environment: "production" } })).rejects.toThrow(
      "auth config is invalid",
    );
    expect(environment).toBe("production");
  });

  test("builder configuration is applied before explicit config validation", async () => {
    let environment: string | undefined;
    const brokenConfig = {
      ensureValid(current?: "development" | "test" | "production") {
        environment = current;
        throw new Error("stop after validation");
      },
    };

    @Module({})
    class AppModule {}

    await expect(
      runApp(AppModule, {
        config: brokenConfig,
        configure: (builder) => builder.useEnvironment("test"),
      }),
    ).rejects.toThrow("stop after validation");
    expect(environment).toBe("test");
  });
});
