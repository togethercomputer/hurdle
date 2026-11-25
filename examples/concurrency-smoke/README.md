# Three concurrent tasks

Three independent copy tasks exercise the default concurrency of three. Each
Task reads its own fixture and writes `answer.txt`; exact-content checks keep
outputs distinct. One Agent, one baseline Condition and one repeat produce
three evaluation cells. The Suite uses code checks and artifact capture.

Create the example in your project, then run it in the Together sandbox:

```sh
npx hurdle init concurrent-tasks --example concurrency-smoke
npx hurdle setup concurrent-tasks
npx hurdle run concurrent-tasks --view
```

Provide your Claude Code authentication and `TOGETHER_API_KEY` in `.env.local`.
The run uses up to three sandbox VMs, with one Guardian process on your machine
per active cell. This Suite makes no target API requests and uses no Judge.
Agent and sandbox usage follows the selected Runtime.

From the Hurdle repository, you can run the bundled example directly:

```sh
npx hurdle setup examples/concurrency-smoke/example.suite.mjs
npx hurdle run examples/concurrency-smoke/example.suite.mjs --view
```

A saved Runtime is selected automatically; skip setup if it is already
configured. To compare sequential execution, add `--concurrency 1` to `run`.
