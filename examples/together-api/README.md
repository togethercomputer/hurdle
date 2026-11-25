# Together API starter

One Agent looks up Together models, makes one short chat completion, saves
`completion.json`, and summarizes the reply and token usage. Open the saved
response and captured HTTP activity in the Results Viewer.

```sh
npx hurdle setup
npx hurdle run --view
```

From the repository root, pass `examples/together-api/example.suite.mjs` to both
commands and replace `npx hurdle` with `node harness/bin/hurdle.mjs`.

Setup configures the Together sandbox and reads Agent and Together credentials
from `.env.local` or the environment. Keep `.env.local` out of version control.
Use `--interactive` for credential prompts. Setup checks authentication through
read-only requests and never runs inference or the evaluation. Nothing is built.
Remote tools and model access remain unverified until the run.

The starter pins `claude-opus-5-5` with `effort: "medium"`. Use
`npx hurdle init codex-api-evals --example together-api --agent codex` for
`gpt-6.1-sol` with medium effort. Use
`npx hurdle init DIRECTORY --example together-api --model MODEL --effort LEVEL`
or edit the Suite to change these settings.

The Suite uses one task, one baseline condition, and one repeat, with code
scoring and no Judge. Setup requires `TOGETHER_API_KEY`. Each cell uses one
sandbox VM with a ten-minute lifetime limit; the Guardian runs on your machine.
Existing runtime limits are preserved on reruns. Agent, sandbox, and Together
API usage may be billed.

The Guardian records trusted HTTP activity, selected response headers, request
blocking, and bounded exchange facts. The real target key stays in the
Guardian; the Agent receives a surrogate. The Agent's own model credential also
stays in the Guardian. See
[where credentials live](../../docs/sandbox-setup.md#where-credentials-live).

The prompt instructs the Agent to make one model-list call and one completion
call with at most 32 generated tokens. A request that times out or returns HTTP
5xx may be retried once; any HTTP 4xx stops the run. Those instructions are not
a hard spending cap: the Agent could make additional calls. A required code
check allows exactly one successful completion, after at most one retried
timeout or 5xx, and rejects any other completion attempt after execution.

The fixture uses the serverless `Qwen/Qwen3.5-9B` model with reasoning turned
off, so the 32-token reply contains text rather than only reasoning tokens. Edit
`fixtures/request.json` to try another model. Choose one from Together's
[serverless catalog](https://docs.together.ai/docs/serverless/models). The model
list still includes retired models, so the completion is the real availability
check: a retired model returns HTTP 400 `model_not_available`, and the prompt
tells the Agent to stop and say the fixture needs a serverless model.

The checks require trusted, successful GET /v1/models and POST
/v1/chat/completions evidence. Native Local cannot supply that evidence. Artifact
checks verify that the saved response includes a reply and token usage. HTTP
metadata proves
the requests occurred, but does not prove the exact request body or response
contents. Artifacts remain Agent-produced evidence.

API reference: [chat completions](https://docs.together.ai/reference/chat-completions).
Together's API reference does not cover `GET /v1/models`. It returns a bare
JSON array of model objects, each with an `id`, rather than OpenAI's
`{ "data": [...] }`, so the prompt states that shape.
