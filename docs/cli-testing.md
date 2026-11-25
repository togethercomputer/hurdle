# Test the Hurdle CLI as a new user

Run this checklist against a source checkout and a fresh package installation.
Record the Hurdle version, `claude --version`, `codex --version`, each command's
exit code, and its output. Use a fresh project directory for each path so saved
Runtimes and `.env.local` files do not affect later tests.

The default test matrix is Claude Code with `claude-opus-5-5` and Codex with
`gpt-6.1-sol`, both at medium reasoning effort. Init output, generated Suites,
validation output, and saved run configuration should agree.

## Choose an installation path

### From a clone

Follow the source installation in the root README:

```sh
npm run setup
export HURDLE_REPO="$PWD"
export HURDLE_CLI="$HURDLE_REPO/harness/bin/hurdle.mjs"
export HURDLE_PROJECT="$(mktemp -d "${TMPDIR:-/tmp}/hurdle-source.XXXXXX")"
cd "$HURDLE_PROJECT"
hurdle() { node "$HURDLE_CLI" "$@"; }
```

`npm run hurdle -- COMMAND` is the equivalent entry point from the repository
root. The temporary project lets you try the default `init`, `validate`, and
`run` commands without the repository's existing `evals/` directory.

### From the npm package

In a new empty directory, use `npx hurdle` in place of `hurdle` in the checklist.
This exercises the published version.

To test unpublished branch fixes, build and pack that branch, then install its
archive in an empty project instead:

```sh
cd "$HURDLE_REPO"
npm run build
export HURDLE_TARBALL="$(npm pack --ignore-scripts --json | node -e '
let s = ""; process.stdin.on("data", d => s += d);
process.stdin.on("end", () => console.log(JSON.parse(s)[0].filename));
')"
export HURDLE_PROJECT="$(mktemp -d "${TMPDIR:-/tmp}/hurdle-package.XXXXXX")"
cd "$HURDLE_PROJECT"
npm install "$HURDLE_REPO/$HURDLE_TARBALL"
export HURDLE_CLI="$HURDLE_PROJECT/node_modules/hurdle/harness/bin/hurdle.mjs"
hurdle() { node "$HURDLE_CLI" "$@"; }
npx --offline hurdle version
```

For a package-only checkout, set `HURDLE_REPO` to the branch's repository path
before the packing commands. The archive is a local test build; no publishing
is needed.

## Bill-free command checks

```sh
hurdle version
hurdle --version
hurdle -v
hurdle help
hurdle --help
for cmd in init setup validate run view version; do
  hurdle help "$cmd"
  hurdle "$cmd" --help
  hurdle "$cmd" -h
done

hurdle init
hurdle init codex-evals --agent codex
hurdle init api-evals --example together-api
hurdle init api-codex-evals --example together-api --agent codex
hurdle init custom-evals --agent codex --model gpt-6.1-sol --effort high

hurdle validate --offline
hurdle validate codex-evals/example.suite.mjs --offline --model gpt-6.1-sol
hurdle validate api-evals/example.suite.mjs --offline
hurdle validate api-codex-evals/example.suite.mjs --offline
hurdle validate custom-evals/example.suite.mjs --offline
```

All commands should exit 0. Help must describe the command. The three version
commands must agree. Init must report the generated model and effort. Offline
validation must show the correct Agent configuration and explicitly skip
readiness. No agent, judge, sandbox, or model inference should run.

## Model discovery and overrides

- [ ] `hurdle run together-api --model -h` — concise model guidance, the selected Suite defaults and a discovery command; no credentials or provider calls.
- [ ] `hurdle models --agent claude-code` — up to 10 recent active models, newest first, with one provider compatibility note; no inference.
- [ ] `hurdle models --agent codex --json` — up to 10 recent text/code choices in one JSON result; native/provider compatibility metadata remains available. A working API key should include newer provider IDs even if the native list is stale.
- [ ] `hurdle models --agent codex --all` and `hurdle models --agent claude-code --all --json` — retrieve the full catalogs, including older models, dated model IDs and other model types.
- [ ] A rejected OpenAI key identifies the authentication failure and warns that the fallback catalog may omit newer models.
- [ ] `hurdle validate codex-evals --offline --model arbitrary-new-model-id` — accepts a nonblank override without a model allowlist or inference.
- [ ] With both runners in a Suite, `hurdle validate --offline --model arbitrary-new-model-id` exits 2 and asks for `--agent`; selecting the declared runner accepts the override.
- [ ] Discovery failure does not prevent using an explicit model ID. Actual support/account access is checked during execution.

## Expected errors

Run each command separately, followed immediately by `echo $?`:

```sh
hurdle nonsense
hurdle init bad-evals --effort invalid
hurdle init bad-evals --model
hurdle run --task missing
hurdle run --condition missing
hurdle run --agent codex
hurdle run --model
hurdle run --environment-settings '[]'
hurdle view --store one --runtime two
hurdle view --port 0
hurdle setup --json --interactive
```

Expect actionable argument errors and exit 2, without creating `bad-evals` or
starting an evaluation. `hurdle init` a second time should exit 1 without
changing the existing starter. `hurdle validate missing.suite.mjs --offline`
should exit 1 with a Suite diagnostic.

## Readiness and local evaluation

Install both agent CLIs and configure explicit credentials in the project's
`.env.local` or shell. Claude accepts `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`; Codex accepts `CODEX_API_KEY` or `OPENAI_API_KEY`.
Interactive agent logins are not inherited.

```sh
hurdle validate
hurdle validate codex-evals/example.suite.mjs
```

Validation uses read-only provider requests and must not run agents. Subscription
token validity can be reported as unverified. Missing or rejected credentials
must give a clear recovery message before a run starts. A local Codex that does
not list the selected model, such as Codex 0.141 with `gpt-6.1-sol`, must give a
warning naming the model.

The following three small evaluations may incur agent charges:

```sh
hurdle run --experiment-version smoke-before
hurdle run --task copy-message --condition baseline --agent claude-code \
  --model claude-opus-5-5 --experiment-version smoke-after --view
# Inspect the Viewer, then press Ctrl+C before continuing.
hurdle run codex-evals/example.suite.mjs --agent codex --model gpt-6.1-sol \
  --environment local --environment-settings '{}' --store .hurdle/codex-results
hurdle view --store .hurdle/codex-results
# Stop that Viewer before starting the default store's Viewer.
hurdle view
```

Each run should pass with `answer.txt` containing `Hello from the fixture.`
and a newline. Inspect the transcript, checks, artifact, and model/effort
configuration. Compare the two Claude labels in the default Viewer. Starting
and stopping Viewers should release their port and child processes. While one
Viewer runs, a second `hurdle view` should report the busy port and suggest
`--port 3001`, which should start alongside it. A failed agent run should
provide a diagnostic and exit nonzero.

## Together sandbox and API

Add `TOGETHER_API_KEY` alongside Agent credentials. Agent inference, Together
inference, and sandboxes may incur charges.

```sh
hurdle setup api-evals/example.suite.mjs
hurdle setup api-evals/example.suite.mjs --json
hurdle setup api-evals/example.suite.mjs --interactive
hurdle validate api-evals/example.suite.mjs
hurdle validate api-evals/example.suite.mjs --runtime .hurdle/runtime/default.json
hurdle run api-evals/example.suite.mjs --runtime .hurdle/runtime/default.json --view
# Stop the Viewer before continuing.
hurdle view --runtime .hurdle/runtime/default.json
```

JSON setup must emit one valid JSON document and use exit 0 on success, 1 on
setup failure, or 2 on argument failure. The saved Runtime should be reused by
validate, run, and view. Repeat setup must preserve storage configuration.
Nothing is built. The API run should show trusted Together HTTP evidence and
`completion.json` in the Viewer. Repeat this path with
`api-codex-evals/example.suite.mjs` to exercise Codex in the sandbox.

## Postgres storage

Use a disposable, existing database and set
`HURDLE_RESULT_STORE_DATABASE_URL`. These setup commands apply schema migrations:

```sh
hurdle setup --store postgres --json
hurdle setup --store postgres
hurdle setup --store postgres --interactive
hurdle validate
hurdle run --experiment-version smoke-postgres --view
```

Setup must be repeatable, preserve execution settings, and save the project
Runtime. Runs and captured evidence should appear in the Postgres-backed Viewer;
artifact bytes remain in the configured local artifact directory.
