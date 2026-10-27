# Local Hurdle experiments

Source-only helpers for previewing CLI output.
Nothing in this directory is included in the npm package. Run these commands
from the repository root.

## Review the CLI and ASCII headers

```sh
node harness/experiments/preview-cli.mjs brand
node harness/experiments/preview-cli.mjs readiness
node harness/experiments/preview-cli.mjs view
```

Choose a single header with `brand 1`, `brand 2`, or `brand 3`. These are previews,
not an applied branding change. `readiness fail` previews rejection and recovery
text. Previews make no provider requests, run no agent, and start no server.

To try the draft against your existing quickstart project, run the source CLI
from that directory, replacing `/path/to/hurdle` with your checkout:

```sh
node /path/to/hurdle/harness/bin/hurdle.mjs validate
node /path/to/hurdle/harness/bin/hurdle.mjs view
```

The CLI uses one line per authentication check, green/red/yellow status
symbols in a terminal, and a compact Viewer display. `NO_COLOR` disables color;
redirected output has no styling. Stop your existing Viewer before opening the
same store on port 3000.

## Preview every run result

Run the kitchen-sink example with a scripted agent instead of Claude Code:

```sh
node harness/experiments/preview-cli.mjs run
node harness/experiments/preview-cli.mjs run --view
```

The real CLI, Run Engine, checks and Result Store produce pass, fail,
incomplete and unknown runs, advisory failures and skipped checks in a few
seconds. Nothing is billed and no credentials are needed. Results go to a
temporary store that is removed on exit; `--view` opens them in the Viewer
until you press Ctrl+C. The scripted agent in `kitchen-sink-agent.mjs` is also
the fixture for `harness/test/kitchen-sink.test.mjs`, so the preview and the
example's designed results stay in step.
