import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { quoteCommandArgument, terminalStatus, cliExecutable } from "./terminal-output.mjs";
import { discoverProjectSuites } from "./project-suites.mjs";

// One JSON document per invocation; credential values and backend errors never
// enter this report. Human output retains the shared terminal formatting.
export function createSetupOutput(io, { json = false, target = null } = {}) {
  const result = {
    schemaVersion: 1, command: "setup", target, ok: false, exitCode: 1,
    runtimePath: null, executionEnvironment: null, resultStore: null,
    requiredCredentials: [], missingCredentials: [], checks: [], nextCommands: [], error: null,
  };
  const silent = { isTTY: false, write() {} };
  return {
    result,
    io: json ? { ...io, stdout: silent, stderr: silent } : io,
    check(status, message, code = null) {
      result.checks.push({ status, code, message });
      if (!json) io.stdout.write(terminalStatus(status, message, io.stdout));
    },
    finish(exitCode, error = null) {
      result.ok = exitCode === 0;
      result.exitCode = exitCode;
      result.error = error;
      if (json) io.stdout.write(`${JSON.stringify(result)}\n`);
      else if (error) io.stdout.write(terminalStatus("fail", `hurdle [${error.code}] ${error.message}`, io.stdout));
      return exitCode;
    },
  };
}


export function missingSuiteSetupGuidance(cwd, provider, suite) {
  const executable = cliExecutable(cwd);
  const init = `${executable} init${existsSync(resolve(cwd, "evals")) ? " evals/my-eval" : ""}`;
  const missing = suite ? `Suite file not found: ${quoteCommandArgument(suite)}.\n\n` : "";
  let suites = [];
  try { suites = discoverProjectSuites(cwd).filter(suite => !suite.bundled); } catch { /* Listing reports discovery errors. */ }
  if (suites.length) {
    const list = `${executable} suites`;
    const setup = `${executable} setup ${quoteCommandArgument(suites[0].ambiguous ? suites[0].path : suites[0].name)} --sandbox ${provider}`;
    return {
      message: `${missing}Choose an existing Suite:\n\n  ${list}\n\nFor example:\n  ${setup}`,
      nextCommands: [list, setup],
    };
  }
  const example = "examples/copy-message/example.suite.mjs";
  if (!existsSync(resolve(cwd, example))) return {
    message: `${missing}Create an evaluation first:\n\n  ${init}`, nextCommands: [init],
  };
  const setup = `${executable} setup ${example}`;
  return {
    message: `${missing}Try the bundled copy-message Suite:\n\n  ${setup}\n\nOr create your own evaluation:\n  ${init}`,
    nextCommands: [setup, init],
  };
}
