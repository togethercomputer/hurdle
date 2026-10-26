import {
  decodeControllerJsonl,
  parseClaudeControllerMetadata,
} from "../controller-transcript.mjs";
import {
  hasAnthropicApiKey,
  prepareClaudeEnv,
} from "../spawn-claude.mjs";
import { deepFreeze, RunSelectionInputError, sha256 } from "../run-model.mjs";
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
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
const LEGACY_C52_PRINT_PROTOCOL = "claude-code-legacy-c52-print-v1";
const LEGACY_C52_TOGETHER_CLI_VERSION = "2.31.0";
const LEGACY_C52_WORKSPACE_LAYOUT = Object.freeze({
  schemaVersion: 1,
  workingDirectory: "/home/user/workspace",
  homeDirectory: "/home/user",
  temporaryDirectory: "/tmp",
});
const LEGACY_C52_MODELS = new Set([
  "claude-opus-4-8",
  "claude-sonnet-4-6",
]);
const LOW_CREDIT_OPERATOR_REASON =
  "Claude Code could not run because the Anthropic credit balance is too low.";

function claudeOperatorReason(metadata) {
  if (
    metadata?.is_error !== true
    || typeof metadata?.result !== "string"
  ) return null;
  if (metadata.api_error_status === 401 || /API key is invalid|Failed to authenticate|OAuth token has expired/iu.test(metadata.result)) {
    return "Claude Code authentication failed. Replace ANTHROPIC_API_KEY in .env.local, or unset it and set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`. Run `npx hurdle validate` before retrying.";
  }
  if (metadata.api_error_status === 404 || /issue with the selected model/iu.test(metadata.result)) {
    return "Claude Code could not use the requested model; it may not exist or the account may lack access. Check the model ID with `npx hurdle models --agent claude-code`.";
  }
  return /credit balance is too low/iu.test(metadata.result)
    ? LOW_CREDIT_OPERATOR_REASON
    : null;
}

// The legacy c52 runner derived a run's reported result from the wrapper's own
// exit code, letting Claude's self-reported success override a timeout kill.
// The Judge renders this verbatim as REPORTED RESULT, so the mapping is a
// scored surface and must stay byte-identical to harness/run.mjs.
function legacyReportedResult({ exitCode, isError, subtype }) {
  if (!Number.isSafeInteger(exitCode)) return null;
  if (isError === true) return "fail";
  if (subtype === "success" && exitCode !== 0) return "pass";
  return exitCode === 0 ? "pass" : "fail";
}

function explicitClaudeEnvironment(runtimeEnv) {
  const selected = {};
  for (const name of ALLOWED_ENVIRONMENT_NAMES) {
    if (runtimeEnv[name] !== undefined) selected[name] = runtimeEnv[name];
  }
  return prepareClaudeEnv(selected);
}

function secretValues(runtimeEnv) {
  return [...new Set([
    runtimeEnv.ANTHROPIC_API_KEY,
    runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN,
  ].filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

// Claude Code sends an API key as x-api-key and an OAuth token as a bearer
// token, both only to the Anthropic API. A sandbox Guardian uses this to keep
// the real value out of the Agent's VM.
function claudeCredentialRoutes(environment) {
  return ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((name) => typeof environment[name] === "string" && environment[name].trim())
    .map((environmentName) => ({
      environmentName,
      hosts: ["api.anthropic.com"],
      headerNames: ["x-api-key", "authorization"],
    }));
}

function workspaceFiles(
  resources = { skills: [], mcpServers: [] },
  { legacyC52 = false } = {},
) {
  const files = resources.skills.flatMap((skill) => skill.files.map((file) => ({
    path: `.claude/skills/${skill.name}/${file.relativePath}`,
    source: {
      kind: "selected-resource",
      handle: file.handle,
      sha256: file.sha256,
    },
  })));
  if (legacyC52 && resources.mcpServers.length === 0) return files;
  const mcpValue = {
    mcpServers: Object.fromEntries(resources.mcpServers.map((server) => [
      server.id,
      { type: server.transport.kind, url: server.transport.url },
    ])),
  };
  const mcpConfig = legacyC52
    ? JSON.stringify(mcpValue)
    : `${JSON.stringify(mcpValue, null, 2)}\n`;
  const mcpBytes = Buffer.from(mcpConfig);
  files.push({
    path: legacyC52 ? ".mcp.json" : ".hurdle/claude-mcp.json",
    source: {
      kind: "generated",
      bytes: mcpBytes,
      sha256: sha256(mcpBytes),
    },
  });
  return files;
}

export function createClaudeCodeAdapter({
  runtimeEnv = process.env,
  command = "claude",
  timeoutMs = 55 * 60 * 1000,
} = {}) {
  const authMode = hasAnthropicApiKey(runtimeEnv)
    ? "apikey"
    : runtimeEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim()
      ? "oauth"
      : "none";
  const environment = explicitClaudeEnvironment(runtimeEnv);
  const credentialRoutes = claudeCredentialRoutes(environment);
  const secrets = secretValues(runtimeEnv);
  const continuationHandles = new WeakMap();
  const baseArgs = [
    "--verbose",
    "--output-format",
    "stream-json",
    "--setting-sources",
    "project",
    "--mcp-config",
    ".hurdle/claude-mcp.json",
    "--strict-mcp-config",
  ];
  return Object.freeze({
    id: "claude-code",
    capabilities: Object.freeze([
      "agent.selected-context",
      "agent.resumable-turns",
    ]),
    normalizeSettings({ requestedModel, settings }) {
      if (
        requestedModel !== null
        && requestedModel !== undefined
        && (typeof requestedModel !== "string" || !requestedModel.trim())
      ) {
        throw new RunSelectionInputError(
          "requested Claude model must be a nonblank string or null",
        );
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        throw new RunSelectionInputError("Claude Adapter settings must be an object");
      }
      if (settings.effort !== undefined && !isAgentEffort(settings.effort)) {
        throw new RunSelectionInputError("Claude effort must be low, medium, high, xhigh, or max");
      }
      const launchProtocol = settings.launchProtocol ?? null;
      if (launchProtocol !== null && launchProtocol !== LEGACY_C52_PRINT_PROTOCOL) {
        throw new RunSelectionInputError("Claude launch protocol is unsupported");
      }
      if (launchProtocol === LEGACY_C52_PRINT_PROTOCOL) {
        const allowedKeys = new Set([
          "attemptTimeoutMs",
          "effort",
          "launchProtocol",
          "runner",
        ]);
        if (
          !LEGACY_C52_MODELS.has(requestedModel?.trim())
          || settings.effort !== "high"
          || settings.runner !== "print"
          || Object.keys(settings).some((key) => !allowedKeys.has(key))
        ) {
          throw new RunSelectionInputError(
            "Claude legacy c52 print settings are invalid",
          );
        }
      }
      return deepFreeze({
        requestedModel: requestedModel?.trim() || null,
        settings: structuredClone(settings),
      });
    },
    createLaunchPlan({
      prompt,
      requestedModel,
      settings = {},
      resources = { skills: [], mcpServers: [] },
    }) {
      if (authMode === "none") {
        // Marked operator-safe: this text is a fixed framework string with no
        // runtime data in it, so the Engine may show it to whoever ran the eval.
        throw Object.assign(new Error("Claude Code is not authenticated"), {
          operatorReason:
            "Claude Code is not authenticated. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.",
        });
      }
      const legacyC52 = settings.launchProtocol === LEGACY_C52_PRINT_PROTOCOL;
      if (legacyC52) {
        if (
          !LEGACY_C52_MODELS.has(requestedModel)
          || settings.effort !== "high"
          || settings.runner !== "print"
        ) {
          throw new TypeError("Claude legacy c52 print settings are invalid");
        }
        const hasSkills = resources.skills.length > 0;
        const hasMcp = resources.mcpServers.length > 0;
        return deepFreeze({
          command,
          args: [
            ...(!hasSkills ? ["--disable-slash-commands"] : []),
            ...(hasMcp ? ["--mcp-config", ".mcp.json", "--strict-mcp-config"] : []),
            "--dangerously-skip-permissions",
            "--verbose",
            "--output-format",
            "stream-json",
            "--model",
            requestedModel,
            "--effort",
            settings.effort,
            "-p",
          ],
          env: {
            ...environment,
            CLI_VERSION: LEGACY_C52_TOGETHER_CLI_VERSION,
          },
          credentialRoutes,
          stdin: prompt,
          timeoutMs,
          workspaceFiles: workspaceFiles(resources, { legacyC52: true }),
          workspaceLayout: LEGACY_C52_WORKSPACE_LAYOUT,
        });
      }
      return deepFreeze({
        command,
        versionProbe: true,
        args: [
          ...baseArgs,
          ...(resources.skills.length === 0 ? ["--disable-slash-commands"] : []),
          ...(requestedModel ? ["--model", requestedModel] : []),
          ...(settings.effort ? ["--effort", settings.effort] : []),
          "--dangerously-skip-permissions",
          "-p",
        ],
        env: environment,
        credentialRoutes,
        stdin: prompt,
        timeoutMs,
        workspaceFiles: workspaceFiles(resources),
      });
    },
    createContinuationPlan({ handle, prompt, requestedModel, settings = {}, resources = { skills: [], mcpServers: [] } }) {
      const sessionId = continuationHandles.get(handle);
      if (!sessionId) {
        throw new TypeError("Claude continuation handle is unavailable");
      }
      if (typeof prompt !== "string" || !prompt.trim()) {
        throw new TypeError("Claude continuation prompt must be nonblank");
      }
      continuationHandles.delete(handle);
      return deepFreeze({
        command,
        args: [
          ...baseArgs,
          ...(resources.skills.length === 0 ? ["--disable-slash-commands"] : []),
          ...(requestedModel ? ["--model", requestedModel] : []),
          ...(settings.effort ? ["--effort", settings.effort] : []),
          "--resume",
          sessionId,
          "--dangerously-skip-permissions",
          "-p",
        ],
        env: environment,
        credentialRoutes,
        stdin: prompt,
        timeoutMs,
        workspaceFiles: [],
      });
    },
    redactControllerText(value) {
      return redactSecretText(value, secrets);
    },
    redactEvidenceBytes(value) {
      return redactSecretBytes(value, secrets);
    },
    decodeControllerEvidence({ stdout, exitCode = null }) {
      const { transcript, frames } = decodeControllerJsonl(stdout);
      const metadata = parseClaudeControllerMetadata(transcript) ?? {};
      const usage = metadata.usage && typeof metadata.usage === "object"
        ? metadata.usage
        : {};
      const sessionId = metadata.session_id ?? metadata.sessionId ?? null;
      const continuationHandle = sessionId
        ? Object.freeze(Object.create(null))
        : null;
      if (continuationHandle) continuationHandles.set(continuationHandle, sessionId);
      const operatorReason = claudeOperatorReason(metadata);
      const toolIds = new Set();
      const assistantFrames = frames.filter(frame => frame.message?.role === "assistant");
      assistantFrames.forEach((frame, index) => {
        if (!Array.isArray(frame.message.content)) return;
        frame.message.content.forEach((block, blockIndex) => {
          if (block?.type === "tool_use") toolIds.add(block.id || `${index}:${blockIndex}`);
        });
      });
      return deepFreeze({
        transcript,
        observedModel: metadata.model ?? null,
        sessionId,
        continuationHandle,
        ...(operatorReason ? { operatorReason } : {}),
        reportedResult: legacyReportedResult({
          exitCode,
          isError: metadata.is_error ?? null,
          subtype: metadata.subtype ?? null,
        }),
        metrics: {
          common: {
            inputTokens: usage.input_tokens ?? null,
            outputTokens: usage.output_tokens ?? null,
            reportedCostUsd: metadata.total_cost_usd ?? null,
            turns: metadata.num_turns ?? null,
            toolCalls: assistantFrames.length ? toolIds.size : null,
          },
          adapter: {
            subtype: metadata.subtype ?? null,
            isError: metadata.is_error ?? null,
            cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
          },
        },
      });
    },
  });
}
