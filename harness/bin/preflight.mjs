#!/usr/bin/env node

import { runCredentialPreflight } from "../lib/credential-preflight.mjs";
import { loadProjectEnvironment } from "../lib/project-environment.mjs";
import { terminalHeader, terminalStatus, terminalFact, terminalUsesColor, terminalNext } from "../lib/terminal-output.mjs";

function writeResult({ provider, status, message }) {
  process.stdout.write(terminalStatus(status, `${provider.padEnd(10)} ${message}`, process.stdout));
}

try {
  const { environment, source } = loadProjectEnvironment(process.cwd());
  const useColor = terminalUsesColor(process.stdout);
  process.stdout.write(terminalHeader(process.stdout)
    + terminalFact("Source", source, { useColor })
    + terminalFact("Usage", "Anthropic and Together may be billed · Postgres is read-only", { useColor }) + "\n");

  const results = await runCredentialPreflight(environment);
  for (const value of results) writeResult(value);

  const failures = results.filter(({ status }) => status === "fail").length;
  const checked = results.filter(({ status }) => status !== "skip").length;
  const needsStorageSetup = results.some(({ code }) => code === "postgres.setup-required");
  process.stdout.write("\n");
  if (failures > 0) {
    process.stdout.write(terminalStatus("fail", `${failures} configured service${failures === 1 ? " needs" : "s need"} attention`, process.stdout));
    process.exitCode = 1;
  } else if (checked === 0) {
    process.stdout.write(terminalStatus("warning", "No configured credentials found", process.stdout));
    process.exitCode = 1;
  } else if (needsStorageSetup) {
    process.stdout.write(terminalStatus("warning", "Postgres storage setup is still required", process.stdout));
    process.exitCode = 1;
  } else {
    process.stdout.write(terminalStatus("pass", `${checked} configured service${checked === 1 ? " is" : "s are"} ready`, process.stdout));
  }
  if (needsStorageSetup) process.stdout.write(terminalNext(["npx hurdle setup --store postgres"], process.stdout));
} catch {
  process.stderr.write(terminalStatus("fail", "hurdle [preflight-failed] Credential preflight could not start. Check that .env.local is valid.", process.stderr));
  process.exitCode = 70;
}
