# Working rules for the osnv repository

These instructions apply to the whole repository.

## Communication style

Talk to the user in Russian, simply, lively and in a friendly way, like with a
colleague you enjoy building a product with. Keep the tone upbeat, with fitting
humor, without officialese, bureaucratic phrasing or formal reports for every trifle.

- First answer the user's concrete question directly. A short clarification usually
  takes one or two sentences. For example: "Yes, the API request has a `tools` field.
  It carries the list of available tools." Do not retell the request and do not fill
  pauses with promises like "let me take a look".
- Explain one idea at a time. First name what it is and where it is; then, if needed,
  show one short example. Do not turn a simple question into an overview of the whole
  architecture, options and future work.
- Rely on specifics: a request field, a function, the input and the result.
  Use plain everyday words; explain a necessary term right away.
  Add details on request or when the answer would be inaccurate without them.
- If the user says "unclear", change the way you explain: pick one basic fact and
  show it on a minimal example. Do not repeat the previous explanation with the words
  shuffled, and do not add new terms.
- If the user asks for code or an example in the chat, give the example itself as a
  code block in the message right away. A promise to show it, a retelling or a link to
  a file do not replace the example. Clearly separate proposed syntax from working code.
- Joke naturally and when it fits; do not turn every answer into a performance and
  do not joke at the user's expense.
- Keep your own opinion: argue on the merits, offer concrete options, do not agree
  automatically.
- A light tone does not cancel precision. Say plainly what is wrong, unknown and
  actually done; do not present an intention or an attempt as a result.

## Read the architecture specification first

Before designing, changing files, generating code or running the application, the
agent **must read** the [module architecture and directory structure specification](docs/architecture/MODULE_ARCHITECTURE.md).
It is the mandatory entry point to the work, not optional documentation.

Then read the `MODULE.md` of the affected module, if it exists, and its actual
`*.module.ts`, contracts and the checks relevant to the task. For a new module or a
change of its architecture/public inputs use the
[passport template](docs/architecture/MODULE_SPEC_TEMPLATE.md).
The [examples/todo](examples/todo/README.md) example shows how to apply the rules in
an osnv application; check the code before using the example.
When implementing a module use the [per-file code examples](docs/architecture/MODULE_CODE_EXAMPLES.md):
an atomic feature, a composite module, DTO, ORM, DI, HTTP and extra adapters.

Before editing code, briefly record: the chosen module type, its responsibility, the
affected components and the input contracts. For a regular fix it is enough to name
the existing module and the concrete contract or behavior being changed.

## Engineering priorities

In design, implementation and review the priorities are **OOP and SOLID,
performance, resilience, building into a binary and simplicity of implementation**.
These requirements apply to the application, the framework and the CLI.

- OOP and SOLID: encapsulate state and invariants, separate responsibilities, use
  explicit contracts and the existing DI. Keep implementations substitutable and
  interfaces small. New classes, layers and abstractions must solve a concrete problem.
- Performance: consider algorithm complexity, the number of queries, memory and
  concurrency limits. Avoid N+1, unbounded queries and extra work on hot paths.
  Confirm significant optimizations with measurements under relevant load.
- Resilience: define behavior on dependency errors, timeouts, cancellation and
  partial execution; release resources. Bound retries and use them only with safe
  operation semantics. An error must never look like success.
- Binary build: keep the application and the CLI runnable from built binaries.
  Check that dependencies, imports, codegen and resources work with `bun build --compile`.
  For changes that affect this path, check the build of the affected binary and its
  behavior in a controlled environment. A successful run from sources does not prove
  the binary works.
- Simplicity: choose the minimal clear solution that meets the task's requirements.
  Use the existing mechanisms; do not add generic factories, layers, inheritance or
  dependencies without a concrete need.

When choosing between options, keep correctness and the public contracts, and weigh
the listed priorities together. Justify a significant trade-off in the module
passport; complexity must have a measurable or contractual reason.
The scope of checks follows the change: a documentation edit does not require
running the application, load tests or rebuilding binaries.

<a id="code-naming"></a>

## Code style and naming

Use the style adopted by the project owner: simple domain names, an explicit class
role and short methods with a clear action.

- Name a module briefly after its domain: for example `Agents` for managing agents
  in the AI area. The module name sets the context of its components.
- Name files by the `<Name>.<role>.ts` scheme: `Agents.module.ts`,
  `Agents.service.ts`, `Agents.controller.ts`, `Agents.model.ts`.
- Reflect the class role in its name: `AgentsModule`, `AgentsService`,
  `AgentsController`. A service must have `Service` in the class name and
  `.service.ts` in the file name.
- For regular operations use `getAll`, `getById`, `create`, `update`, `delete`.
  For other actions choose a short direct name: `send`, `cancel` and the like.
  The name `getAll` does not cancel paging and query limits.
- Take the context from the class: `AgentsService.getById(id)` already says that we
  get an agent. Do not repeat the entity and the whole scenario in every method name.
  Add a qualifier when it is needed to tell operations or entities apart.
- A method name must match the actual action. The name must make clear whether the
  method reads, creates, changes, deletes or starts something. A short name must not
  hide another responsibility or promise missing behavior, for example continuing
  the work when it actually records an error.
- Comments explain significant conditions, side effects and limits.
  They complement a clear method name.

Apply the style to new code and to renames within the current task. When renaming,
update the related usages; keep the public contracts and the names through which the
framework calls handlers, unless changing them is part of the task. This rule does
not call for a mass rename of existing code.

## Mandatory architecture rules

- A simple standalone feature is an atomic module. Task, Guest, Users may own ORM,
  services, HTTP, UI profiles and background handlers at the same time.
- A composite module combines atomic modules with independent responsibilities.
  DataManager is an example: tables, fields, validators, records.
- The number of files, technical layers and having `imports` do not by themselves
  make a module composite. Do not create submodules "for a uniform structure".
- The root of a composite module is responsible for composition. Implementation
  registrations belong to atomic modules. This rule does not turn every atomic module
  into an empty root with submodules.
- Use the existing osnv ORM, DI, contracts and extension points.
  Do not create parallel implementations of them and do not change public APIs for the sake of layout.
- Declare class dependencies in constructors; codegen does the regular wiring.
  Use `scoped(IService, Service)` or `scoped(Service)` without a manual dependency
  list. Explicit `deps` are needed only for a concrete justified override.
- For new modules set `exports` explicitly; distinguish DI exports, TypeScript exports
  and published HTTP/AI inputs. Respect the dependency direction and the data owners.
- Create only the directories that are needed. Keep existing names and paths outside
  the task scope; the new specification does not order a mass move of files.
- Describe the input fields before implementing and update them together with it.
  For a new module fill in the `MODULE.md` created by the CLI per the template; for an
  existing one, create or update the passport within the task when the architecture or
  public inputs change.

## Create new modules only through the CLI

All new atomic and composite modules, including new parts of existing packs,
**must be created with osnv CLI commands**. This rule applies to application and
framework modules. It is forbidden to create a module scaffold by hand, copy a
neighboring module or lay out files from the documentation instead of running the CLI.

- Atomic module: `g module <Name>` with the fitting profile `--empty`, `--minimal`
  or `--full`.
- Composite module with parts: `g pack <Name> --parts <part-a,part-b,...>`.
- Run from the repository root: `./scripts/osnv-bun run osnv <command>`
  with a qualified `OSNV_BUN_BIN`. For directory parameters and the other flags see
  the [CLI passport](src/osnv/cli/MODULE.md).

Before generating, define the responsibility, type, composition and input contracts.
After a successful creation, fill in the generated `MODULE.md` and adapt the sources
to the domain task. Record the creation command actually run in the new module's
passport; `--dry-run` only shows the plan and does not count as creation.

If there is no suitable command or option, or the generator misbehaves, first improve
the CLI and check the change, then create the module with the command.
Shortcomings of the CLI do not permit creating a module by hand.

Existing modules and the sources of a created scaffold are edited the usual way.
Models, services, DTOs and other components are added inside their module per the
specification. Codegen results are still updated only by the generator.

## Checking the result

Check conformance to the specification and only the contracts related to the change.
Do not edit codegen results by hand. Before codegen/build/test, check that the
scripts exist in `package.json` and the current toolchain requirements.
A missing script, a failed check or a failed physical test is not a successful check.
For a Markdown-only change it is enough to check the content, local links and the
diff; running the application is not required.

An explicit instruction from the user takes priority over local conventions.
For an allowed deviation, record its reason and scope in the passport, keeping the
other rules and the existing contracts.
