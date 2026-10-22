import { expect, test } from "bun:test";

// 0.113.0: a mistake in a declaration (an @Infra manifest, llmRouter profiles,
// defineConfig, configEnum, @GrpcMethod, ormBazis options) threw while the
// file was imported or the modules were expanded, so it escaped with a source
// frame and a Bun banner. It is a configuration error and prints as one line.
const cases: readonly (readonly [string, string])[] = [
  ["infra", 'Infra instance names must be non-empty and trimmed.'],
  ["llm-router", "llmRouter requires at least one model profile."],
  ["config-env", 'Configuration key "mail.host": environment variable "SMTP_HOST" must start with BAZIS_'],
  ["config-enum", "configEnum requires non-empty homogeneous finite values and a declared default."],
  ["grpc", "EchoController: echo: gRPC requestModel must be a DTO class."],
  ["orm", "ensureCreated and migrateOnStart are mutually exclusive"],
];

for (const [name, message] of cases) {
  test(`${name}: a declaration error is one configuration-error line and exit code 1`, async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/declarationError.fixture.ts`, name], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(1);
    expect(stderr).toContain(`[bazis] configuration error: ${message}`);
    expect(stderr).not.toContain("Bun v");
    expect(stderr).not.toMatch(/^\s+at /m);
  });
}
