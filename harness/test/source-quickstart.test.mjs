import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  projectQuickstartRunIssue,
  renderQuickstartHeader,
  runSourceQuickstart,
} from "../lib/source-quickstart.mjs";
import {
  createTerminalProgress,
} from "../lib/terminal-progress.mjs";

test("source quickstart runs the Starter Pack and opens its canonical Result Store", async () => {
  const cwd = "/workspace/together-agent-eval";
  const calls = [];
  const statuses = [];
  const exitCode = await runSourceQuickstart({
    cwd,
    async prepareDependencies() {
      calls.push(["prepare"]);
      return 0;
    },
    onStatus(status) {
      statuses.push(status);
    },
    async runCli(argv) {
      calls.push(argv);
      return calls.length === 2 ? 1 : 0;
    },
  });

  assert.deepEqual(calls, [
    ["prepare"],
    [
      "run",
      resolve(cwd, "examples/copy-message/example.suite.mjs"),
      "--store", resolve(cwd, ".hurdle/results-v1"),
      "--experiment-version", "local-quickstart",
    ],
    ["view", "--store", resolve(cwd, ".hurdle/results-v1")],
  ]);
  assert.deepEqual(statuses, [
    { phase: "prepare", state: "start" },
    { phase: "prepare", state: "complete", exitCode: 0 },
    { phase: "run", state: "start" },
    { phase: "run", state: "complete", exitCode: 1 },
    { phase: "view", state: "start" },
    { phase: "view", state: "complete", exitCode: 0 },
  ]);
  assert.equal(exitCode, 1, "a clean Viewer stop must preserve the run non-pass");
});

test("source quickstart stops before evaluation when dependency preparation fails", async () => {
  let runCalls = 0;
  const statuses = [];
  const exitCode = await runSourceQuickstart({
    cwd: "/workspace/together-agent-eval",
    async prepareDependencies() {
      return 70;
    },
    onStatus(status) {
      statuses.push(status);
    },
    async runCli() {
      runCalls += 1;
      return 0;
    },
  });

  assert.equal(exitCode, 70);
  assert.equal(runCalls, 0);
  assert.deepEqual(statuses, [
    { phase: "prepare", state: "start" },
    { phase: "prepare", state: "complete", exitCode: 70 },
  ]);
});

test("source quickstart preserves Viewer interruption over the run outcome", async () => {
  const outcomes = [0, 130];
  const exitCode = await runSourceQuickstart({
    cwd: "/workspace/together-agent-eval",
    async runCli() {
      return outcomes.shift();
    },
  });

  assert.equal(exitCode, 130);
});

test("source quickstart does not launch the Viewer after run interruption", async () => {
  let calls = 0;
  const exitCode = await runSourceQuickstart({
    cwd: "/workspace/together-agent-eval",
    async runCli() {
      calls += 1;
      return 143;
    },
  });

  assert.equal(calls, 1);
  assert.equal(exitCode, 143);
});

test("quickstart projects one actionable reason without internal run bookkeeping", () => {
  const output = [
    "Plan: 1 cell × 1 repeat = 1 run",
    "! [1/1] copy-message · baseline · Claude Code · incomplete  3s",
    "  environment.nonzero-exit: The evaluated agent process did not exit cleanly: Claude Code could not run because the Anthropic credit balance is too low.",
    "  artifact.required-missing: Required Output Artifact 'answer.txt' was not produced.",
    "Matrix: 1 cell, 1 repeat, 1 attempt, 0 retries",
    "Non-pass: run_example sha256:private-bookkeeping repeat 1 incomplete",
  ].join("\n");

  assert.deepEqual(projectQuickstartRunIssue(output), {
    task: "copy-message",
    reason: "Claude Code could not run because the Anthropic credit balance is too low.",
  });
  assert.doesNotMatch(JSON.stringify(projectQuickstartRunIssue(output)), /sha256|run_example/);
});

test("quickstart keeps a safe fallback when no projected reason is available", () => {
  assert.deepEqual(projectQuickstartRunIssue("hurdle [run-failed] Internal detail"), {
    task: "copy-message",
    reason: "The starter evaluation did not complete. Open its Transcript in the Viewer for details.",
  });
});

test("quickstart uses the shared neutral Hurdle header", () => {
  assert.equal(renderQuickstartHeader(), "Hurdle");
  assert.equal(renderQuickstartHeader({ isTTY: true, useColor: false }), "Hurdle");
  const coloured = renderQuickstartHeader({ isTTY: true, useColor: true });
  assert.equal(coloured.replace(/\u001b\[[0-9;]+m/gu, ""), "Hurdle");
  if (!process.env.NO_COLOR) assert.match(coloured, /\u001b\[1mHurdle/);
});

test("quickstart progress uses stable plain output outside a TTY", () => {
  let output = "";
  const progress = createTerminalProgress({
    isTTY: false,
    useColor: false,
    stream: { write(value) { output += value; } },
  });

  progress.start("Preparing local environment");
  progress.succeed("Environment ready", "8s");

  assert.equal(output, "- Preparing local environment\n✓ Environment ready  8s\n");
});

test("quickstart progress rewrites one restrained status line in a TTY", () => {
  let output = "";
  const progress = createTerminalProgress({
    isTTY: true,
    useColor: false,
    stream: { write(value) { output += value; } },
  });

  progress.start("Running starter evaluation");
  progress.succeed("Starter evaluation passed", "4s");

  assert.equal(
    output,
    "\r\u001b[2K⠋ Running starter evaluation\r\u001b[2K✓ Starter evaluation passed  4s\n",
  );
});

test("terminal progress updates a cell and preserves sandbox details around the spinner", () => {
  let output = "";
  const progress = createTerminalProgress({
    isTTY: true,
    useColor: false,
    stream: { write(value) { output += value; } },
  });

  progress.start("Running evaluations");
  progress.update("[1/6] rag-search · baseline · Claude Code");
  progress.detail("Sandbox together  sandbox-agent-1  https://sandbox.example/dashboard");
  progress.succeed("[1/6] rag-search · baseline · pass", "42s");
  progress.update("[2/6] rag-search · mcp · Claude Code");

  assert.equal(
    output,
    "\r\u001b[2K⠋ Running evaluations"
      + "\r\u001b[2K⠙ [1/6] rag-search · baseline · Claude Code"
      + "\r\u001b[2K  Sandbox together  sandbox-agent-1  https://sandbox.example/dashboard\n"
      + "\r\u001b[2K⠹ [1/6] rag-search · baseline · Claude Code"
      + "\r\u001b[2K✓ [1/6] rag-search · baseline · pass  42s\n"
      + "\r\u001b[2K⠋ [2/6] rag-search · mcp · Claude Code",
  );
});

test("terminal progress keeps the live line on one row so clearing it leaves no fragments", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let output = "";
  const stream = { columns: 68, write(value) { output += value; } };
  const progress = createTerminalProgress({ stream, isTTY: true, useColor: false, showElapsed: true, now: () => 1000 });
  t.after(() => progress.stop());

  progress.start("[1/2] copy-message · baseline · Claude Code · repeat 1/2 · Evaluating");
  t.mock.timers.tick(80);
  progress.update("[1/2] copy-message · baseline · Claude Code · repeat 1/2 · Finalizing results");
  const frames = output.split("\r\u001b[2K").filter(Boolean);
  assert.deepEqual(frames, [
    "⠋ [1/2] copy-message · baseline …Code · repeat 1/2 · Evaluating  0s",
    "⠙ [1/2] copy-message · baseline …Code · repeat 1/2 · Evaluating  0s",
    "⠹ [1/2] copy-message · baseline …epeat 1/2 · Finalizing results  0s",
  ], "the cell and its current phase both stay visible");
  assert.ok(frames.every((frame) => frame.length < stream.columns), "a wrapped row could not be cleared");

  progress.succeed("[1/2] copy-message · baseline · Claude Code · repeat 1/2 · pass", "8s");
  assert.ok(output.endsWith("\r\u001b[2K✓ [1/2] copy-message · baseline · Claude Code · repeat 1/2 · pass  8s\n"),
    "settled lines keep their full text");
  stream.columns = 120;
  progress.start("[2/2] copy-message · baseline · Claude Code · repeat 2/2 · Evaluating");
  assert.ok(output.endsWith("⠋ [2/2] copy-message · baseline · Claude Code · repeat 2/2 · Evaluating  0s"),
    "a wider terminal shows the whole line");
});

test("terminal progress emits stable incremental lines outside a TTY", () => {
  let output = "";
  const progress = createTerminalProgress({
    isTTY: false,
    useColor: false,
    stream: { write(value) { output += value; } },
  });

  progress.start("Running evaluations");
  progress.update("[1/6] rag-search · baseline · Claude Code");
  progress.detail("Agent environment  sandbox-agent-1  https://sandbox.example/dashboard");

  assert.equal(
    output,
    "- Running evaluations\n"
      + "- [1/6] rag-search · baseline · Claude Code\n"
      + "  Agent environment  sandbox-agent-1  https://sandbox.example/dashboard\n",
  );
});

test("terminal elapsed time advances while idle and stops after completion or disposal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let output = "";
  let now = 1000;
  const progress = createTerminalProgress({
    stream: { write(value) { output += value; } },
    isTTY: true,
    useColor: false,
    showElapsed: true,
    now: () => now,
  });
  t.after(() => progress.stop());
  progress.start("[1/3] chat-app · baseline · Evaluating");
  assert.match(output, /Evaluating  0s$/);
  now += 2300;
  t.mock.timers.tick(80);
  assert.match(output, /Evaluating  2s$/);
  progress.succeed("[1/3] chat-app · baseline · pass", "2s");
  const completed = output;
  t.mock.timers.tick(1000);
  assert.equal(output, completed);
  progress.start("[2/3] rag-search · baseline · Evaluating");
  assert.match(output, /Evaluating  0s$/);
  progress.stop();
  const stopped = output;
  t.mock.timers.tick(1000);
  assert.equal(output, stopped);
});
