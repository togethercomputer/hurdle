import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TERMINAL_COLORS = Object.freeze({
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
});

export function terminalUsesColor(stream) {
  return Boolean(stream?.isTTY) && !process.env.NO_COLOR;
}

export function paintTerminal(value, color, enabled) {
  return enabled ? `${TERMINAL_COLORS[color]}${value}${TERMINAL_COLORS.reset}` : value;
}

export function terminalFact(label, value, { color = null, useColor = false, labelWidth = 9 } = {}) {
  const key = paintTerminal(label.padEnd(labelWidth), "dim", useColor);
  const text = color ? paintTerminal(value, color, useColor) : value;
  return `  ${key} ${text}\n`;
}

export function terminalHeader(stream) {
  return `\n${paintTerminal("Hurdle", "bold", terminalUsesColor(stream))}\n\n`;
}

export function terminalMark(status, useColor) {
  const [symbol, color] = { pass: ["✓", "green"], fail: ["✗", "red"], warning: ["!", "yellow"], skip: ["–", "dim"] }[status];
  return paintTerminal(symbol, color, useColor);
}

export function terminalStatus(status, text, stream) {
  return `${terminalMark(status, terminalUsesColor(stream))} ${text}\n`;
}

export function terminalNote(text, stream) {
  return `  ${paintTerminal(text, "dim", terminalUsesColor(stream))}\n`;
}

export function terminalNext(commands, stream) {
  const useColor = terminalUsesColor(stream);
  return "\n" + commands.map((command, index) => terminalFact(index ? "" : "Next", command, { useColor })).join("") + "\n";
}

export function runtimeSummaryRows(runtime, cwd, { inline = false } = {}) {
  const localPath = runtime.sourcePath ? relative(cwd, runtime.sourcePath) : null;
  const path = localPath === ".." || localPath?.startsWith(`..${sep}`) ? runtime.sourcePath : localPath || ".";
  const configuration = runtime.sourcePath ? `${path}${inline ? " (with overrides)" : ""}`
    : inline ? "Command-line configuration" : "Built-in Local default";
  return [
    ["Runtime", configuration],
    ["Execution", { local: "Local", together: "Together sandbox" }[runtime.environment.kind]],
    ["Store", runtime.resultStore.kind === "postgres" ? "Postgres" : "Filesystem"],
  ];
}

// Where each selected Task's Suite key goes during a run. On the Together
// socket it stays in the Guardian, which sends it only to the Suite's API
// hosts. Locally, the Agent's own environment holds it.
export function suiteKeyRoutes(definition, taskIds, environment) {
  const guardianOnly = environment.kind === "together";
  const routes = new Map();
  for (const taskId of taskIds) {
    const task = definition.tasks[taskId];
    for (const name of task.credentialRequirements ?? []) {
      const delivery = task.credentialDeliveryOverrides?.[name]
        ?? definition.credentialRequirements?.[name]?.delivery
        ?? { kind: "environment" };
      const route = routes.get(name) ?? { name, hosts: new Set(), agentVisible: false };
      for (const host of delivery.hosts ?? task.egress?.relevantHosts ?? definition.target?.egress?.relevantHosts ?? []) {
        route.hosts.add(host);
      }
      if (delivery.kind === "environment" && !guardianOnly) route.agentVisible = true;
      routes.set(name, route);
    }
  }
  return [...routes.values()].map(({ name, hosts, agentVisible }) => ({
    name, hosts: [...hosts].sort(), agentVisible,
  }));
}

export function suiteKeyRows(routes) {
  return routes.map(({ name, hosts, agentVisible }, index) => [
    index ? "" : "Keys",
    agentVisible
      ? `${name} → the Agent's environment`
      : `${name} → ${hosts.join(", ")}`,
  ]);
}

// Safe to paste into POSIX shells, including paths containing shell expansions.
export function quoteCommandArgument(value) {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function cliExecutable(cwd) {
  if (cwd) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
      const bin = typeof manifest.bin === "string" && manifest.name === "hurdle" ? manifest.bin : manifest.bin?.hurdle;
      // npm exec resolves a project's own bin before consulting installed or registry packages.
      if (typeof bin === "string" && realpathSync(resolve(cwd, bin)) === realpathSync(fileURLToPath(new URL("../bin/hurdle.mjs", import.meta.url)))) {
        return "npx hurdle";
      }
    } catch { /* A fresh project still needs the source executable below. */ }
  }
  if (cwd && existsSync(resolve(cwd, "harness/bin/hurdle.mjs"))) return "node harness/bin/hurdle.mjs";
  return existsSync(new URL("../../viewer/package.json", import.meta.url))
    ? `node ${quoteCommandArgument(fileURLToPath(new URL("../bin/hurdle.mjs", import.meta.url)))}`
    : "npx hurdle";
}

export function suiteCommand(command, suite, { view = false, cwd, executable = cliExecutable(cwd) } = {}) {
  const argument = suite === "evals/example.suite.mjs"
    ? "" : ` ${quoteCommandArgument(suite)}`;
  return `${executable} ${command}${argument}${view ? " --view" : ""}`;
}
