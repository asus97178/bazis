# Running with the pinned Bun

The version, revision, binary SHA-256 and qualified hosts are set in
[bun.json](bun.json). The current version is Bun 1.4.0. The check neither installs
nor updates the runtime.

| Host | What is pinned |
| --- | --- |
| macOS arm64 | the exact OS version and build (26.5.2 / 25F84) and the binary SHA-256 |
| Linux arm64, Linux x64 | glibc (not musl/Alpine) and the SHA-256 of the official `bun-linux-*.zip`; the image defines the distribution |

On Linux the Bun copy is protected with mode 0500 in a private 0700 directory: there
is no immutability flag available to a regular user there. The Linux archives were
checked against the release's `SHASUMS256.txt`; the `SHASUMS256.txt.asc` signature
was not verified. Linux qualification (2026-10-05): the full test suite in
`debian:bookworm-slim` (arm64) and the `linux` job on GitHub-hosted `ubuntu-latest`
(x64). The Codex and gRPC TLS tests need `python3` and `openssl` in the environment.

Set the absolute path to an existing executable of this version. It must be the
binary itself, not a symbolic link:

The recommended permanent location is `~/.osnv/toolchain/bun-1.4.0/bun` (mode 0755:
with a read-only binary `bun build --compile` leaves `.bun-build` in the directory),
and the variable goes into `~/.zshenv` so non-interactive shells see it too. Do not
keep the binary in `/private/tmp`: macOS clears it on reboot.

```sh
export OSNV_BUN_BIN=/absolute/path/to/bun
./scripts/osnv-bun run toolchain:check
./scripts/osnv-bun run di:generate --target all
./scripts/osnv-bun test --isolate src/osnv/core/di/test
./scripts/osnv-bun node_modules/typescript/bin/tsc --noEmit
```

Run the commands from the project root. The launcher checks the binary before
running, creates a temporary copy and uses it for child `bun` commands as well.
A version, hash or macOS mismatch stops the run with an `OSNV_BUN_*` diagnostic.
A plain `bun run` uses the Bun from PATH, which may differ from the pinned one.

The copy gets the `uchg` flag. `bun build --compile` clones the executable into a
temporary `.<hash>.bun-build` in the current directory; the clone inherits the flag,
and Bun cannot delete it. So `build:bin:*` compile through
[scripts/build-bin.ts](../scripts/build-bin.ts) from a temporary directory and remove it.
A direct `./scripts/osnv-bun build --compile` in the checkout leaves about 60 MB of
garbage; remove it with `chflags nouchg .*.bun-build && rm .*.bun-build`.

On `SIGINT`, `SIGTERM`, `SIGHUP` or `SIGQUIT` the launcher forwards the first signal
to the child process and waits up to 15 seconds for it to finish. This leaves a
margin over the default `KernelOptions.shutdownTimeoutMs = 10000`. Then a hung
process gets `SIGKILL`; the temporary runtime copy is removed after the process exits.
The exit code after a signal is preserved: for example 143 for `SIGTERM`.

If the application sets a longer shutdown timeout, raise the launcher budget too:

```sh
OSNV_BUN_SHUTDOWN_TIMEOUT_MS=35000 ./scripts/osnv-bun run start
```

`OSNV_BUN_SHUTDOWN_TIMEOUT_MS` is an optional string of decimal digits: an integer
from 1 to 2147483647 milliseconds without leading zeros; the default is `15000`.
An invalid value stops the run with `OSNV_BUN_SHUTDOWN_TIMEOUT_INVALID` before
the child process is created. The wait is checked in 100 ms steps, and the value
is rounded up to that step. Choose a value above the kernel budget; the launcher
does not read the application configuration. `shutdownTimeoutMs = 0` disables the
kernel limit, but not the launcher's. No setting is needed for the standard
shutdown: the former launcher limit of about 500 ms was replaced with 15 seconds.
