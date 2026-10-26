# Copy a message

A product-neutral code-checked Task. It needs the selected Agent's authentication,
but no Judge or database. Local execution needs no sandbox account; E2B
sandbox execution, the setup default, needs `E2B_API_KEY`, and Together sandbox
execution needs `TOGETHER_API_KEY`. The default Claude starter pins
`claude-opus-5-5` with medium effort. Use `hurdle init --agent codex` for
`gpt-6.1-sol` with medium effort. Use `init --model MODEL --effort LEVEL` or
edit the Suite to change these settings.

The agent reads `fixtures/message.txt` and writes its exact contents into
`answer.txt`. A successful run shows `Passed` and opens the results viewer.

Install the selected agent CLI and provide explicit authentication in your
project's `.env.local`. For Claude Code, use a valid `ANTHROPIC_API_KEY`, or run
`claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` to the generated token.
An API key takes precedence if both are set. For Codex, set `CODEX_ACCESS_TOKEN`,
`CODEX_API_KEY`, or `OPENAI_API_KEY` (in that order of precedence).
Hurdle uses isolated agent configuration and does not inherit your interactive
agent login. Keep `.env.local` out of version control.

From your project directory after creating the default `evals/` starter:

```sh
npx hurdle validate
npx hurdle run --view
```
Validation checks the Suite, installed local agent, and required credentials.
API keys receive a read-only authentication check; no inference is requested.
Subscription tokens are reported as configured, with live validity unverified.
Model access, credits, and task success still depend on the actual run. `run`
repeats readiness checks before opening the result store or launching an agent.
Use `npx hurdle validate --offline` to check only the definition without network
or agent installation checks.

The Suite defines the matrix; `--task`, `--condition`, `--agent` and `--model`
only filter existing selections. This starter runs once; set `repeats` in the
Suite to run independent repeats.

Local execution runs code on your host with network access; it is not a security
sandbox. Use only trusted Suites, checks and task inputs.


## Run the bundled Suite in a sandbox

From the Hurdle repository root:

```sh
node harness/bin/hurdle.mjs setup examples/copy-message/example.suite.mjs --yes
node harness/bin/hurdle.mjs run examples/copy-message/example.suite.mjs --view
```

Setup uses E2B by default: it builds or reuses the Agent template and saves the
Runtime. E2B runs each cell with a workload VM and a Guardian VM; the Agent's
own API key stays in the Guardian and the workload sees only a stand-in. Add
`--sandbox together` to setup to use Together sandbox instead; it builds or
reuses an Agent snapshot, and copy-message uses only an Agent VM there. Agent
inference, image builds, and sandbox use may be billed.
