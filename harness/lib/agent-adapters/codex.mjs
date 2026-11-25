import { decodeControllerJsonl } from "../controller-transcript.mjs";
import { deepFreeze, RunSelectionInputError } from "../run-model.mjs";
import { redactSecretBytes, redactSecretText } from "../evidence-redaction.mjs";
import { isAgentEffort } from "../agent-effort.mjs";

const ALLOWED_ENVIRONMENT_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
]);

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function selectedCodexEnvironment(runtimeEnv) {
  const selected = {};
  for (const name of ALLOWED_ENVIRONMENT_NAMES) {
    if (runtimeEnv[name] !== undefined) selected[name] = runtimeEnv[name];
  }
  // Only API keys: a ChatGPT access token is never passed to Codex.
  if (isNonblankString(runtimeEnv.CODEX_API_KEY)) {
    selected.CODEX_API_KEY = runtimeEnv.CODEX_API_KEY;
  } else if (isNonblankString(runtimeEnv.OPENAI_API_KEY)) {
    selected.CODEX_API_KEY = runtimeEnv.OPENAI_API_KEY;
  }
  return selected;
}

// Codex sends its API key as a bearer token to the OpenAI API only.
function codexCredentialRoutes(environment) {
  return isNonblankString(environment.CODEX_API_KEY)
    ? [{
        environmentName: "CODEX_API_KEY",
        hosts: ["api.openai.com"],
        headerNames: ["authorization"],
      }]
    : [];
}

// A leftover CODEX_ACCESS_TOKEN is never used, but is still redacted.
function secretValues(runtimeEnv) {
  return [...new Set([
    runtimeEnv.CODEX_ACCESS_TOKEN,
    runtimeEnv.CODEX_API_KEY,
    runtimeEnv.OPENAI_API_KEY,
  ].filter(isNonblankString))]
    .sort((left, right) => right.length - left.length);
}

function workspaceFiles(resources = { skills: [], mcpServers: [] }) {
  return resources.skills.flatMap((skill) => skill.files.map((file) => ({
    path: `.agents/skills/${skill.name}/${file.relativePath}`,
    source: {
      kind: "selected-resource",
      handle: file.handle,
      sha256: file.sha256,
    },
  })));
}

function mcpArguments(resources = { skills: [], mcpServers: [] }) {
  return resources.mcpServers.flatMap((server) => [
    "-c",
    `mcp_servers.${server.id}.url=${JSON.stringify(server.transport.url)}`,
  ]);
}

function normalizeCodexSettings({ requestedModel, settings }) {
  if (
    requestedModel !== null
    && requestedModel !== undefined
    && (typeof requestedModel !== "string" || !requestedModel.trim())
  ) {
    throw new RunSelectionInputError(
      "requested Codex model must be a nonblank string or null",
    );
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new RunSelectionInputError("Codex Adapter settings must be an object");
  }
  if (Object.keys(settings).some(key => key !== "effort")) {
    throw new RunSelectionInputError(
      "Codex does not support Agent Adapter settings in this slice",
    );
  }
  if (settings.effort !== undefined && !isAgentEffort(settings.effort)) {
    throw new RunSelectionInputError("Codex effort must be low, medium, high, xhigh, or max");
  }
  return deepFreeze({
    requestedModel: requestedModel?.trim() || null,
    settings: settings.effort === undefined ? {} : { effort: settings.effort },
  });
}

function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Fixed, operator-safe strings: provider messages are matched, never shown.
function codexOperatorReason(frames) {
  const failures = frames
    .map((frame) => (frame.type === "turn.failed" ? frame.error?.message : frame.type === "error" ? frame.message : null))
    .filter((message) => typeof message === "string");
  const failed = (pattern) => failures.some((message) => pattern.test(message));
  if (failed(/insufficient_quota|exceeded your current quota/iu)) {
    return "Codex could not run because the OpenAI account has insufficient quota.";
  }
  if (failed(/\b401\b|unauthorized|invalid_api_key|incorrect api key/iu)) {
    return "Codex authentication failed. Set a valid CODEX_API_KEY or OPENAI_API_KEY in .env.local, then run `npx hurdle validate`.";
  }
  if (failed(/model_not_found|model `[^`]*` does not exist/iu)) {
    return "Codex could not use the requested model; it may not exist or the account may lack access. Check the model ID with `npx hurdle models --agent codex`.";
  }
  return null;
}

function decodeCodexControllerEvidence(stdout) {
  const { frames, transcript } = decodeControllerJsonl(stdout);
  const operatorReason = codexOperatorReason(frames);
  let sessionId = null;
  const usage = {
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_output_tokens: null,
  };
  let turns = 0;
  const completedItemCounts = new Map();
  for (const frame of frames) {
    if (
      sessionId === null
      && frame.type === "thread.started"
      && typeof frame.thread_id === "string"
      && frame.thread_id.trim()
    ) {
      sessionId = frame.thread_id.trim();
    }
    if (frame.type === "turn.completed") {
      turns += 1;
      if (frame.usage && typeof frame.usage === "object" && !Array.isArray(frame.usage)) {
        for (const name of Object.keys(usage)) {
          const value = optionalCount(frame.usage[name]);
          if (value !== null) usage[name] = value;
        }
      }
    }
    const itemType = frame.type === "item.completed"
      && typeof frame.item?.type === "string"
      ? frame.item.type.trim()
      : "";
    if (itemType) {
      completedItemCounts.set(
        itemType,
        (completedItemCounts.get(itemType) ?? 0) + 1,
      );
    }
  }

  const completedItemsByType = Object.fromEntries(
    [...completedItemCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  const commandExecutions = completedItemsByType.command_execution ?? 0;
  const fileChanges = completedItemsByType.file_change ?? 0;
  const mcpToolCalls = completedItemsByType.mcp_tool_call ?? 0;
  const webSearches = completedItemsByType.web_search ?? 0;
  return deepFreeze({
    transcript,
    ...(operatorReason ? { operatorReason } : {}),
    observedModel: null,
    sessionId,
    metrics: {
      common: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        reportedCostUsd: null,
        turns,
        toolCalls: commandExecutions + fileChanges + mcpToolCalls + webSearches,
      },
      adapter: {
        cachedInputTokens: usage.cached_input_tokens,
        reasoningOutputTokens: usage.reasoning_output_tokens,
        completedItemsByType,
        agentMessages: completedItemsByType.agent_message ?? 0,
        commandExecutions,
        fileChanges,
        mcpToolCalls,
        webSearches,
      },
    },
  });
}

export function createCodexAdapter({
  runtimeEnv = process.env,
  command = "codex",
  timeoutMs = 55 * 60 * 1000,
} = {}) {
  if (typeof command !== "string" || !command.trim()) {
    throw new TypeError("Codex command must be a nonblank string");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Codex timeoutMs must be a positive safe integer");
  }
  const environment = deepFreeze(selectedCodexEnvironment(runtimeEnv));
  const credentialRoutes = deepFreeze(codexCredentialRoutes(environment));
  const secrets = secretValues(runtimeEnv);
  return Object.freeze({
    id: "codex",
    capabilities: Object.freeze(["agent.selected-context"]),
    normalizeSettings: normalizeCodexSettings,
    createLaunchPlan({
      prompt,
      requestedModel,
      settings,
      resources = { skills: [], mcpServers: [] },
    }) {
      if (typeof prompt !== "string") {
        throw new TypeError("Codex prompt must be a string");
      }
      const normalized = normalizeCodexSettings({ requestedModel, settings });
      return deepFreeze({
        command: command.trim(),
        versionProbe: true,
        args: [
          "exec",
          "--json",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          // workspace-write blocks all sockets, even the sandbox's loopback
          // capture relay; Claude Code has network, and Hurdle's sandboxes
          // police egress. Codex still confines file writes.
          "-c",
          "sandbox_workspace_write.network_access=true",
          ...mcpArguments(resources),
          ...(normalized.settings.effort
            ? ["-c", `model_reasoning_effort=${JSON.stringify(normalized.settings.effort)}`]
            : []),
          ...(normalized.requestedModel
            ? ["--model", normalized.requestedModel]
            : []),
          "-",
        ],
        env: environment,
        credentialRoutes,
        stdin: prompt,
        timeoutMs,
        workspaceFiles: workspaceFiles(resources),
      });
    },
    redactControllerText(value) {
      return redactSecretText(value, secrets);
    },
    redactEvidenceBytes(value) {
      return redactSecretBytes(value, secrets);
    },
    decodeControllerEvidence({ stdout }) {
      return decodeCodexControllerEvidence(stdout);
    },
  });
}
