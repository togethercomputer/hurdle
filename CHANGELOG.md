# Changelog

## 0.5.0

Changes since 0.4.0 (published 2026-10-27).

**Breaking:** E2B and Together snapshot images are gone. Agents run in the
Together sandbox, or locally with `--environment local`.

- E2B and the Together snapshot path were removed; setup uses the Together
  sandbox. Rerunning setup switches a saved E2B or snapshot Runtime to the
  Together sandbox and keeps its store, Judge and Viewer. Together `cpuCount`
  and `memoryMiB` are gone (Together sizes the sandbox), and `maxLifetimeMs` is
  capped at Together's 1 hour.
- The Judge can run on a Claude Code OAuth token. It runs `claude -p` on your
  machine, isolated from your own Claude Code configuration, and readiness
  checks that Claude Code 2.1.288 or newer is installed.
- Guardian setup no longer adds `python3.12` to `~/.local/bin`. Earlier setups
  left a link there that points into Hurdle's cache (`~/.cache/hurdle` by
  default). If yours does, you can delete it.
  ([#113](https://github.com/Nutlope/hurdle/issues/113))

## 0.4.0

Changes since 0.3.0 (published 2026-10-15).

**API keys stay out of the sandbox.** On E2B and on Together's Hurdle socket,
the Agent's own model key and every Suite API key stay in the Guardian. The
Agent gets a random stand-in, and the Guardian swaps in the real key only on
requests to that key's own hosts.

**Breaking:**

- Codex now runs with OpenAI API keys only, and `CODEX_ACCESS_TOKEN` is
  ignored.
- On E2B and the Together socket, a Suite's API must read its key from the
  `Authorization` header.

See [Upgrading](#upgrading).

### Keys stay out of the sandbox

- **The Agent's model key stays in the Guardian on E2B.** Claude Code's
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and Codex's `CODEX_API_KEY`
  or `OPENAI_API_KEY`, no longer enter the VM where the Agent runs. The Agent
  gets a stand-in with the same public prefix, so its CLI still starts, and the
  Guardian swaps in the real key on requests to the Agent's model host. A run
  fails closed if a real key would reach the Agent's environment under any name.
  ([#90](https://github.com/Nutlope/hurdle/pull/90))
- **On E2B and the Together socket, every Suite API key stays in the Guardian,
  whatever the Task's checks.** Before, a Task with only advisory checks got the
  real `api.authorizationCredential` (for example `TOGETHER_API_KEY`) as an
  environment variable in the Agent's VM. A key with no API hosts to carry it is
  now refused before any sandbox starts.
  ([#97](https://github.com/Nutlope/hurdle/pull/97))
- **Together socket runs keep every key out of the sandbox.** Together runs
  without a `snapshotAlias` use Together's Hurdle socket: one WebSocket per run
  and a sandbox with no network of its own. Every connection the Agent opens
  goes over the socket to a Guardian on your machine. The Guardian holds the
  real keys and forwards only to public hosts, so the Agent can still reach the
  internet, from your machine's address.
  ([#96](https://github.com/Nutlope/hurdle/pull/96))
- **`validate` and `run` show where each Suite key goes,** for example
  `Keys  TOGETHER_API_KEY → api.together.ai, api.together.xyz`, or
  `→ the Agent's environment` when the Agent holds it. The run summary's
  "Target API credentials available to Agent" line follows the same rule.
  ([#100](https://github.com/Nutlope/hurdle/pull/100))
- **Docs say what each part can reach.** A "Where credentials live" table in
  the sandbox setup guide covers every key in every environment
  ([#90](https://github.com/Nutlope/hurdle/pull/90),
  [#96](https://github.com/Nutlope/hurdle/pull/96),
  [#97](https://github.com/Nutlope/hurdle/pull/97)). The authoring guide says
  Suite code (`checks.mjs`, `guard.mjs`) runs on your machine with your keys,
  that the Agent can call any endpoint on a key's hosts, and that you should use
  a dedicated low-balance key
  ([#100](https://github.com/Nutlope/hurdle/pull/100),
  [#104](https://github.com/Nutlope/hurdle/pull/104)).

### Guardian hardening

- **Keys are swapped only for the real destination.** The Guardian swaps a key
  in only on HTTPS to port 443, and only when the request line, HTTP/2
  `:authority` and every `Host` header name the host the connection actually
  reaches. A crafted `Host` header can't send the real key to another server.
  ([#90](https://github.com/Nutlope/hurdle/pull/90),
  [#96](https://github.com/Nutlope/hurdle/pull/96),
  [#98](https://github.com/Nutlope/hurdle/pull/98))
- **The Guardian refuses loopback, LAN and other non-public destinations.** This
  matters most on Together, where the Guardian runs on your machine.
  - Every check reads the real destination.
  - `CONNECT` is refused unless it targets port 443 (and, on E2B, a captured or
    model host).
  - Each name is resolved once, any non-public address is refused, and the
    connection is pinned to the checked address, which defeats DNS rebinding.
  - NAT64 and other IPv6 forms that carry an IPv4 address are judged by that
    address.
  - An error inside a check blocks the request instead of letting it through.

  ([#98](https://github.com/Nutlope/hurdle/pull/98))
- **Responses that repeat a real key get the stand-in back** before the Agent
  sees them: headers, whole and streamed bodies, and WebSocket messages. Encoded
  copies, such as base64, are not caught. The Guardian swaps a header only when
  it is exactly the stand-in or `Bearer <stand-in>`, so the Agent can't place
  the real key inside text a server echoes back.
  ([#103](https://github.com/Nutlope/hurdle/pull/103))
- **Stand-ins are checked harder.** Hurdle refuses any value that contains a
  real key, not only an exact copy, and any well-known key that first appears
  on a later turn. ([#98](https://github.com/Nutlope/hurdle/pull/98))
- **The Together Guardian stops when Hurdle stops,** even after a crash or
  `kill -9`. It deletes its directory, including the per-run CA key, and exits.
  It also stops itself 10 minutes after its sandbox's lifetime ends. Each new run
  clears leftover Guardian directories older than 26 hours.
  ([#102](https://github.com/Nutlope/hurdle/pull/102))
- **A key canary test** runs the real E2B, Together sandbox and Together socket
  code against a recording sandbox. It fails if any key, plain or encoded,
  appears in anything sent into the Agent's sandbox.
  ([#98](https://github.com/Nutlope/hurdle/pull/98))

### Together sandbox

- **`setup --sandbox together` works on Together's production Hurdle API**
  (`wss://hurdle.us.codesandbox.io/v1/compute/experimental/run`). Without a
  named snapshot it uses Together's Hurdle image, so no build is needed. Set
  `HURDLE_TOGETHER_RUN_URL` to use another endpoint.
  ([#96](https://github.com/Nutlope/hurdle/pull/96),
  [#98](https://github.com/Nutlope/hurdle/pull/98))
- **A socket that never opens ends the run after three minutes** as
  `environment.acquire-failed`, instead of waiting forever.
  ([#98](https://github.com/Nutlope/hurdle/pull/98))
- **Only the launch fields the sandbox needs cross the socket:** command, args,
  workspace layout, timeout and stdin. The Agent's environment, which holds only
  stand-ins, is sent separately.
  ([#98](https://github.com/Nutlope/hurdle/pull/98))
- See [the Together Hurdle socket](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/together-socket.md),
  now included in the package.

### Examples and preflight

- **The together-api example works again.** Together retired
  `meta-llama/Llama-3.3-70B-Instruct-Turbo` from serverless, so the example
  failed for everyone. It now uses serverless `Qwen/Qwen3.5-9B` with reasoning
  off. ([#91](https://github.com/Nutlope/hurdle/pull/91))
- **The together-api Agent gets clearer instructions:**
  - if the model is retired, it says so instead of stopping on a bare HTTP 400
    ([#92](https://github.com/Nutlope/hurdle/pull/92));
  - it sends its own User-Agent, because Together blocks Python `urllib`'s
    default ([#99](https://github.com/Nutlope/hurdle/pull/99));
  - it may retry one request that timed out or got HTTP 5xx, and the prompt
    states that `GET /v1/models` returns a bare array. The checks allow that one
    retry ([#106](https://github.com/Nutlope/hurdle/pull/106)).
- **`npm run preflight`'s Together check passes again.** It uses
  `Qwen/Qwen3.5-9B` and drops the embeddings step, since Together offers no
  serverless embedding models. ([#94](https://github.com/Nutlope/hurdle/pull/94))
- **The repository's `evals/together` Suites drop the `rag-search` task,** which
  needed serverless embeddings. These Suites aren't in the npm package.
  ([#95](https://github.com/Nutlope/hurdle/pull/95))

### First-run fixes

([#108](https://github.com/Nutlope/hurdle/pull/108))

- The starter `evals/README.md` that `init` writes uses `npx hurdle` commands
  that work in your project, not repository-only paths.
- `init` adds `.env.local`, `.hurdle/` and `.tae/` to `.gitignore`, keeping
  any existing entries, so the Local quickstart keeps your key out of git.
- `init`, `run` and readiness suggest `setup --yes`, as the README does. Without
  `--yes`, setup stops before building a sandbox image.
- A rejected E2B key names `E2B_API_KEY` and where to get one. A key needed by
  both the sandbox and a Task is listed once when missing.
- The README says how to install the Claude Code and Codex CLIs, and its image
  no longer pins an old version.
- **The Viewer lists only the Task's API calls.** On Together, the Guardian also
  records the Agent's own model, config and telemetry calls. A run's Captured
  API calls now list and count only calls to the Suite's API hosts. Stored
  results keep every call.

### Other

- The package's repository, homepage and issue links point at
  `github.com/Nutlope/hurdle`. ([#89](https://github.com/Nutlope/hurdle/pull/89))

### Upgrading

- **Codex users:** set `CODEX_API_KEY` or `OPENAI_API_KEY` in `.env.local`.
  `CODEX_ACCESS_TOKEN` is ignored: `validate` warns, and fails when it is the
  only Codex credential, and sandbox setup no longer accepts it. A ChatGPT token
  can act across your whole ChatGPT account, while an API key is limited to the
  API platform and can be capped with a project budget. If you ran Codex on a
  ChatGPT Business or Enterprise token, create an OpenAI API key.
  ([#101](https://github.com/Nutlope/hurdle/pull/101))
- **Suite APIs must read their key from `Authorization`.** Tasks with only
  advisory checks used to get the real key as an environment variable. On E2B
  and the Together socket they now get a stand-in, and the Guardian swaps the
  real key only into the `Authorization` header (`Bearer <key>` or the bare
  key). An API that reads its key from another header, a query parameter or the
  body gets the stand-in and rejects the request. A Suite key with no API hosts
  is refused before the run starts.
  ([#97](https://github.com/Nutlope/hurdle/pull/97))
- **Together projects set up with 0.3.0 keep their Hurdle snapshot,** even
  when you rerun setup. To move one to the Hurdle socket, remove `snapshotAlias`
  from `.hurdle/runtime/default.json`, then run
  `npx hurdle setup --sandbox together --yes`.

### Known limits

- **Local runs aren't a sandbox.** The Agent runs as you and can read
  `.env.local`.
- **Together with a `snapshotAlias`** still puts the Suite key in the Agent's VM
  for Tasks with only advisory checks.
- **The Agent can use a key it can't read.** It can call any endpoint on that
  key's hosts. Use a dedicated low-balance key and block costly Suite API calls
  in `guard.mjs`. `guard.mjs` doesn't cover the Agent's model key, so cap that
  key's budget with the provider.
- **Some APIs can mint a separate credential the Agent can read,** such as
  OpenAI realtime client secrets. Use keys you can revoke.
- **On E2B, the Guardian is a VM on E2B's infrastructure,** so E2B holds the real
  keys during a run.
- **Encoded copies of a key aren't caught.** The response scrubber replaces
  exact copies, and stored-evidence redaction removes exact and escaped copies.
  Neither catches encoded copies, such as base64, or a key split into pieces.

## 0.3.0

Published 2026-10-15. See [#88](https://github.com/Nutlope/hurdle/pull/88).

- Node.js 22.18 or newer is required.
- Sandbox setup defaults to E2B.
- Setup help, Viewer navigation, run details, and a cleaner Viewer and Compare.
- Check results print as runs finish, and a new kitchen-sink example.
- `run.agentReply` and `replyIncludes` read Codex's final reply.
- Codex 0.159.3, checks for outdated or incomplete sandbox images, and
  `view --port`.
- Fixes found in bill-free and live testing.
