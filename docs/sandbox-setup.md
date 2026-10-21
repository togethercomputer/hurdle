# Configure sandbox and storage

Configure an E2B sandbox in the directory containing your evaluation:

```sh
npx hurdle setup --yes
npx hurdle run --view
```

`setup` validates the Suite, reads configured credentials (`E2B_API_KEY` plus
the Suite's Agent and Task credentials), checks authentication without
inference, and saves the project Runtime. It reuses an available Hurdle
template or snapshot; `--yes` builds a missing default image without prompting.
No evaluation or Agent runs during setup. Setup never prompts by
default, even in a terminal. Missing credentials or required build acceptance
produce an actionable error and a nonzero exit code. E2B is the default
sandbox provider, including trusted API capture and request blocking (see below).
Use `--sandbox together` to select [Together sandbox](#together-sandbox) explicitly.

## Try visible Together API activity

In an empty project directory:

```sh
npx hurdle init --example together-api
npx hurdle setup --yes
npx hurdle run --view
```

The Agent looks up Together models, makes one small completion, saves the JSON
response, and summarizes its reply and token usage. The Viewer displays captured
HTTP activity alongside the transcript, code checks, and `completion.json`. The Suite
requires trusted HTTP capture from E2B or Together, so a Native Local runtime cannot score it.

Configure `E2B_API_KEY`, `TOGETHER_API_KEY` and Agent credentials in `.env.local`
or export them before setup. Together sandbox setup (`--sandbox together`) needs
no `E2B_API_KEY`. Exported values are not copied into the file.
Setup adds `.env.local`, `.hurdle/`, and legacy `.tae/` to `.gitignore` when
configuration succeeds. For the same variable name, file values override exports; a blank
assignment overrides a working exported value too. Use `--interactive` explicitly
for hidden credential prompts and an image build confirmation in a terminal;
prompted values are saved with private file permissions after readiness and
any required build acceptance, before the build starts.

Claude Code uses `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; Codex uses
`CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, or `OPENAI_API_KEY`. Use
`init --example together-api --agent codex` for a Codex demo. Setup's default
image includes the Agent CLIs selected by the Suite, plus Node 22, Python 3,
curl, jq, git, and iproute2. Credentials are never baked into the image.

## Reuse an E2B template

```sh
npx hurdle setup --template my-agent-template:v1
```

The selected template must already be available and contain the Suite's Agent
CLIs. Setup reads template access, build status, and capacity without allocating
a sandbox. A new Runtime adopts the existing template's capacity; a saved
Runtime must match it. Remote CLI installation is checked during execution.
A new Hurdle template uses 2 CPUs and 2048 MB.

Configure all credentials first. To accept building a missing default template:

```sh
npx hurdle setup --yes
```

Template builds use your E2B account and may be billed. Rerunning setup reuses
an available template, preserves the existing Result Store, Judge, Viewer, and
runtime limits, and repeats read-only readiness checks. Failed or declined
builds do not activate a new project Runtime.

Hurdle names the templates it builds after the Agent CLIs inside, such as
`hurdle-claude-code-codex:v2`, and adds an Agent to the template when a Suite in
the project needs it. When a Hurdle upgrade pins a newer CLI for an Agent, that
Agent's templates get a new tag: `validate` and `run` warn that the saved
template is outdated, and rerunning setup builds the new one. A newer Agent CLI
can change results, so compare Runs made with the same template.

## Automate setup

Agents and scripts can consume one JSON document on stdout:

```sh
npx hurdle setup --yes --json
npx hurdle setup --store postgres --json
```

Credentials come from `.env.local` or the environment; no credential values are
accepted as command-line arguments or emitted in the report. `--json` disables
terminal formatting and progress output, and cannot be combined with `--interactive`.
The result includes `schemaVersion`, `command`, `target`, `ok`, `exitCode`,
`requiredCredentials`, `missingCredentials`, `checks`, `runtimePath`,
`executionEnvironment`, `resultStore`, `nextCommands`, and `error`.
Each credential requirement has a `label` and `anyOf` list of environment
variable names. `error` is null on success or an object with a stable `code` and
safe `message`. Missing credentials are reported together before any provider
checks or resource creation. Exit codes are 0 for success, 1 for setup failure,
and 2 for invalid arguments.

Without `--yes`, a missing sandbox image returns `setup.build-required`;
no build is started. Existing snapshots and templates do
not require `--yes`. Postgres setup needs no build acceptance: selecting
`--store postgres` explicitly requests applying the versioned schema migrations.

Optional terminal prompts:

```sh
npx hurdle setup --interactive
npx hurdle setup --store postgres --interactive
```

## Project defaults and overrides

Setup writes `.hurdle/runtime/default.json`. `validate`, `run`, and `view` discover
it automatically. An explicit `--runtime FILE` selects another Runtime;
explicit run topology options (`--environment`, `--environment-settings`, or
`--store`) select that topology instead of the saved default. To run locally:

```sh
npx hurdle run --environment local
```

Existing `.tae/runtime/default.json` profiles are still discovered and reused
by setup. Their configured Result Stores stay in place. If both directories
contain a default Runtime, `.hurdle/runtime/default.json` takes precedence.
Sandbox setup selects E2B unless `--sandbox together` is supplied, including
when replacing an existing sandbox provider: rerun setup with `--sandbox together`
to keep a saved Together Runtime. `run` and `validate` use the saved
environment; this setup default does not override their Runtime selection.
Without a saved Runtime, local runs and the Viewer reuse `.tae/results-v1`
when it exists and `.hurdle/results-v1` does not. Explicit paths always apply.

Use `setup path/to/another.suite.mjs` when the Suite has a different filename;
the saved default applies to this project, and the Suite argument still selects
the evaluation for subsequent commands. `validate --offline` checks only Suite
definitions; it does not establish sandbox readiness.

New E2B Runtime profiles use a local Result Store at `.hurdle/e2b-results-v1`
and Viewer port 3000. Each cell uses a workload VM and a Guardian VM, each with
a five-minute lifetime. Together profiles use `.hurdle/together-results-v1`
and one VM per cell: artifact tasks get a five-minute lifetime and API tasks a
ten-minute lifetime; the Guardian runs on this machine. This is a lifetime limit,
not a dollar or token budget. Agent and Together inference may also be billed.
The Agent runs inside the sandbox, so no local CLI installation is needed.
Setup checks credentials and image access; model access and remote tools are
checked during execution. Existing configured limits are preserved.

## Use Postgres for results

Connect an existing Postgres database, such as Neon, from your evaluation project:

```sh
npx hurdle setup --store postgres
npx hurdle validate
npx hurdle run --view
```

Set `HURDLE_RESULT_STORE_DATABASE_URL` in your project's `.env.local` before
setup. Replace the placeholders with your database provider's full connection
URL, keeping its required TLS parameters:

```dotenv
HURDLE_RESULT_STORE_DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE"
```

Alternatively, export the variable or use `setup --store postgres --interactive`
for hidden input. Hurdle reads `.env.local` without exporting it to your shell,
so `echo $HURDLE_RESULT_STORE_DATABASE_URL` may be empty. Errors show the URL's
source and a retry command. For connection failures, check the provider's URL,
network access and TLS settings.

Legacy credentials and unmodified Runtime profiles remain supported.
Successful Postgres setup updates the built-in `TAE_RESULT_STORE_DATABASE_URL`
credential name to `HURDLE_RESULT_STORE_DATABASE_URL`; custom names are preserved.
The Hurdle variable takes precedence whenever present, including an empty value;
the legacy alias is used only when it is absent. For the same variable name,
`.env.local` overrides the shell.

Setup reports the variable name when it is missing; `--interactive` explicitly
enables hidden input in a terminal. It checks the connection, applies the
versioned migrations for the `hurdle` schema, and saves the project default. The
database must already exist, and the connection must permit creating the schema
and its tables. An upgrade requires schema ownership and permission to rename
it. Rerunning setup verifies existing migration checksums and applies only
missing migrations. No Agent runs or E2B resources are created.

For an existing database, setup transactionally renames `tae` to `hurdle`,
preserving Run rows, captured evidence, migration history, ownership, and grants.
Fresh databases finish with the `hurdle` schema. If both schemas already exist,
setup refuses without changes instead of merging or dropping either schema.
Stop existing run, Viewer, and setup processes and use the updated Hurdle version
consistently before upgrading. Clients at `0.2.4` or earlier expect `tae` and can
recreate it during setup. Update external SQL and `search_path` settings from
`tae` to `hurdle`. Legacy environment variables remain supported; `validate`,
`run`, and the Viewer never apply database migrations.

Storage setup preserves your Local, E2B, or Together execution environment, Judge settings,
and Viewer port. Without a saved Runtime, it configures Local execution. To use
E2B and Postgres, run `npx hurdle setup --yes` first, then `npx hurdle setup --store postgres`.
For Together, use `npx hurdle setup --sandbox together --yes` for the first step.
Configure sandbox and storage in separate commands; sandbox flags do not apply
to storage setup. Subsequent `validate`, `run`, and `view` discover the saved
storage configuration automatically.

Existing filesystem results stay in place; this does not import them into
Postgres. Run records and captured evidence go to the database, while output
artifact bytes stay in `.hurdle/postgres-artifacts`. Existing Postgres profiles
retain their custom credential name and artifact directory. Prompted credentials
use the same private `.env.local` handling as sandbox setup, and database URLs
are never printed. Failed connection or migration checks leave the active Runtime
unchanged. The connection URL is stored only as a credential, never in the Runtime.

Template recipe: [E2B's SDK workflow](https://docs.e2b.dev/template/quickstart).

## Together sandbox

Together sandbox runs the Agent in an ephemeral Linux VM, captures its stdout
and stderr, and seals declared output artifacts before confirming termination.
It supports task completion, artifact checks, optional Judge scoring, and trusted
API traffic capture and request blocking. The egress Guardian runs on the machine
that runs Hurdle: all of the sandbox's outbound traffic is routed through it, so
each cell uses a single VM.

[Together sandbox access](https://docs.together.ai/docs/together-code-sandbox)
must be enabled for your organization. Configure `TOGETHER_API_KEY` and your
Agent credentials in `.env.local`, then install the optional backend dependencies:

```sh
npm run setup:backends
node harness/bin/hurdle.mjs setup examples/copy-message/example.suite.mjs --sandbox together --yes
node harness/bin/hurdle.mjs run examples/copy-message/example.suite.mjs --view
```

For an installed npm package, use `npx hurdle` in place of
`node harness/bin/hurdle.mjs`. Setup installs the Guardian on this machine
(pinned uv, Python 3.12 and hash-locked mitmproxy, cached under
`~/.cache/hurdle/guardian`; macOS and Linux on x86-64 or arm64) and builds a reusable snapshot containing Node
22, Python, Linux controller tools, and the selected pinned Agent CLIs. No local
Docker installation is needed. Rerunning setup reuses the snapshot alias; like
E2B templates, Hurdle's snapshots gain an Agent when a Suite needs it and a new
tag when Hurdle pins a newer Agent CLI. Pass `--snapshot ALIAS` to select an
existing snapshot; setup does not rebuild a missing caller-selected alias.

Setup saves the existing Project Runtime, preserving its store, Judge, Viewer
port, and Together resource limits. A new Together Runtime uses one CPU, 2048
MiB, a five-minute sandbox lifetime for artifact tasks, and `.hurdle/together-results-v1`.
API tasks use a ten-minute lifetime. Each workload exposes one root-owned relay
port that only admits requests carrying both the sandbox token (checked by
Together's ingress) and a per-cell token. The management Agent port remains
authenticated by Together and is blocked for the evaluated Linux user. The sandbox-management key is kept in the controller and is not
injected into the evaluated Agent's environment.

Run the API example with the same setup/run flow:

```sh
node harness/bin/hurdle.mjs setup examples/together-api/example.suite.mjs --sandbox together --yes
node harness/bin/hurdle.mjs run examples/together-api/example.suite.mjs --view
```

API setup selects a network-enabled snapshot (`hurdle-claude-code-network@v1` by
default). Hurdle's snapshots contain the legacy IPv4/IPv6 firewall tools required
by Together's kernel; caller-owned snapshots must supply those tools for every task.

The Guardian reuses the E2B proxy. Inside the workload, a root-owned bridge
accepts every proxied connection; the controller claims each one over an inbound
WebSocket to the relay port and pipes it into the Guardian on this machine
without logging payloads. All hosts are TLS-intercepted with a per-cell CA that
the workload trusts. Capture hosts get the full policy: HTTPS on port 443 only,
selected response headers, exact request blocking, bounded JSON exchange facts
and credential substitution. Other hosts, including the Agent's model API and
package registries, are streamed and recorded as metadata rows (method, host,
path without query, status, duration) within a separate budget; exhausting it
drops rows without failing capture. The Guardian retains the real target
credentials and private CA; the workload receives only public trust material and
surrogate target credentials. Together's management bearer token stays in the
controller.

Keep this machine online while cells run: an end-to-end CONNECT preflight runs
before the Agent starts, and losing the transport cuts the sandbox's egress and
makes capture fail. Root-owned firewall rules prevent direct connections to
resolved capture-host addresses in both IP families. Together does not yet
support outbound network rules, so traffic that ignores the proxy settings can
still leave the sandbox directly to other hosts. Evidence must drain and pass
byte-bound, digest and sequence verification before the checks receive it.
Capture setup or sealing failures make an API Run incomplete; for artifact-only
tasks the journal is diagnostic.

For separate Runtime files:

```sh
npm run runtime:init -- together --snapshot hurdle-claude-code@v1
node harness/bin/hurdle.mjs run examples/copy-message/example.suite.mjs --runtime .hurdle/runtime/together.json
```

`together-postgres` uses the same execution backend with Postgres storage.
Runtime settings are `snapshotAlias`, `cpuCount` (1–16), `memoryMiB` (1024–8192
per CPU), and `maxLifetimeMs` (1000–86400000). Separate Runtime initialization
uses a one-hour lifetime; setup uses five minutes for artifact tasks and ten for
API capture. When a project adds an API Suite, setup raises its own five-minute
default to ten minutes; other configured limits stay as set. Hurdle reserves the
final 30 seconds for process cleanup and evidence sealing. A lifetime that leaves no
execution time produces an incomplete run. Lifetime limits are not dollar or
token budgets.

The Agent runs as a separate Linux user. The shared remote controller verifies
input hashes, rejects unsafe artifact paths and links, kills untracked processes,
and confirms quiescence before reading artifacts. Cancellation still receives
late allocation handles and puts them through the confirmed termination barrier.
The VM is ephemeral: no termination snapshot is created. A failed termination
confirmation makes the Run incomplete.


## Status during a run

`run` shows a short status line as the evaluation progresses: Starting Guardian,
Guardian started, Starting sandbox, Sandbox started, Preparing environment,
Preparing workspace, Agent running, Collecting results, Stopping sandboxes, and
Finalizing results. Together runs its Guardian on this machine for every task.

Interactive terminals update one line with elapsed time. Plain-text logs retain
each status transition. With overlapping cells, the line shows the active count,
completed count, and lifecycle stages; each completed cell gets its own result
and duration. Resource IDs and dashboard links are omitted from the
terminal status; structured progress observers still receive allocation events.
Hurdle terminates the sandboxes at completion; the Result Store retains captured
transcripts and artifacts for `hurdle view`.

Hurdle runs up to three evaluation cells concurrently by default. Set Suite
`concurrency` or pass `run --concurrency N` to change the limit (1–100). E2B
cells use a workload VM and a Guardian VM each, so three active cells can use
six VMs. Together cells use one VM each, with one local Guardian process per
active cell; all of their traffic crosses this machine. Slots remain occupied through retries, sandbox cleanup, and judging.
Provider capacity still applies.

Each Run saves its normalized execution configuration in its immutable
snapshot. The Viewer's session evidence table shows an Execution row with the
provider and, for sandbox runs, the saved workload template or snapshot alias.
Changing the project Runtime does not change this information for earlier Runs.
