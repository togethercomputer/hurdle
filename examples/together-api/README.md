# Together API starter

One Agent looks up Together models, makes one short chat completion, saves
`completion.json`, and summarizes the reply and token usage. Open the saved
response and captured HTTP activity in the Results Viewer.

```sh
npx hurdle setup --yes
npx hurdle run --view
```

E2B is the default sandbox. To use Together Sandbox instead:

```sh
npx hurdle setup --sandbox together --yes
npx hurdle run --view
```

From the repository root, pass `examples/together-api/example.suite.mjs` to both
commands and replace `npx hurdle` with `node harness/bin/hurdle.mjs`.

Setup configures E2B and reads Agent, E2B and Together credentials from
`.env.local` or the environment. Keep `.env.local` out of version control.
Use `--interactive` for credential prompts. Setup may build an E2B
template; it checks authentication through read-only requests and never runs
inference or the evaluation. Remote tools and model access remain unverified
until the run.

The starter pins `claude-opus-5-5` with `effort: "medium"`. Use
`init --example together-api --agent codex` for `gpt-6.1-sol` with medium effort.
Use `init --model MODEL --effort LEVEL` or edit the Suite to change these settings.

The Suite uses one task, one baseline condition, and one repeat, with code
scoring and no Judge. E2B setup requires `E2B_API_KEY` and uses two sandboxes,
a workload and a Guardian, each with a five-minute lifetime limit. Existing
runtime limits are preserved on reruns. Agent, sandbox, and Together API usage
may be billed.

Together setup builds or reuses `hurdle-claude-code-network@v1`, with Linux
firewall tools. It uses a separate Guardian VM for the same trusted HTTP activity,
selected response headers, request blocking, and bounded exchange facts as E2B.
New Together API runtimes use a ten-minute lifetime per VM. The real target key
stays in the Guardian; the Agent receives a surrogate. Both VMs terminate without
retaining a result snapshot.

The prompt instructs the Agent to make one model-list call and one completion
call with at most 256 generated tokens and no retries. Those instructions are not
a hard spending cap: the Agent could make additional calls. A required code
check rejects extra completion attempts after execution. Edit
`fixtures/request.json` to try another model.

The checks require trusted, successful GET /v1/models and POST
/v1/chat/completions evidence. Native Local cannot supply that evidence. Artifact
checks verify that the saved response includes a reply and token usage. HTTP
metadata proves
the requests occurred, but does not prove the exact request body or response
contents. Artifacts remain Agent-produced evidence.

API references: [model catalog](https://docs.together.ai/reference/models) and
[chat completions](https://docs.together.ai/reference/chat-completions).
