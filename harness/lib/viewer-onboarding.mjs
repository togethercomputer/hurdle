import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { defaultProjectSuite, discoverProjectSuites, resolveProjectSuite } from "./project-suites.mjs";
import { quoteCommandArgument } from "./terminal-output.mjs";

function displayText(value, maximum = 32768) {
  return typeof value === "string" && value.length <= maximum
    && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

// Only display metadata crosses into the read-only Viewer. Never pass runtime
// settings, the project environment, or provider credentials with this context.
export function validateViewerOnboarding(value) {
  const fields = ["projectDirectory", "commands", "setupCommand", "runtimeLabel"];
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => ![...fields, "steps"].includes(key))
      || fields.some(key => key === "commands" && value[key] === null ? false : !displayText(value[key]))
      || (value.steps !== undefined && (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 3
        || value.steps.some(step => !step || typeof step !== "object" || Array.isArray(step)
          || Object.keys(step).length !== 2 || !Object.hasOwn(step, "title") || !Object.hasOwn(step, "command")
          || !displayText(step.title, 96) || !step.title.trim() || /[\r\n]/.test(step.title)
          || !displayText(step.command) || !step.command.trim())))) {
    throw new TypeError("Viewer onboarding context is invalid");
  }
  return {
    projectDirectory: value.projectDirectory,
    commands: value.commands,
    setupCommand: value.setupCommand,
    runtimeLabel: value.runtimeLabel,
    ...(value.steps === undefined ? {} : { steps: value.steps.map(({ title, command }) => ({ title, command })) }),
  };
}

export function createViewerOnboarding({ cwd, suite, runtimeProfile, storeOverride = false }) {
  let discovered = [];
  try { discovered = discoverProjectSuites(cwd); } catch { /* Explicit Suite paths remain usable. */ }
  let selected = suite ?? defaultProjectSuite(cwd, discovered);
  try { selected = resolveProjectSuite(cwd, selected).path ?? selected; } catch { /* Use the explicit selection. */ }
  const steps = [];
  let createdDefault = false;
  if (!selected || !existsSync(resolve(cwd, selected))) {
    let destination = "evals";
    if (existsSync(resolve(cwd, destination))) {
      destination = "evals/my-eval";
      for (let suffix = 2; existsSync(resolve(cwd, destination)); suffix += 1) destination = `evals/my-eval-${suffix}`;
    }
    steps.push({ title: "Create an evaluation", command: `npx hurdle init${destination === "evals" ? "" : ` ${quoteCommandArgument(destination)}`}` });
    selected = `${destination}/example.suite.mjs`;
    createdDefault = destination === "evals";
  }
  const defaultSuite = defaultProjectSuite(cwd, discovered);
  const match = discovered.find(item => item.path === selected);
  const name = match && !match.ambiguous && !match.name.startsWith("-") ? match.name : selected;
  const suiteArg = createdDefault || selected === defaultSuite ? "" : ` ${quoteCommandArgument(name)}`;
  const setupCommand = `npx hurdle setup${suiteArg}`;
  const runtimeLabel = runtimeProfile.environment.kind === "together" ? "Together sandbox" : "Local";
  const context = { projectDirectory: cwd, commands: null, setupCommand, runtimeLabel };
  // Preserve the selected store: an override of a saved remote Runtime cannot
  // be replayed safely without its execution configuration.
  if (storeOverride && runtimeProfile.sourcePath && runtimeProfile.environment.kind !== "local") {
    return validateViewerOnboarding(context);
  }
  let runtimeArg = "";
  if (runtimeProfile.sourcePath && !storeOverride) {
    if (resolve(runtimeProfile.sourcePath) !== resolve(cwd, ".hurdle/runtime/default.json")) {
      runtimeArg = ` --runtime ${quoteCommandArgument(relative(cwd, runtimeProfile.sourcePath) || runtimeProfile.sourcePath)}`;
    }
  } else if (runtimeProfile.environment.kind === "local" && runtimeProfile.resultStore.kind === "local"
    && (storeOverride || resolve(runtimeProfile.resultStore.root) !== resolve(cwd, ".hurdle/results-v1"))) {
    runtimeArg = ` --environment local --store ${quoteCommandArgument(relative(cwd, runtimeProfile.resultStore.root) || runtimeProfile.resultStore.root)}`;
  } else if (!runtimeProfile.sourcePath) {
    steps.push({ title: "Set up your sandbox", command: setupCommand });
  }
  steps.push({ title: "Run and view results", command: `npx hurdle run${suiteArg}${runtimeArg} --view` });
  return validateViewerOnboarding({ ...context, commands: steps.map(step => step.command).join("\n"), steps });
}
