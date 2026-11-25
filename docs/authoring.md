# Authoring evaluations

Create a starter evaluation from your project directory:

```sh
npx hurdle init
```

The starter uses Claude Code by default. Use `npx hurdle init --agent codex`
to create a Codex starter instead.

Starters pin Claude Code to `claude-opus-5-5` and Codex to `gpt-6.1-sol`, both
with medium reasoning effort. Override these when creating a starter:

```sh
npx hurdle init --agent codex --model gpt-6.1-sol --effort medium
```

`init --model` writes a model into the Suite. `run --model` and
`validate --model` override the selected runner’s model for that invocation.
Use any model ID or short name supported by Claude Code or Codex; Hurdle has no
model allowlist. With both runners in a Suite, select one with `--agent`.
Effort settings are preserved, and identical selections after the override run
once. Use `run SUITE --model -h` to see guidance and the Suite defaults.
The runner/provider determines model availability and account access.

Discover copyable model IDs and reported reasoning settings:

```sh
npx hurdle models --agent claude-code
npx hurdle models --agent codex --json
npx hurdle models --agent codex --all
```

By default, discovery shows up to 10 recent text/code choices, newest first by
the provider's catalog date (Anthropic release date or OpenAI creation time).
Undated entries retain upstream order. Duplicate dated model IDs are omitted
when a shorter ID is present, and deprecated models are omitted. Add `--all`
for the full catalog, including older models and other model types. `--json`
uses the same selection; combine it with `--all` to retrieve every entry.

Discovery performs no inference and refreshes upstream catalogs each time.
Claude uses the Anthropic Models API with `ANTHROPIC_API_KEY`; OAuth-only
catalog discovery is unavailable. Codex reads the local CLI catalog and also
queries OpenAI's live Models API when an API key is selected. The CLI catalog
may be cached, and provider-only entries have unverified runner compatibility;
OpenAI's provider catalog lacks coding/modality metadata, so its default
shortlist uses a conservative naming heuristic to omit obvious audio, image,
search, embedding and fine-tuned IDs. This is not a compatibility check;
unfamiliar provider IDs remain discoverable with `--all`. Catalog entries do
not verify execution access.
New releases may require updating the Agent CLI or sandbox image. Discovery
never changes the pinned Suite defaults or restricts an explicit `--model` ID.
`models --help` and `run SUITE --model -h` remain offline.

An evaluation has two parts: a **Suite** selects what to run, and each **Task**
defines a prompt and its checks.

Before your first run, install the selected agent CLI and configure credentials
in `.env.local` (these values override your shell). Hurdle uses isolated agent
configuration; an interactive CLI login alone is not inherited.

- Claude Code: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` generated with
  `claude setup-token`. A nonblank API key takes precedence over the OAuth token.
- Codex: `CODEX_API_KEY`, then `OPENAI_API_KEY`. Hurdle runs Codex with an
  OpenAI API key only. A ChatGPT access token (`CODEX_ACCESS_TOKEN`) is ignored:
  it can act for you across all of ChatGPT, not just Codex. An API key can be
  limited with an OpenAI project budget.

Keep `.env.local` out of version control, then check readiness:

```sh
npx hurdle validate
npx hurdle run --view
```

`validate` checks definitions, installed local agent executables, required task
and Runtime credentials, and API-key authentication through read-only provider
endpoints. It never runs an Agent or Judge, creates a sandbox, or requests
model inference. Subscription-token validity and remote agent installation are
reported as unverified; these checks do not prove model access or billing
readiness. `run` repeats the same checks before opening a result store or
launching an agent. A rejected credential stops the command with recovery steps.

Use the same `--runtime FILE` and Agent filter and model override as your run to check the
configuration you intend to execute.

Use `npx hurdle setup` to configure the project Runtime: execution, result
storage, Judge and Viewer settings. Execution can use Local or the Together
sandbox.
Without a saved Runtime, runs use Local execution and filesystem storage.
The saved project Runtime is used by validate, run, and view; explicit Runtime
or run topology options override it. Create a Together API demo with
`init --example together-api`. See
[sandbox setup](./sandbox-setup.md) for credentials and usage limits.

List the Suites already in your project:

```sh
npx hurdle suites
```

`suites` lists paths and short names without executing Suite code.
For example, `evals/sandbox-smoke/example.suite.mjs` becomes `sandbox-smoke`.
Use a unique name with `setup`, `validate` or `run`; ambiguous names require
the full path. Use `suites --json` for scripts.

For example, configure the sandbox and Postgres in separate steps, then run:

```sh
npx hurdle setup sandbox-smoke
npx hurdle setup --store postgres
npx hurdle run sandbox-smoke --view
```

Storage setup preserves the sandbox configuration.

With no Suite argument, Hurdle uses `evals/example.suite.mjs`, then
`example.suite.mjs`, then a sole discovered project Suite. Bundled files under
`examples/` are never selected automatically. If several project Suites exist
without a conventional default, select one by name or path.

For definition-only CI or offline work:

```sh
npx hurdle validate --offline
```

Offline validation does not establish runtime readiness and does not bypass the
checks performed by `run`.

## 1. Define a Suite

```js
import { defineSuite } from "hurdle";

export default defineSuite({
  tasks: ["./tasks/copy-message"],
  agents: [{ runner: "claude-code", model: "claude-opus-5-5", effort: "medium" }],
  concurrency: 3,
  verdict: "code",
});
```

- `tasks` contains paths relative to the Suite file.
- `agents` selects the runner and, optionally, its model.
- Each Agent's optional `effort` selects `low`, `medium`, `high`, `xhigh`, or
  `max` reasoning effort. Hurdle forwards it to the agent CLI and saves it in
  the run configuration. Available effort levels depend on the selected model
  and installed CLI version. Omit it to use the agent's default.
- `conditions` defines the skills and MCP servers available to the Agent. When
  omitted, the Suite has one empty `baseline` Condition.
- `repeats` runs every selected cell independently, even after a failure. It
  defaults to `1`.
- `concurrency` limits active evaluation cells (Task × Condition × Agent × repeat).
  It defaults to `3` and accepts integers from `1` to `100`. A slot includes
  retries, sandbox cleanup, and judging. Results retain their matrix order.
- `verdict` chooses code checks, a Judge, or both.

Omitted `skills` or `mcpServers` are empty. Skills and MCP servers are selected
independently.

## 2. Write a Task

```text
tasks/copy-message/
├── prompt.md
├── checks.mjs
├── guard.mjs       # optional
├── fixtures/
│   └── message.txt
└── workspace/
```

Write the Agent's instructions in `prompt.md`. Put read-only inputs in
`fixtures/`; they appear under `fixtures/` during the run. Files in `workspace/`
are placed at the workspace root, which is useful when the prompt names an exact
path.

Every Task needs `prompt.md` and `checks.mjs`. Add `guard.mjs` only when the
Task must prevent a request. Symlinks and overlapping staged paths are rejected.

## 3. Write deterministic checks

```js
import { defineChecks } from "hurdle";

export default defineChecks((run) => {
  run.expect.completed();

  run.expect.artifact({
    id: "answer",
    path: "answer.txt",
    format: "text",
    maxBytes: 4096,
  });

  run.check({
    id: "exact-copy",
    passed: run.artifacts.text("answer.txt") === "Hello from the fixture.\n",
    summary: "answer.txt must match the fixture exactly.",
  });
});
```

This example checks that the Agent exited cleanly, captured `answer.txt`, and
wrote the exact expected text. Declare an artifact before reading it.

Checks run against captured results, not the live Agent workspace. Keep them
deterministic: do not import arbitrary helpers, make network calls, or access
credentials. The built-in helpers also cover reply text, HTTP requests, and
tool calls:

```js
run.expect.replyIncludes("in stock");
run.expect.request({ id: "chat", method: "POST", path: "/v1/chat/completions", status: 200 });
run.expect.tool("lookup_inventory", { count: 1 });
```

Required request and tool checks need a Runtime that can capture trusted
traffic, such as the Together sandbox. Native Local runs cannot prove those observations.

### Block an expensive or destructive request

Put preventive policy in `guard.mjs`, separate from the checks that inspect the
completed run:

```js
import { defineGuard } from "hurdle";

export default defineGuard((guard) => {
  guard.block.request({
    id: "no-reservation",
    method: "POST",
    path: "/v1/compute/clusters",
  });
});
```

During a sandbox run, the Guardian returns a synthetic `403` before it substitutes
the real API credential or contacts the target. Hurdle automatically records a
deterministic check for every guard: it passes when the Agent never tries the
request and fails when the Guardian blocks an attempt. The blocked attempt is
retained as trusted, payload-free request evidence.

Blocking is deliberately narrow in this release: `method` and `path` are exact,
the path cannot contain a query or fragment, and request bodies are not
inspected. A Task that declares a blocker requires execution in the Together
sandbox; Local runs are rejected before the Agent starts.

## 4. Choose how a run is scored

- `code`: required code checks decide the result. No Judge runs.
- `judge`: `run.judge(rubric)` decides the result. Code checks are advisory.
- `hybrid`: required code checks and the Judge must both pass.

For `judge` or `hybrid`, add both a rubric and a Judge model:

```js
// checks.mjs
run.judge("Pass only when the answer clearly explains the quoted price.");

// example.suite.mjs
verdict: "hybrid",
judge: { model: "claude-opus-4-8" },
```

Configure the Judge credential in the Runtime: `judge.credentialEnv` names
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Setup picks the OAuth token
only when no API key is set. With the OAuth token the Judge runs Claude Code on
the machine running Hurdle, isolated from your own Claude Code configuration,
so install Claude Code 2.1.288 or newer there. Run Trust is always enforced, so execution,
evidence-capture, or cleanup failures cannot become a pass.

Results stay distinct:

- `pass`: the configured scoring requirements passed.
- `fail`: the evidence proves a required check or Judge failed.
- `incomplete`: required execution, evidence, or Judge data was unavailable.
- `unknown`: there was not enough scoring authority to decide.

To see all four in one run, create the kitchen-sink example. Its Tasks are
built to reach each result and show skills, workspace files and advisory checks:

```sh
npx hurdle init kitchen-sink --example kitchen-sink
```

## 5. Run, inspect, and compare

```sh
npx hurdle run --view
```

As each run finishes, its checks are listed beneath it: `✓` passed, `✗` failed,
`–` skipped. Checks that did not pass show their summary; advisory checks are
labelled `(advisory)` because they do not decide the result.

Use `--task`, `--condition`, or `--agent` to narrow the Suite matrix.
Use `--model MODEL` to override the selected runner’s model without editing
the Suite. With no override, all declared model configurations run.
Different effort configurations remain separate; identical overridden
configurations run once. The effective model is saved with each Run.

Override the Suite concurrency for one invocation:

```sh
npx hurdle run --concurrency 2 --view
```

For a small three-task concurrency check, create the bundled smoke example:

```sh
npx hurdle init concurrent-tasks --example concurrency-smoke
npx hurdle setup concurrent-tasks
npx hurdle run concurrent-tasks --view
```

This runs three copy tasks at once in the Together sandbox, one VM per task.
Skip setup if your Runtime is already configured. Use `--concurrency 1` for
sequential execution.

Label runs that you want to compare:

```sh
npx hurdle run --experiment-version before
npx hurdle run --experiment-version after
```

Open **Compare** in the Viewer and select the two labels. Runs are compared only
when their saved evaluation definitions are compatible; a matching label alone
does not make two runs equivalent.

## Credentials and safety

Declare a target API only when a Task needs it:

```js
api: {
  authorizationCredential: "YOUR_API_KEY",
  hosts: ["api.example.com"],
},
```

Supply the value through the Runtime or `.env.local`; never commit it. Hurdle
removes the exact text of known credentials, and its escaped forms, from newly
captured evidence. An encoded or split copy, such as base64, is not caught, so
avoid asking Agents to print secrets and review results before sharing them.

A Suite is code you run. The Suite file, `checks.mjs` and `guard.mjs` run on
your machine, inside Hurdle, with the same access to your environment and
`.env.local` as any script you start. A sandbox isolates the Agent, not the
Suite, so run only Suites you trust. Before anything starts, `hurdle validate`
and `hurdle run` list each Suite key and where it can go.

The Agent can use a key it cannot read. In a sandbox, the Guardian adds the
Suite's key to every HTTPS request the Agent sends to `api.hosts`, whatever the
method or path. That includes requests that keep costing money after the run,
such as batch jobs, fine-tunes and dedicated endpoints, and requests that delete
data. The Agent's own model key works the same way on its provider's hosts.
Give evals a dedicated key with a low balance, and block costly or destructive
requests in [`guard.mjs`](#block-an-expensive-or-destructive-request).

Local runs execute Agent code on the host and are not a security sandbox: a
Local Agent can read `.env.local`, including Together, Judge and database
keys. Use a Runtime configured for the Together sandbox to isolate the Agent
and get trusted HTTP/tool evidence.
See [sandbox setup](./sandbox-setup.md).

In the sandbox, the Agent's own model credential and the Suite's
`authorizationCredential` stay in the Guardian, whatever the Task's checks; the
Agent sees only a stand-in. See
[where credentials live](./sandbox-setup.md#where-credentials-live) for every
credential and environment.

In a sandbox, the Guardian swaps the Suite's credential only in the request's
`Authorization` header, sent as `Bearer <key>` or as the bare key. A target API
that reads its key from another header, a query parameter or the request body
receives only the stand-in and rejects the request.
