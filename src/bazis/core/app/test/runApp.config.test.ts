import { describe, expect, test } from "bun:test";
import { Module } from "@/core/di";
import { App, runApp } from "../runApp";

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

    @App({ modules: [AppModule], kernel: { environment: "production" } })
    class Application {}
    await expect(runApp(Application)).rejects.toThrow(
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

    @App({ modules: [AppModule], config: brokenConfig,
        configure: (builder) => builder.useEnvironment("test") })
    class Application2 {}
    await expect(
      runApp(Application2),
    ).rejects.toThrow("stop after validation");
    expect(environment).toBe("test");
  });
});
