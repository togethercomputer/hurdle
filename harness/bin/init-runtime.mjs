#!/usr/bin/env node

import { initializeRuntime } from "../lib/runtime-init.mjs";
import { terminalHeader, terminalStatus, terminalFact, terminalUsesColor, terminalNext } from "../lib/terminal-output.mjs";

function usage(message) {
  process.stderr.write(terminalStatus("fail", message ?? "Choose postgres, together, or together-postgres.", process.stderr));
  process.stderr.write("Usage: npm run runtime:init -- <postgres|together|together-postgres>\n");
  return 2;
}

function argumentsFrom(argv) {
  const [mode, ...options] = argv;
  if (!mode || options.length || !["postgres", "together", "together-postgres"].includes(mode)) return null;
  return { mode };
}

const selected = argumentsFrom(process.argv.slice(2));
if (!selected) {
  process.exitCode = usage();
} else {
  try {
    const created = await initializeRuntime({
      cwd: process.cwd(),
      mode: selected.mode,
    });
    process.stdout.write(terminalHeader(process.stdout)
      + terminalStatus("pass", "Runtime created", process.stdout) + "\n"
      + terminalFact("Runtime", created.relativePath, { useColor: terminalUsesColor(process.stdout) })
      + terminalNext([
        "npm run preflight",
        ...(created.usesPostgres ? ["npm run db:migrate"] : []),
        `npm run hurdle -- run evals/together/hybrid.suite.mjs --runtime ${created.relativePath} --view`,
      ], process.stdout));
  } catch (error) {
    process.stderr.write(terminalStatus("fail", error?.message ?? "Runtime could not be created.", process.stderr));
    process.exitCode = error?.code === "runtime-exists" ? 1 : 70;
  }
}
