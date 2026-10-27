# Three concurrent tasks

Three independent copy tasks exercise the default concurrency of three. Each
Task reads its own fixture and writes `answer.txt`; exact-content checks keep
outputs distinct. One Agent, one baseline Condition and one repeat produce
three evaluation cells. The Suite uses code checks and artifact capture.

Create the example in your project, then use the default E2B sandbox:

```sh
npx hurdle init concurrent-tasks --example concurrency-smoke
npx hurdle setup concurrent-tasks --yes
npx hurdle run concurrent-tasks --view
```

Provide your Claude Code authentication and `E2B_API_KEY` in `.env.local`.
The run uses up to three workload VMs, each with its own Guardian VM. This Suite
makes no target API requests and uses no Judge. Agent and sandbox usage follows
the selected Runtime. To use Together sandbox instead, add `--sandbox together`
to setup and provide `TOGETHER_API_KEY`; it then uses up to three VMs.

From the Hurdle repository, you can run the bundled example directly:

```sh
npx hurdle setup examples/concurrency-smoke/example.suite.mjs --yes
npx hurdle run examples/concurrency-smoke/example.suite.mjs --view
```

A saved Runtime is selected automatically; skip setup if it is already
configured. To compare sequential execution, add `--concurrency 1` to `run`.
