# Qualification: DataManager keyed record recovery

Scope: existing RecordsModule POST/PUT/DELETE, durable same-key replay and explicit
UNKNOWN HTTP policy. No production database, toolchain adoption, or new driver.
New architectural modules are not created. The new components belong to RecordsModule.

Run from the repository with an authorized, hash-matched Bun 1.4.0 executable:

```sh
OSNOVA_BUN_BIN=/absolute/path/to/qualified/bun python3 ops/record-recovery/runner.py unique-run-name
```

The runner builds Darwin arm64 and Linux arm64 musl probes through osnova-bun,
creates one loopback-only PostgreSQL 17.11 container from the pinned local image,
uses tmpfs and generated one-use credentials/certificates, and removes only containers
with its unique label. TLS verification is enabled. Worker role is not superuser;
each platform owns a separate database. The Linux target is an isolated test artifact,
not an addition to the release host allowlist.

The compiled probe starts the real module lifecycle and resolves controllers/services
through generated DI. HTTP methods receive the same request context as the controller
boundary, with a synthetic verified admin principal; this does not replace end-to-end
JWT/router qualification. A database trigger counts actual durable CRUD mutations.

Acceptance cases:

- Cold startup/admission, two independent providers, 12 concurrent identical writes:
  one row, one receipt and one trigger mutation. JSON property order is ignored.
- Changed body/method rejects with conflict; another admin owns a separate namespace.
- Repeated PUT does not overwrite a later update. Repeated DELETE returns its original
  outcome. Missing records and validation retain their defined semantics.
- Failure inserting receipt after a real record INSERT rolls both effects back.
- TLS response relay hides an actually dispatched COMMIT; another session must see
  the durable row before transport disconnect. UNKNOWN returns 503/same-key, old
  context is fenced, new request recovers exactly one row/mutation.
- A separate fault drops the connection before COMMIT is sent. The same-key recovery
  succeeds exactly once after rollback.
- Read Committed is required; Repeatable Read must fail before mutation.
- A competing transaction holds the key lock. PostgreSQL must acknowledge the lock
  waiter; finite operation budget stops it, and later same-key recovery succeeds.
- A fresh compiled process replays receipts without any additional mutations.
- No idle transaction, source drift or owned container remains.

Evidence is append-only under docs/audits/record-recovery-2026-09-19-evidence.
Each run records hashes and source snapshots, compiler output, events, TLS CA,
runtime fingerprint and cleanup. A failed run remains failed.

The locking design requires a fresh Read Committed snapshot after a transaction
advisory lock: [PostgreSQL 17 locking](https://www.postgresql.org/docs/17/explicit-locking.html),
[consistency checks](https://www.postgresql.org/docs/17/applevel-consistency.html).
The receipt primary key additionally prevents two durable outcomes for one key.

Production topology, workload/SLO and receipt retention are separate owner decisions.
No guarantee is extended to unkeyed requests, other modules or external side effects.
