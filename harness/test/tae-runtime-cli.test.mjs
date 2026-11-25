import { cliExecutable } from "../lib/terminal-output.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { createFrameworkCli } from "../bin/hurdle.mjs";
import { reportExecutionProgress } from "../lib/execution-progress.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";

const sourceExecutable = cliExecutable();

function writeJudgePack(root, model = "judge-model", verdict = "hybrid") {
  mkdirSync(join(root, "tasks", "sample"), { recursive: true });
  writeFileSync(join(root, "tasks", "sample", "prompt.md"), "Write the answer.");
  writeFileSync(join(root, "tasks", "sample", "checks.mjs"),
    'import { defineChecks } from "tae";\nexport default defineChecks(run => { run.check({id:"exact",passed:true,summary:"ok"});'
    + (verdict === "code" ? "" : 'run.judge("Pass only when the evidence proves the answer.");') + ' });\n');
  writeFileSync(join(root, "example.suite.mjs"), 'import { defineSuite } from "tae";\nexport default defineSuite(' + JSON.stringify({
    tasks: ["./tasks/sample"],
    agents: [{ runner: "claude-code" }, { runner: "codex" }],
    conditions: { baseline: { skills: [], mcpServers: [] } },
    repeats: 1,
    verdict,
    ...(verdict === "code" ? {} : { judge: { model } }),
  }) + ');\n');
}

function io(cwd) {
  let stdout = "";
  let stderr = "";
  return {
    cwd,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    read() { return { stdout, stderr }; },
  };
}

function ttyIo(cwd) {
  const streams = io(cwd);
  streams.stderr.isTTY = true;
  return streams;
}

function completedResult() {
  return {
    status: "completed",
    summary: {
      plannedCells: 1,
      plannedRepeats: 1,
      attempts: 1,
      retriesPerformed: 0,
      terminalVerdicts: { pass: 1, fail: 0, incomplete: 0, unknown: 0 },
      authorityCoverage: {
        recordedRuns: 1,
        totalRuns: 1,
        judgeCompletedRuns: 1,
        judgeRequiredRuns: 1,
        agreements: 1,
        comparableRuns: 1,
        disagreements: 0,
      },
      nonPasses: [],
      omittedNonPasses: 0,
    },
  };
}

test("hurdle run displays live cell progress in terminals and stable lines in logs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "tae-cli-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "unused", "code");
  for (const isTTY of [true, false]) {
    const streams = isTTY ? ttyIo(root) : io(root);
    const output = () => stripVTControlCharacters(streams.read().stderr + streams.read().stdout).replaceAll("\r", "");
    const events = [];
    const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
      env: {},
      processTarget: new EventEmitter(),
      async openLocalResultStore() { return {}; },
      createAgentAdapter() { return {}; },
      createLocalExecutionEnvironment() { return {}; },
      executionProgressObserver: { observe(event) {
        events.push(event);
        throw new Error("Observer failure must not affect execution");
      } },
      createRunEngine({ progressObserver }) {
        assert.match(output(), /Preparing evaluations/);
        return { async run() {
          reportExecutionProgress(progressObserver, { kind: "matrix-ready", total: 2 });
          for (const [index, adapterId] of ["claude-code", "codex"].entries()) {
            const cell = { ordinal: index + 1, total: 2, taskId: "sample", conditionId: "baseline", adapterId, repeatOrdinal: 1, repeatTotal: 1 };
            reportExecutionProgress(progressObserver, { kind: "cell-started", cell, secret: "must-not-display" });
            assert.ok(output().includes(`[${index + 1}/2] sample · baseline`), "progress must appear before the run returns");
            assert.match(output(), /Evaluating/);
            if (index === 0) {
              for (const [provider, role, id] of [["together", "guardian", "together-guardian-one"], ["together", "agent", "together-one"]]) {
                reportExecutionProgress(progressObserver, {
                  kind: "environment-resource-allocated", executionId: "execution-one", environmentId: provider,
                  resource: { provider, role, id, agentToken: "must-not-display" },
                });
              }
              assert.doesNotMatch(output(), /guardian-one|agent-one|together-one|together-guardian-one|Dashboard|Inspect|together-sandbox sandboxes get/);
              for (const provider of ["together"]) {
                for (const [status, label] of [
                  ["starting-guardian", "Starting Guardian"], ["guardian-started", "Guardian started"],
                  ["starting-sandbox", "Starting sandbox"], ["sandbox-started", "Sandbox started"],
                  ["preparing-environment", "Preparing environment"], ["preparing-workspace", "Preparing workspace"],
                  ["agent-running", "Agent running"], ["collecting-results", "Collecting results"],
                  ["stopping-sandboxes", "Stopping sandboxes"],
                ]) {
                  reportExecutionProgress(progressObserver, { kind: "environment-status",
                    executionId: "execution-one", environmentId: provider, status, token: "must-not-display" });
                  assert.ok(output().includes(label), "status appears before execution completes");
                }
              }
            }
            t.mock.timers.tick(160);
            reportExecutionProgress(progressObserver, { kind: "cell-finalizing", cell });
            assert.match(output(), /Finalizing results/);
            reportExecutionProgress(progressObserver, {
              kind: "cell-completed", cell,
              terminal: {
                id: `run_${index}`,
                verdict: index === 0 ? "pass" : "incomplete",
                runTrustReasons: [{
                  code: "environment.nonzero-exit",
                  summary: "Claude Code could not run because the Anthropic credit balance is too low.",
                }],
                verdictReasons: [{
                  code: "check.artifact-schema",
                  summary: "rag_results.json was unavailable.",
                }],
              },
            });
            if (index === 1) assert.match(
              output(),
              /incomplete[^\n]*\n  environment\.nonzero-exit: Claude Code could not run because the Anthropic credit balance is too low\.\n  check\.artifact-schema: rag_results\.json was unavailable\./,
            );
          }
          const result = completedResult();
          result.summary.plannedCells = result.summary.plannedRepeats = result.summary.attempts = 2;
          result.summary.terminalVerdicts.incomplete = 1;
          result.summary.nonPasses = [{
            id: "run_1", snapshotFingerprint: "sha256:example", verdict: "incomplete", invocation: { repeatOrdinal: 1 },
            runTrustReasons: [{ code: "environment.nonzero-exit", summary: "Claude Code could not run because the Anthropic credit balance is too low." }],
            verdictReasons: [{ code: "check.artifact-schema", summary: "rag_results.json was unavailable." }],
          }];
          return result;
        } };
      },
    });
    assert.equal(await cli.main(["run", "example.suite.mjs"], streams), 1);
    assert.match(output(), /✓ \[1\/2\] sample · baseline · Claude Code · pass/);
    assert.match(output(), /! \[2\/2\] sample · baseline · Codex · incomplete/);
    assert.equal(output().match(/environment\.nonzero-exit/g)?.length, 1, "passing cells omit reasons and the summary does not duplicate live reasons");
    assert.doesNotMatch(output(), /must-not-display|Observer failure|run-failed/);
    assert.equal(events.length, 18, "the existing observer still receives every event");
    if (!isTTY) {
      assert.equal(streams.read().stderr, "");
      assert.doesNotMatch(streams.read().stdout, /\u001b|\r|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    }
    const stopped = streams.read();
    t.mock.timers.tick(1000);
    assert.deepEqual(streams.read(), stopped, "no spinner survives completion");
  }
});

test("hurdle run lists each run's checks as it completes, like a test report", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "tae-cli-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "unused", "code");
  const check = (id, outcome = "pass", effectiveAuthority = "required", summary = "Fine.") => ({
    id, authoredAuthority: "required", effectiveAuthority, outcome, summary, evidenceRefs: [],
  });
  const runs = [
    { verdict: "pass", checks: [check("completed"), check("answer"), check("exact-copy")] },
    {
      verdict: "fail",
      checks: [
        check("completed"),
        check("exact-copy", "fail", "required", "answer.txt must match the fixture exactly."),
        check("tone", "fail", "advisory", "The reply should be friendly."),
      ],
      verdictReasons: [{ code: "check.exact-copy", summary: "answer.txt must match the fixture exactly." }],
    },
    {
      verdict: "incomplete",
      checks: [check("completed"), check("answer", "skip", "required", "The captured artifact was unavailable.")],
      omittedCheckCount: 2,
      runTrustReasons: [{ code: "environment.cleanup-unconfirmed", summary: "Sandbox cleanup could not be confirmed." }],
      verdictReasons: [{ code: "check.answer", summary: "The captured artifact was unavailable." }],
    },
  ];
  for (const isTTY of [true, false]) {
    const streams = isTTY ? ttyIo(root) : io(root);
    const output = () => stripVTControlCharacters(streams.read().stderr + streams.read().stdout).replaceAll("\r", "");
    const live = [];
    const cli = createFrameworkCli({
      async checkAgentReadiness() { return { ok: true, checks: [] }; },
      env: {},
      processTarget: new EventEmitter(),
      async openLocalResultStore() { return {}; },
      createAgentAdapter() { return {}; },
      createLocalExecutionEnvironment() { return {}; },
      createRunEngine({ progressObserver }) {
        return { async run() {
          reportExecutionProgress(progressObserver, { kind: "matrix-ready", total: runs.length });
          for (const [index, run] of runs.entries()) {
            const cell = { ordinal: index + 1, total: runs.length, taskId: "sample", conditionId: "baseline", adapterId: "claude-code", repeatOrdinal: 1, repeatTotal: 1 };
            reportExecutionProgress(progressObserver, { kind: "cell-started", cell });
            reportExecutionProgress(progressObserver, { kind: "cell-completed", cell, terminal: { id: `run_${index}`, verdictReasons: [], ...run } });
            live.push(output());
          }
          const result = completedResult();
          result.summary.plannedCells = result.summary.plannedRepeats = result.summary.attempts = runs.length;
          result.summary.terminalVerdicts = { pass: 1, fail: 1, incomplete: 1, unknown: 0 };
          result.summary.authorityCoverage.judgeRequiredRuns = 0;
          result.summary.nonPasses = [1, 2].map((index) => ({
            id: `run_${index}`, verdict: runs[index].verdict, verdictReasons: runs[index].verdictReasons,
          }));
          return result;
        } };
      },
    });
    assert.equal(await cli.main(["run", "example.suite.mjs"], streams), 1);
    assert.doesNotMatch(output(), /run-failed/);
    assert.match(live[0], /✓ \[1\/3\] sample · baseline · Claude Code · pass {2}\d+s\n {2}✓ completed\n {2}✓ answer\n {2}✓ exact-copy\n/,
      "a run's checks appear as soon as it completes");
    assert.match(live[1], /✗ \[2\/3\] [^\n]* · fail {2}\d+s\n {2}✓ completed\n {2}✗ exact-copy {2}answer\.txt must match the fixture exactly\.\n {2}✗ tone \(advisory\) {2}The reply should be friendly\.\n/);
    assert.match(live[2], /! \[3\/3\] [^\n]* · incomplete {2}\d+s\n {2}✓ completed\n {2}– answer {2}The captured artifact was unavailable\.\n {2}… 2 more checks\n {2}environment\.cleanup-unconfirmed: Sandbox cleanup could not be confirmed\.\n/,
      "reasons that are not checks follow the check list");
    assert.equal(output().match(/answer\.txt must match the fixture exactly/g)?.length, 1,
      "a failed check is explained once, not repeated as a reason or summary row");
    assert.doesNotMatch(output(), /check\.exact-copy|check\.answer|Reason/);
    assert.match(output(), /\n {2}Runs {6}1 passed · 1 failed · 1 incomplete\n {2}Checks {4}5 passed · 2 failed · 1 skipped\n/);
    if (!isTTY) assert.doesNotMatch(streams.read().stdout, /\u001b|\r/);
  }
});

test("hurdle run stops its startup spinner when the Result Store cannot open", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "tae-store-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "unused", "code");
  for (const code of [null, "store.schema-not-ready"]) {
    const streams = ttyIo(root);
    const failure = async () => { throw Object.assign(new Error("private-store-error"), { code }); };
    const cli = createFrameworkCli({
      async checkAgentReadiness() { return { ok: true, checks: [] }; },
      env: { TEST_DATABASE_URL: "synthetic" },
      openLocalResultStore: failure, openPostgresResultStore: failure,
    });
    const args = ["run", "example.suite.mjs"];
    if (code) {
      writeFileSync(join(root, "runtime.json"), JSON.stringify({ schemaVersion: 1, environment: { kind: "local" },
        resultStore: { kind: "postgres", databaseUrlEnv: "TEST_DATABASE_URL", artifactRoot: "artifacts" } }));
      args.push("--runtime", "runtime.json");
    }
    assert.equal(await cli.main(args, streams), 1);
    assert.match(streams.read().stderr, /Opening result store/);
    assert.ok(streams.read().stderr.includes(code ?? "store-unavailable"));
    if (code) assert.ok(streams.read().stdout.includes(`${sourceExecutable} setup example.suite.mjs --store postgres`));
    assert.doesNotMatch(streams.read().stderr, /private-store-error/);
    const stopped = streams.read();
    t.mock.timers.tick(1000);
    assert.deepEqual(streams.read(), stopped);
  }
});

test("hurdle run preflights authority before resolving secrets or opening Postgres", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-runtime-mismatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "required-model");
  writeFileSync(join(root, "runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    environment: {
      kind: "together",
      apiKeyEnv: "TEST_TOGETHER_KEY",
      settings: { maxLifetimeMs: 120_000 },
    },
    resultStore: {
      kind: "postgres",
      databaseUrlEnv: "TEST_DATABASE_URL",
      artifactRoot: "artifacts",
    },
    judge: {
      kind: "anthropic-json-v1",
      model: "wrong-model",
      credentialEnv: "TEST_JUDGE_KEY",
    },
  })}\n`);
  let secretRead = false;
  let storeOpened = false;
  const env = new Proxy({}, {
    get(_target, name) {
      if (name === "TEST_DATABASE_URL" || name === "TEST_JUDGE_KEY") secretRead = true;
      return undefined;
    },
  });
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env,
    async openPostgresResultStore() { storeOpened = true; throw new Error("must not open"); },
  });
  const streams = io(root);

  const exit = await cli.main([
    "run",
    "example.suite.mjs",
    "--runtime",
    "runtime.json",
  ], streams);

  assert.equal(exit, 1);
  assert.equal(secretRead, false);
  assert.equal(storeOpened, false);
  assert.match(streams.read().stderr, /authority\.judge-capability-mismatch/);
});

test("without a Runtime file, hurdle run judges with the Suite's Judge model", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-runtime-default-judge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "suite-judge-model");
  let judgeConfig = null;
  let engineJudge = null;
  const cli = createFrameworkCli({
    async checkAgentReadiness({ judgeCredentialName }) {
      assert.equal(judgeCredentialName, "ANTHROPIC_API_KEY");
      return { ok: true, checks: [] };
    },
    env: { ANTHROPIC_API_KEY: "test-judge-key" },
    processTarget: new EventEmitter(),
    createAnthropicJsonJudge(config) {
      judgeConfig = config;
      return { id: "anthropic-json-v1", model: config.model, inputSchemaVersions: [2], maxTimeoutMs: 120_000, async judge() {} };
    },
    createRunEngine({ judge }) {
      engineJudge = judge;
      return { async run() { return completedResult(); } };
    },
  });
  const streams = io(root);

  const exit = await cli.main(["run", "example.suite.mjs", "--agent", "claude-code", "--store", "results"], streams);

  assert.equal(exit, 0, streams.read().stderr);
  const { onFailure, ...config } = judgeConfig;
  assert.deepEqual(config, { model: "suite-judge-model", apiKey: "test-judge-key" });
  assert.equal(typeof onFailure, "function");
  assert.ok(engineJudge);
});

test("without a Runtime file, an OAuth-only environment judges through CLAUDE_CODE_OAUTH_TOKEN and reports why the Judge failed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-runtime-oauth-judge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "suite-judge-model");
  let judgeConfig = null;
  const reason = "Claude Code (claude) is not installed or not on PATH; the Judge needs it for an OAuth token.";
  const cli = createFrameworkCli({
    async checkAgentReadiness({ judgeCredentialName }) {
      assert.equal(judgeCredentialName, "CLAUDE_CODE_OAUTH_TOKEN");
      return { ok: true, checks: [] };
    },
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-token" },
    processTarget: new EventEmitter(),
    createAnthropicJsonJudge(config) {
      judgeConfig = config;
      return { id: "anthropic-json-v1", model: config.model, inputSchemaVersions: [2], maxTimeoutMs: 120_000, async judge() {} };
    },
    createRunEngine() {
      return { async run() {
        // The same reason twice is reported once.
        judgeConfig.onFailure(reason);
        judgeConfig.onFailure(reason);
        const result = completedResult();
        result.summary.authorityCoverage = { ...result.summary.authorityCoverage, judgeCompletedRuns: 0 };
        return result;
      } };
    },
  });
  const streams = io(root);

  const exit = await cli.main(["run", "example.suite.mjs", "--agent", "claude-code", "--store", "results"], streams);

  assert.equal(exit, 0, streams.read().stderr);
  assert.equal(judgeConfig.apiKey, "sk-ant-oat01-test-token");
  const stdout = stripVTControlCharacters(streams.read().stdout);
  assert.match(stdout, /^  Judge\s+0\/1 completed$/m);
  assert.equal(stdout.split(reason).length - 1, 1, stdout);
  assert.match(stdout, /^  Judge issue\s+Claude Code \(claude\) is not installed or not on PATH/m);
  assert.doesNotMatch(stdout, /sk-ant-oat01-test-token/);
});

test("hurdle run composes Postgres sidecar and the required Judge after preflight", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-runtime-postgres-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root);
  const runtimePath = join(root, "config", "runtime.json");
  mkdirSync(join(root, "config"));
  writeFileSync(runtimePath, `${JSON.stringify({
    schemaVersion: 1,
    environment: { kind: "local" },
    resultStore: {
      kind: "postgres",
      databaseUrlEnv: "TEST_DATABASE_URL",
      artifactRoot: "../artifacts",
    },
    judge: {
      kind: "anthropic-json-v1",
      model: "judge-model",
      credentialEnv: "TEST_JUDGE_KEY",
    },
  })}\n`);
  const calls = [];
  const store = Object.freeze({ kind: "fake-store" });
  const judge = Object.freeze({ id: "anthropic-json-v1", model: "judge-model" });
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {
      TEST_DATABASE_URL: "postgresql://secret-database",
      TEST_JUDGE_KEY: "secret-judge-key",
    },
    async openPostgresResultStore(input) { calls.push(["open", input]); return store; },
    async closePostgresResultStore(value) { calls.push(["close", value]); },
    createAnthropicJsonJudge(input) { calls.push(["judge", input]); return judge; },
    createRunEngine(input) {
      calls.push(["engine", input]);
      return { async run() { return completedResult(); } };
    },
  });
  const streams = io(root);

  const exit = await cli.main([
    "run",
    "example.suite.mjs",
    "--runtime",
    "config/runtime.json",
    "--agent",
    "codex",
  ], streams);

  assert.equal(exit, 0, streams.read().stderr);
  assert.deepEqual(calls[0], ["open", {
    connectionString: "postgresql://secret-database",
    localArtifactRoot: join(root, "artifacts"),
  }]);
  const { onFailure, ...judgeConfig } = calls[1][1];
  assert.equal(calls[1][0], "judge");
  assert.equal(typeof onFailure, "function");
  assert.deepEqual(judgeConfig, {
    model: "judge-model",
    apiKey: "secret-judge-key",
  });
  assert.equal(calls[2][0], "engine");
  assert.equal(calls[2][1].resultStore, store);
  assert.equal(calls[2][1].judge, judge);
  assert.deepEqual(calls.at(-1), ["close", store]);
  assert.doesNotMatch(`${streams.read().stdout}\n${streams.read().stderr}`, /secret/);
  assert.match(streams.read().stdout, /^  Runtime\s+config\/runtime.json\n  Execution\s+Local\n  Store\s+Postgres$/m);
  assert.match(streams.read().stdout, /^  Artifacts\s+artifacts$/m);
});

test("a configured but disabled Judge does not read credentials or create a provider", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-runtime-disabled-judge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "judge-model", "code");
  writeFileSync(join(root, "runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    environment: {
      kind: "together",
      apiKeyEnv: "TEST_TOGETHER_KEY",
      settings: { maxLifetimeMs: 120_000 },
    },
    resultStore: { kind: "local", root: "results" },
    judge: {
      kind: "anthropic-json-v1",
      model: "judge-model",
      credentialEnv: "MISSING_JUDGE_KEY",
    },
  })}\n`);
  let credentialRead = false;
  let providerCreated = false;
  const executionProgressObserver = Object.freeze({ observe() {} });
  const env = new Proxy({}, {
    get(_target, name) {
      if (name === "MISSING_JUDGE_KEY") credentialRead = true;
      if (name === "TEST_TOGETHER_KEY") return "together-secret";
      return undefined;
    },
  });
  const environment = Object.freeze({ kind: "controlled-together" });
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env,
    executionProgressObserver,
    async openLocalResultStore() { return Object.freeze({}); },
    createTogetherExecutionEnvironment(input) {
      assert.equal(input.apiKey, "together-secret");
      assert.equal(typeof input.progressObserver.observe, "function");
      return environment;
    },
    createAnthropicJsonJudge() { providerCreated = true; throw new Error("must not create"); },
    createRunEngine(input) {
      assert.equal("judge" in input, false);
      assert.equal(input.executionEnvironment, environment);
      assert.equal(typeof input.progressObserver.observe, "function");
      return { async run(runInput) {
        assert.deepEqual(runInput.environmentSettings, { maxLifetimeMs: 120_000 });
        const result = completedResult();
        result.summary.authorityCoverage.judgeCompletedRuns = 0;
        result.summary.authorityCoverage.judgeRequiredRuns = 0;
        result.summary.authorityCoverage.agreements = 0;
        result.summary.authorityCoverage.comparableRuns = 0;
        return result;
      } };
    },
  });
  const streams = io(root);

  const exit = await cli.main(["run", "example.suite.mjs", "--runtime", "runtime.json"], streams);

  assert.equal(exit, 0, streams.read().stderr);
  assert.equal(credentialRead, false);
  assert.equal(providerCreated, false);
});

test("hurdle run reports a Postgres close failure without exposing its connection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-runtime-close-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root);
  writeFileSync(join(root, "runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    environment: { kind: "local" },
    resultStore: {
      kind: "postgres",
      databaseUrlEnv: "TEST_DATABASE_URL",
      artifactRoot: "artifacts",
    },
    judge: {
      kind: "anthropic-json-v1",
      model: "judge-model",
      credentialEnv: "TEST_JUDGE_KEY",
    },
  })}\n`);
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {
      TEST_DATABASE_URL: "postgresql://close-secret",
      TEST_JUDGE_KEY: "judge-secret",
    },
    async openPostgresResultStore() { return Object.freeze({}); },
    async closePostgresResultStore() { throw new Error("postgresql://close-secret"); },
    createAnthropicJsonJudge() { return Object.freeze({}); },
    createRunEngine() { return { async run() { return completedResult(); } }; },
  });
  const streams = io(root);

  const exit = await cli.main(["run", "example.suite.mjs", "--runtime", "runtime.json"], streams);

  assert.equal(exit, 1);
  assert.equal(
    streams.read().stderr,
    "✗ hurdle [store-close-failed] The configured Result Store could not be closed cleanly.\n",
  );
  assert.doesNotMatch(`${streams.read().stdout}\n${streams.read().stderr}`, /close-secret/);
});

test("hurdle run forwards Local termination through cleanup and closes Postgres", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = mkdtempSync(join(tmpdir(), "tae-runtime-local-signal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initStreams = io(root);
  assert.equal(await createFrameworkCli().main(["init"], initStreams), 0);
  writeFileSync(join(root, "runtime.json"), `${JSON.stringify({
    schemaVersion: 1,
    environment: { kind: "local" },
    resultStore: {
      kind: "postgres",
      databaseUrlEnv: "TEST_DATABASE_URL",
      artifactRoot: "artifacts",
    },
  })}\n`);
  const processTarget = new EventEmitter();
  const store = Object.freeze({ kind: "fake-store" });
  let closeCount = 0;
  let receivedSignal = null;
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: { TEST_DATABASE_URL: "postgresql://signal-secret" },
    processTarget,
    async openPostgresResultStore() { return store; },
    async closePostgresResultStore(value) {
      assert.equal(value, store);
      closeCount += 1;
    },
    createRunEngine() {
      return {
        async run(input) {
          assert.ok(input.signal instanceof AbortSignal);
          await new Promise((resolve) => {
            input.signal.addEventListener("abort", resolve, { once: true });
            queueMicrotask(() => processTarget.emit("SIGTERM"));
          });
          receivedSignal = input.signal.aborted;
          const result = completedResult();
          result.summary.terminalVerdicts = {
            pass: 0,
            fail: 0,
            incomplete: 1,
            unknown: 0,
          };
          return result;
        },
      };
    },
  });
  const streams = ttyIo(root);

  const exit = await cli.main([
    "run",
    "evals/example.suite.mjs",
    "--runtime",
    "runtime.json",
  ], streams);

  assert.equal(exit, 143);
  assert.equal(receivedSignal, true);
  assert.equal(closeCount, 1);
  assert.equal(processTarget.listenerCount("SIGINT"), 0);
  assert.equal(processTarget.listenerCount("SIGTERM"), 0);
  assert.doesNotMatch(`${streams.read().stdout}\n${streams.read().stderr}`, /signal-secret/);
  const stopped = streams.read();
  t.mock.timers.tick(1000);
  assert.deepEqual(streams.read(), stopped, "no spinner survives interruption");
});

test("hurdle run cancels the evaluation when its terminal closes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-runtime-local-hangup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(await createFrameworkCli().main(["init"], io(root)), 0);
  const processTarget = new EventEmitter();
  let receivedSignal = null;
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    processTarget,
    createRunEngine() {
      return {
        async run(input) {
          // Without a handler, SIGHUP would end the CLI and orphan the Agent.
          await new Promise((resolve) => {
            input.signal.addEventListener("abort", resolve, { once: true });
            queueMicrotask(() => processTarget.emit("SIGHUP"));
          });
          receivedSignal = input.signal.aborted;
          const result = completedResult();
          result.summary.terminalVerdicts = { pass: 0, fail: 0, incomplete: 1, unknown: 0 };
          return result;
        },
      };
    },
  });

  const exit = await cli.main(["run", "evals/example.suite.mjs", "--store", "results"], io(root));

  assert.equal(exit, 129);
  assert.equal(receivedSignal, true);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(processTarget.listenerCount(signal), 0, signal);
  }
});

test("hurdle run --view opens the recorded Local store and preserves a non-pass", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-run-view-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initStreams = io(root);
  assert.equal(await createFrameworkCli().main(["init"], initStreams), 0);
  const calls = [];
  const result = completedResult();
  result.summary.terminalVerdicts = {
    pass: 0,
    fail: 0,
    incomplete: 1,
    unknown: 0,
  };
  result.summary.nonPasses = [{
    id: "run_failed", snapshotFingerprint: "sha256:example", verdict: "incomplete",
    invocation: { repeatOrdinal: 1 },
    verdictReasons: [{ code: "environment.acquire-failed", summary: "Sandbox execution failed before evidence capture." }],
  }];
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    async openLocalResultStore() { return Object.freeze({}); },
    createRunEngine() {
      return { async run() { return result; } };
    },
    async launchViewer(input) {
      calls.push(input);
      input.onReady("http://127.0.0.1:3000");
      return { kind: "stopped", exitCode: 0, url: "http://127.0.0.1:3000" };
    },
  });
  const streams = io(root);

  const exit = await cli.main([
    "run",
    "evals/example.suite.mjs",
    "--store",
    "results",
    "--view",
  ], streams);

  assert.equal(exit, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].storeEnvironment, {
    HURDLE_RESULT_STORE_MODE: "local",
    HURDLE_RESULT_STORE_ROOT: join(root, "results"),
  });
  assert.equal(calls[0].onboarding.projectDirectory, root);
  assert.equal(calls[0].onboarding.commands, "npx hurdle run --environment local --store results --view");
  assert.match(streams.read().stdout, /^  Result\s+Needs attention$/m);
  assert.match(streams.read().stdout, /^  Runs\s+1 incomplete$/m);
  assert.match(streams.read().stdout, /^  Reason\s+Sandbox execution failed before evidence capture\.$/m);
  assert.doesNotMatch(streams.read().stdout, /run_failed|sha256:/);
  assert.match(streams.read().stdout, /URL\s+http:\/\/127\.0\.0\.1:3000/);
});

test("hurdle run --view does not open a Viewer for a rejected matrix", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-run-view-rejected-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initStreams = io(root);
  assert.equal(await createFrameworkCli().main(["init"], initStreams), 0);
  let viewerLaunches = 0;
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    async openLocalResultStore() { return Object.freeze({}); },
    createRunEngine() {
      return {
        async run() {
          return {
            status: "rejected",
            summary: { plannedCells: 1 },
            diagnostics: [{
              category: "capability",
              code: "matrix.capability-missing",
              message: "The selected Environment cannot capture trusted egress.",
            }],
          };
        },
      };
    },
    async launchViewer() {
      viewerLaunches += 1;
      return { kind: "stopped", exitCode: 0 };
    },
  });
  const streams = io(root);

  const exit = await cli.main([
    "run",
    "evals/example.suite.mjs",
    "--view",
  ], streams);

  assert.equal(exit, 1);
  assert.equal(viewerLaunches, 0);
  assert.match(streams.read().stderr, /matrix\.capability-missing/);
  assert.doesNotMatch(streams.read().stdout, /Viewer:/);
});

test("hurdle run accepts --view only once", async () => {
  const streams = io("/workspace");

  const exit = await createFrameworkCli().main([
    "run",
    "--view",
    "--view",
  ], streams);

  assert.equal(exit, 2);
  assert.equal(
    streams.read().stderr,
    "✗ hurdle [argument-error] Option '--view' may only be supplied once.\n",
  );
});

test("hurdle view launches the canonical local source on loopback", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-view-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    async launchViewer(input) {
      calls.push(input);
      return { kind: "stopped", exitCode: 0, signal: null, url: "http://127.0.0.1:3000" };
    },
  });
  const streams = io(root);

  const exit = await cli.main(["view"], streams);

  assert.equal(exit, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].storeEnvironment, {
    HURDLE_RESULT_STORE_MODE: "local",
    HURDLE_RESULT_STORE_ROOT: join(root, ".hurdle", "results-v1"),
  });
  assert.equal(calls[0].port, 3000);
  assert.match(streams.read().stdout, /http:\/\/127\.0\.0\.1:3000/);
});

test("hurdle view shows one live readiness status in an interactive terminal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-view-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    async launchViewer(input) {
      input.onReady("http://127.0.0.1:3000");
      return { kind: "stopped", exitCode: 0, url: "http://127.0.0.1:3000" };
    },
  });
  const streams = ttyIo(root);

  const exit = await cli.main(["view"], streams);

  assert.equal(exit, 0);
  assert.match(streams.read().stderr, /Starting Results Viewer/);
  assert.doesNotMatch(streams.read().stderr, /Results Viewer ready|\d+ms/);
  assert.match(stripVTControlCharacters(streams.read().stdout), /✓ Viewer ready/);
  assert.equal(
    stripVTControlCharacters(streams.read().stdout),
    "\nHurdle\n\n✓ Viewer ready\n\n  URL       http://127.0.0.1:3000\n  Runtime   Built-in Local default\n  Execution Local\n  Store     Filesystem\n  Results   .hurdle/results-v1\n\n  Press Ctrl+C to stop.\n",
  );
});

test("hurdle view reports unconfirmed shutdown without claiming success", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-view-disposal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    async launchViewer() {
      return { kind: "failed", exitCode: 1, reason: "disposal-unconfirmed" };
    },
  });
  const streams = io(root);
  assert.equal(await cli.main(["view"], streams), 1);
  assert.equal(streams.read().stderr,
    "✗ hurdle [viewer-disposal-unconfirmed] Viewer shutdown could not be confirmed. Check for a surviving Viewer process before restarting.\n");
});

test("hurdle view explains how to recover when its port is already occupied", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-view-port-in-use-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    async launchViewer() {
      return { kind: "failed", exitCode: 1, reason: "port-in-use" };
    },
  });
  const streams = ttyIo(root);

  const exit = await cli.main(["view"], streams);

  assert.equal(exit, 1);
  assert.match(streams.read().stderr, /viewer-port-in-use/);
  assert.match(streams.read().stderr, /Port 3000 is already in use/);
  assert.match(streams.read().stderr, /http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(streams.read().stderr, /secret-output/);
});

test("hurdle view --port serves on another port and rejects invalid ports", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-view-port-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    async launchViewer(input) {
      calls.push(input);
      return { kind: "stopped", exitCode: 0, url: `http://127.0.0.1:${input.port}` };
    },
  });
  let streams = io(root);
  assert.equal(await cli.main(["view", "--port", "4123", "--store", "results"], streams), 0, streams.read().stderr);
  assert.equal(calls[0].port, 4123);
  assert.equal(calls[0].storeEnvironment.HURDLE_RESULT_STORE_ROOT, join(root, "results"));
  assert.match(streams.read().stdout, /http:\/\/127\.0\.0\.1:4123/);

  for (const args of [
    ["--port", "0"], ["--port", "65536"], ["--port", "30a"], ["--port", "3000.5"], ["--port", "03000"],
    ["--port", "-1"], ["--port"], ["--port", "4000", "--port", "4001"],
    ["--runtime", "runtime.json", "--store", "results"], ["--host", "0.0.0.0"],
  ]) {
    streams = io(root);
    assert.equal(await cli.main(["view", ...args], streams), 2, args.join(" "));
    assert.match(streams.read().stderr, /argument-error/);
  }
  assert.equal(calls.length, 1);
});

test("a busy Viewer port suggests the same view on the next port", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-view-port-busy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "unused", "code");
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    processTarget: new EventEmitter(),
    async openLocalResultStore() { return Object.freeze({}); },
    createRunEngine() { return { async run() { return completedResult(); } }; },
    async launchViewer() { return { kind: "failed", exitCode: 1, reason: "port-in-use" }; },
  });
  const next = (streams) => stripVTControlCharacters(streams.read().stderr).match(/Next\s+(.*)/)?.[1];

  let streams = io(root);
  assert.equal(await cli.main(["view", "--store", "results", "--port", "4000"], streams), 1);
  assert.match(streams.read().stderr, /Port 4000 is already in use/);
  assert.equal(next(streams), `${sourceExecutable} view --store results --port 4001`);

  streams = io(root);
  assert.equal(await cli.main(["view", "--port", "65535"], streams), 1);
  assert.equal(next(streams), `${sourceExecutable} view --port 3000`);

  writeFileSync(join(root, "runtime.json"), JSON.stringify({ schemaVersion: 1, environment: { kind: "local" }, resultStore: { kind: "local", root: "results" } }));
  streams = io(root);
  assert.equal(await cli.main(["run", "example.suite.mjs", "--agent", "claude-code", "--runtime", "runtime.json", "--view"], streams), 1);
  assert.equal(next(streams), `${sourceExecutable} view --runtime runtime.json --port 3001`);

  // An inline topology has no view equivalent to name.
  streams = io(root);
  assert.equal(await cli.main(["run", "example.suite.mjs", "--agent", "claude-code", "--store", "results", "--view"], streams), 1);
  assert.match(streams.read().stderr, /Port 3000 is already in use/);
  assert.equal(next(streams), undefined);
});

test("hurdle view can open a canonical Local Result Store named directly", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-view-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
    env: {},
    async launchViewer(input) {
      calls.push(input);
      return { kind: "stopped", exitCode: 0, url: "http://127.0.0.1:3000" };
    },
  });
  const streams = io(root);

  const exit = await cli.main([
    "view",
    "--store",
    "pack/.hurdle/results-v1",
  ], streams);

  assert.equal(exit, 0);
  assert.deepEqual(calls[0].storeEnvironment, {
    HURDLE_RESULT_STORE_MODE: "local",
    HURDLE_RESULT_STORE_ROOT: join(root, "pack", ".hurdle", "results-v1"),
  });
});

test("constructor failures close Postgres and dispose the compiled Suite without leaking secrets", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const factory of ["createAnthropicJsonJudge", "createAgentAdapter", "createLocalExecutionEnvironment", "createRunEngine"]) {
    const root = mkdtempSync(join(tmpdir(), "tae-constructor-cleanup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeJudgePack(root);
    writeFileSync(join(root, "runtime.json"), JSON.stringify({
      schemaVersion: 1,
      environment: { kind: "local" },
      resultStore: { kind: "postgres", databaseUrlEnv: "TEST_DB", artifactRoot: "artifacts" },
      judge: { kind: "anthropic-json-v1", model: "judge-model", credentialEnv: "TEST_JUDGE" },
    }));
    const processTarget = new EventEmitter();
    let generatedRoot;
    let closed = 0;
    const cli = createFrameworkCli({
    async checkAgentReadiness() { return { ok: true, checks: [] }; },
      processTarget,
      env: { TEST_DB: "postgresql://sensitive", TEST_JUDGE: "sensitive-judge" },
      async resolveV1Suite(options) {
        const suite = await resolveV1Suite(options);
        generatedRoot = suite.generatedRoot;
        return suite;
      },
      async openPostgresResultStore() { return {}; },
      async closePostgresResultStore() { closed += 1; },
      createAnthropicJsonJudge() { return {}; },
      createAgentAdapter() { return {}; },
      createLocalExecutionEnvironment() { return {}; },
      createRunEngine() { return { async run() { return completedResult(); } }; },
      [factory]() { throw new Error("sensitive-judge"); },
    });
    const streams = ttyIo(root);
    assert.equal(await cli.main(["run", "example.suite.mjs", "--runtime", "runtime.json"], streams), 1, factory);
    assert.equal(closed, 1, factory);
    assert.equal(existsSync(generatedRoot), false, factory);
    for (const signal of ["exit", "SIGINT", "SIGTERM"]) assert.equal(processTarget.listenerCount(signal), 0, factory);
    assert.doesNotMatch(JSON.stringify(streams.read()), /sensitive/);
    assert.match(streams.read().stderr, /run-failed/);
    const stopped = streams.read();
    t.mock.timers.tick(1000);
    assert.deepEqual(streams.read(), stopped, "no spinner survives a constructor failure");
  }
});


test("run concurrency uses the Suite setting or default three, with a CLI override", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-cli-concurrency-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [suiteLimit, args, expected] of [
    [undefined, [], 3], [2, [], 2], [2, ["--concurrency", "3"], 3], [undefined, ["--concurrency", "1"], 1],
  ]) {
    writeJudgePack(root, "unused", "code");
    const suitePath = join(root, "example.suite.mjs");
    if (suiteLimit !== undefined) writeFileSync(suitePath, readFileSync(suitePath, "utf8").replace('"repeats":1', `"repeats":1,"concurrency":${suiteLimit}`));
    const streams = io(root);
    streams.stdout.isTTY = args.length > 0;
    const cli = createFrameworkCli({
      env: {}, processTarget: new EventEmitter(),
      async checkAgentReadiness() { return { ok: true, checks: [] }; },
      async openLocalResultStore() { return {}; },
      createAgentAdapter() { return {}; }, createLocalExecutionEnvironment() { return {}; },
      createRunEngine() { return { async run(request) { assert.equal(request.concurrency, expected); return completedResult(); } }; },
    });
    assert.equal(await cli.main(["run", "example.suite.mjs", ...args], streams), 0);
    const output = stripVTControlCharacters(streams.read().stdout);
    assert.match(output, new RegExp(`^  Concurrency  ${expected}$`, "m"));
  }
});

test("invalid or repeated concurrency flags fail before Suite import, credentials or store access", async t => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-cli-concurrency-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [
    ["--concurrency", "0"], ["--concurrency", "101"], ["--concurrency", "1.5"], ["--concurrency", "five"],
    ["--concurrency"], ["--concurrency", "5", "--concurrency", "2"],
  ]) {
    const streams = io(root);
    const cli = createFrameworkCli({ env: {}, processTarget: new EventEmitter(), resolveV1Suite() { assert.fail("must not import the Suite"); }, openLocalResultStore() { assert.fail("must not open store"); } });
    assert.equal(await cli.main(["run", "missing.suite.mjs", ...args], streams), 2);
    assert.match(streams.read().stderr, /concurrency/);
  }
  const streams = io(root);
  assert.equal(await createFrameworkCli({ env: {} }).main(["help", "run"], streams), 0);
  assert.match(streams.read().stdout, /--concurrency N.*default: 3/);
});

test("interleaved cell progress tracks lifecycle and elapsed time independently", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const root = mkdtempSync(join(tmpdir(), "hurdle-cli-parallel-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJudgePack(root, "unused", "code");
  for (const isTTY of [true, false]) {
    const streams = isTTY ? ttyIo(root) : io(root);
    const output = () => stripVTControlCharacters(streams.read().stderr + streams.read().stdout);
    const cli = createFrameworkCli({
      env: {}, processTarget: new EventEmitter(),
      async checkAgentReadiness() { return { ok: true, checks: [] }; },
      async openLocalResultStore() { return {}; },
      createAgentAdapter() { return {}; }, createLocalExecutionEnvironment() { return {}; },
      createRunEngine({ progressObserver }) { return { async run() {
        const emit = event => reportExecutionProgress(progressObserver, event);
        const cells = [1, 2].map(ordinal => ({ ordinal, total: 2, taskId: "sample", conditionId: "baseline", adapterId: ordinal === 1 ? "claude-code" : "codex", repeatOrdinal: 1, repeatTotal: 1 }));
        emit({ kind: "matrix-ready", total: 2 });
        emit({ kind: "cell-started", cell: cells[0] });
        emit({ kind: "cell-attempt-started", cell: cells[0], executionId: "private-run-one" });
        t.mock.timers.tick(3000);
        emit({ kind: "cell-started", cell: cells[1] });
        emit({ kind: "cell-attempt-started", cell: cells[1], executionId: "private-run-two" });
        emit({ kind: "environment-status", executionId: "private-run-one", environmentId: "together", status: "agent-running" });
        emit({ kind: "environment-status", executionId: "private-run-two", environmentId: "together", status: "starting-guardian" });
        assert.match(output(), /2 active · 0\/2 done · 1 Agent running · 1 Starting Guardian/);
        t.mock.timers.tick(2000);
        emit({ kind: "cell-finalizing", cell: cells[1] });
        emit({ kind: "cell-completed", cell: cells[1], terminal: { id: "private-run-two", verdict: "pass" } });
        assert.match(output(), /\[2\/2\] sample · baseline · Codex · pass +2s/);
        assert.match(output(), /\[1\/2\] sample · baseline · Claude Code · Agent running/);
        // A stale retry status must never overwrite another cell's lifecycle.
        emit({ kind: "cell-attempt-started", cell: cells[0], executionId: "private-run-retry" });
        emit({ kind: "environment-status", executionId: "private-run-retry", environmentId: "together", status: "sandbox-started" });
        const beforeStaleStatus = streams.read();
        emit({ kind: "environment-status", executionId: "private-run-one", environmentId: "together", status: "agent-running" });
        assert.deepEqual(streams.read(), beforeStaleStatus);
        t.mock.timers.tick(2000);
        emit({ kind: "cell-finalizing", cell: cells[0] });
        emit({ kind: "cell-completed", cell: cells[0], terminal: { id: "private-run-retry", verdict: "pass" } });
        assert.match(output(), /\[1\/2\] sample · baseline · Claude Code · pass +7s/);
        return completedResult();
      } }; },
    });
    assert.equal(await cli.main(["run", "example.suite.mjs"], streams), 0);
    assert.doesNotMatch(output(), /private-run/);
    const before = streams.read();
    t.mock.timers.tick(1000);
    assert.deepEqual(streams.read(), before, "spinner is stopped after completion");
  }
});
