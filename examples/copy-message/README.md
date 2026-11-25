# Copy a message

A product-neutral code-checked Task. It needs the selected Agent's authentication,
but no Judge or database. Local execution needs no sandbox account; Together
sandbox execution needs `TOGETHER_API_KEY`. The default Claude starter pins
`claude-opus-5-5` with medium effort. Use
`npx hurdle init codex-evals --agent codex` for a Codex starter in `codex-evals/`
that pins `gpt-6.1-sol` with medium effort. Use
`npx hurdle init DIRECTORY --model MODEL --effort LEVEL` or edit the Suite to
change these settings.

The agent reads `fixtures/message.txt` and writes its exact contents into
`answer.txt`. A successful run shows `Passed` and opens the results viewer.

Install the selected agent CLI (`npm install -g @anthropic-ai/claude-code` or
`npm install -g @openai/codex`) and provide explicit authentication in your
project's `.env.local`. For Claude Code, use a valid `ANTHROPIC_API_KEY`, or run
`claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` to the generated token.
An API key takes precedence if both are set. For Codex, set `CODEX_API_KEY` or
`OPENAI_API_KEY` (in that order of precedence).
Hurdle uses isolated agent configuration and does not inherit your interactive
agent login. `init` adds `.env.local` and `.hurdle/` to your project's
`.gitignore`; keep `.env.local` out of version control.

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


## Run the Suite in a sandbox

From your project directory, add `TOGETHER_API_KEY` to `.env.local`, then run:

```sh
npx hurdle setup
npx hurdle run --view
```

If you created the starter in another directory, pass that directory to each
command, for example `npx hurdle setup codex-evals`. From the Hurdle repository
root, pass `examples/copy-message/example.suite.mjs` instead and replace
`npx hurdle` with `node harness/bin/hurdle.mjs`.

Setup configures the Together sandbox and saves the Runtime; nothing is built.
Each cell runs in one VM; the Agent's own API key stays in the Guardian on your
machine and the workload sees only a stand-in. After setup, `npx hurdle run`
uses the saved sandbox Runtime. Agent inference and sandbox use may be billed.
