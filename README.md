![Hurdle. Test how Claude Code and Codex use your API, SDK, or docs.](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/assets/readme-hero.png)

# Hurdle

Evaluate Claude Code and Codex on real tasks. Score results and inspect transcripts,
API calls, tool use, and artifacts in the results viewer.

## Quick start

Install Node.js 22.18+ and the Claude Code CLI, then create an evaluation:

```sh
npm install -g @anthropic-ai/claude-code
mkdir my-evals && cd my-evals
npx hurdle init
```

Add your Anthropic API key to `.env.local`:

```dotenv
ANTHROPIC_API_KEY=your-api-key
```

Check readiness, run the starter, and open the results viewer:

```sh
npx hurdle validate
npx hurdle run --view
```

Local execution is not a security sandbox. Use trusted tasks. `init` adds
`.env.local` and `.hurdle/` to `.gitignore`; keep `.env.local` out of version
control. Agent usage may be billed.

Results are saved in `.hurdle/`. Reopen them with `npx hurdle view`, adding
`--port 3001` if port 3000 is busy.

## Try the Together API

Create a Together API key:

1. Sign in to [Together](https://api.together.ai) and select your project.
2. Open [API Keys](https://api.together.ai/settings/projects/~current/api-keys),
   click **Create key**, name it `hurdle-evals`, then click **Create Key**.
3. Copy the key immediately (it's shown only once).

Add it to `.env.local` alongside your agent credential:

```dotenv
TOGETHER_API_KEY=your-together-api-key
```

Run the API example in a Together sandbox and inspect captured HTTP activity:

```sh
npx hurdle init api-evals --example together-api
npx hurdle setup api-evals
npx hurdle run api-evals --view
```

The agent lists models, makes a short completion, and saves `completion.json`.
The sandbox has no network of its own. It reaches the world only through one
socket back to a Guardian process on your machine; your keys never enter the
sandbox, and the Guardian swaps them into requests on the way out. Nothing is
built on your side. Sandbox and API usage may be billed.

See [the Together Hurdle socket](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/together-socket.md)
for the contract and
[sandbox and storage setup](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/sandbox-setup.md)
for Postgres.

## Choose an agent

| Agent | Create a starter | Credential in `.env.local` |
| --- | --- | --- |
| Claude Code | `npx hurdle init` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | `npx hurdle init --agent codex` | `OPENAI_API_KEY` |

Local runs use the `claude` or `codex` command on your `PATH`. Install the one you
need, and update Codex if `validate` says it does not list the starter model:

```sh
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
```

Sandbox runs install the Agent CLI in the sandbox image, so they need no local
install. Generate a Claude subscription token with `claude setup-token`.
Codex runs with an OpenAI API key only (`OPENAI_API_KEY` or `CODEX_API_KEY`), not a ChatGPT login.

Starters use Opus 5.5 or GPT-6.1 Sol with medium effort. Discover other models:

```sh
npx hurdle models --agent claude-code
npx hurdle models --agent codex
```

See [authoring](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/authoring.md)
for authentication options, model overrides, and reasoning effort.

## Tasks and checks

A Suite selects Tasks and agents. Each Task keeps its prompt, fixtures, and checks together:

```text
evals/
├── example.suite.mjs
└── tasks/
    └── copy-message/
        ├── prompt.md
        ├── checks.mjs
        └── fixtures/message.txt
```

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

Score with `code`, an LLM `judge`, or `hybrid` checks. See
[authoring](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/authoring.md) to write your own Suite and Tasks.

## From source

```sh
git clone https://github.com/Nutlope/hurdle.git
cd hurdle
cp .env.example .env.local
npm run setup
```

Add your agent credentials to `.env.local`, then run the starter:

```sh
npm run hurdle -- validate examples/copy-message/example.suite.mjs
npm run hurdle -- run examples/copy-message/example.suite.mjs --view
```

## Documentation

- [Authoring](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/authoring.md)
- [Sandbox and storage setup](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/sandbox-setup.md)
- [Changelog](https://cdn.jsdelivr.net/npm/hurdle@latest/CHANGELOG.md)
- [Contributing](https://cdn.jsdelivr.net/npm/hurdle@latest/CONTRIBUTING.md) · [Security](https://cdn.jsdelivr.net/npm/hurdle@latest/SECURITY.md)
