import {
  createBoundedControllerCapture,
  DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
} from "../controller-transcript.mjs";
import {
  executeAgent,
  withExecutionCredentialValues,
} from "../execution-envelope.mjs";
import {
  normalizeExecutionProgressObserver,
  reportExecutionProgress,
} from "../execution-progress.mjs";
import { deepFreeze, RunSelectionInputError } from "../run-model.mjs";
import { createTogetherProvider } from "./together-provider.mjs";
import { createTogetherSocketProvider } from "./together-socket-provider.mjs";
import { randomBytes } from "node:crypto";
import { validateSandboxEnvelope } from "./e2b.mjs";
import { createTogetherGuardianController } from "./together-guardian.mjs";

// Without a snapshot alias a run uses Together's Hurdle API, which boots
// Together's own Hurdle image over one socket. An alias names a caller-owned
// snapshot on the sandbox API instead; cpuCount and memoryMiB apply only there.
const DEFAULT_SETTINGS = Object.freeze({
  snapshotAlias: null,
  cpuCount: 1,
  memoryMiB: 2048,
  maxLifetimeMs: 3_600_000,
});
const HOST_LOCATORS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
]);
export function normalizeTogetherSettings(
  settings = {},
  defaults = DEFAULT_SETTINGS,
) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new RunSelectionInputError(
      "Together environment settings must be an object",
    );
  for (const key of Object.keys(settings))
    if (!Object.hasOwn(DEFAULT_SETTINGS, key))
      throw new RunSelectionInputError(
        `unknown Together environment setting '${key}'`,
      );
  const selected = { ...defaults, ...structuredClone(settings) };
  if (
    selected.snapshotAlias !== null &&
    (typeof selected.snapshotAlias !== "string" ||
      !selected.snapshotAlias.trim() ||
      selected.snapshotAlias.length > 256 ||
      /^REPLACE_WITH_/i.test(selected.snapshotAlias))
  )
    throw new RunSelectionInputError(
      "Together snapshotAlias must name a caller-owned snapshot, or be omitted for Together's Hurdle image",
    );
  for (const [key, minimum, maximum] of [
    ["cpuCount", 1, 16],
    ["memoryMiB", 1024, 131072],
    ["maxLifetimeMs", 1000, 86400000],
  ]) {
    if (
      !Number.isSafeInteger(selected[key]) ||
      selected[key] < minimum ||
      selected[key] > maximum
    )
      throw new RunSelectionInputError(
        `Together ${key} must be an integer from ${minimum} to ${maximum}`,
      );
  }
  if (
    selected.memoryMiB < selected.cpuCount * 1024 ||
    selected.memoryMiB > selected.cpuCount * 8192
  )
    throw new RunSelectionInputError(
      "Together memoryMiB must be between 1024 and 8192 per CPU",
    );
  return deepFreeze(selected);
}
const issue = (code, phase, message) => ({
  code,
  phase,
  effect: "incomplete",
  message,
});
function active(signal) {
  if (signal?.aborted)
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
}
// Agent model credentials the controller-host Guardian substitutes, so the
// workload only ever holds surrogates. Each is sent only to its own hosts.
const AGENT_CREDENTIAL_ROUTES = Object.freeze({
  ANTHROPIC_API_KEY: { hosts: ["api.anthropic.com"], headerNames: ["x-api-key", "authorization"] },
  CLAUDE_CODE_OAUTH_TOKEN: { hosts: ["api.anthropic.com"], headerNames: ["authorization"] },
  CODEX_API_KEY: { hosts: ["api.openai.com"], headerNames: ["authorization"] },
  CODEX_ACCESS_TOKEN: { hosts: ["chatgpt.com", "api.openai.com"], headerNames: ["authorization"] },
});

// Keeps the shape a CLI may inspect before sending: a key's non-secret
// prefix (sk-ant-oat01-), or a JWT's header and claims with a fresh
// signature. The signature, not the claims, is what grants access.
export function agentCredentialSurrogate(value) {
  const random = randomBytes(32).toString("base64url");
  const parts = value.split(".");
  if (parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    return `${parts[0]}.${parts[1]}.${random}`;
  }
  // Only published, non-secret key prefixes are kept; anything else could
  // carry part of the secret.
  const prefix = /^sk-(?:ant-(?:api|oat|admin)\d{2}-|proj-|svcacct-)?/.exec(value)?.[0] ?? "";
  return `${prefix}${random}`;
}

function agentCredentials(env = {}) {
  return Object.entries(env)
    .filter(([name, value]) => Object.hasOwn(AGENT_CREDENTIAL_ROUTES, name)
      && typeof value === "string" && value.trim())
    .map(([environmentName, value]) => ({
      environmentName,
      value,
      surrogate: agentCredentialSurrogate(value),
      ...AGENT_CREDENTIAL_ROUTES[environmentName],
    }));
}

// A Hurdle sandbox holds no secrets. A credential the task declared for
// environment delivery, which authoring does for a Suite whose checks are
// advisory, is delivered through the Guardian instead: swapped into the
// Authorization header on the task's own API hosts, exactly as a required
// check would have declared. Without API hosts there is nowhere to swap it,
// so the run is refused with a reason the operator sees.
function sealedCredentialBindings(envelope) {
  const hosts = envelope.capture.mode === "none"
    ? []
    : envelope.capture.routes.map(({ host }) => host);
  const sealed = [];
  const exposed = [];
  for (const binding of envelope.credentialBindings) {
    if (binding.delivery.kind === "captured-http-header" || hosts.length === 0) {
      sealed.push(binding);
      if (binding.delivery.kind !== "captured-http-header") exposed.push(binding.environmentName);
      continue;
    }
    sealed.push({ ...binding, delivery: { kind: "captured-http-header", hosts: [...hosts], headerNames: ["authorization"] } });
  }
  if (exposed.length) {
    const message = `Together sandboxes receive credentials only through the Guardian; the Suite declares no API hosts to carry ${exposed.join(", ")}`;
    throw Object.assign(new TypeError(message), { operatorReason: message });
  }
  return Object.freeze(sealed);
}

function noEgress(reason = "unsupported-platform") {
  return {
    status: "unavailable",
    reason,
    requests: [],
    provenance: {
      producer: "together-execution-environment",
      authority: "environment",
      lifecyclePhase: "execution",
      capturedAt: new Date().toISOString(),
      trust: "environment-observed",
    },
  };
}

function validProvider(provider) {
  return ["acquire", "stage", "run", "collectArtifacts", "dispose", "isDisposed"]
    .every((method) => typeof provider?.[method] === "function");
}

// `provider` serves every run when given. Otherwise each run's settings choose:
// a snapshot alias selects the sandbox API, none selects the Hurdle socket.
export function createTogetherExecutionEnvironment({
  apiKey,
  provider: fixedProvider = null,
  guardian = createTogetherGuardianController(),
  defaults = DEFAULT_SETTINGS,
  captureMaxBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
  progressObserver = null,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new TypeError("Together Execution Environment requires an API key");
  if (["prepare", "attach", "seal"].some((method) => typeof guardian?.[method] !== "function"))
    throw new TypeError("Together Execution Environment requires a Guardian controller");
  if (fixedProvider !== null && !validProvider(fixedProvider))
    throw new TypeError("Together Execution Environment requires a provider");
  const providers = {};
  const providerFor = (settings) => {
    if (fixedProvider) return fixedProvider;
    const kind = settings.snapshotAlias ? "sandboxApi" : "socket";
    providers[kind] ??= kind === "socket" ? createTogetherSocketProvider() : createTogetherProvider();
    return providers[kind];
  };
  const normalizedDefaults = normalizeTogetherSettings(defaults);
  const progress = normalizeExecutionProgressObserver(progressObserver);
  // Both built-in providers report workspace metadata.
  const metadataSupported =
    !fixedProvider || typeof fixedProvider.collectWorkspaceArtifactMetadata === "function";
  return Object.freeze({
    id: "together",
    capabilities: Object.freeze([
      "environment.isolated-workspace",
      "environment.trusted-egress-capture",
      "environment.trusted-request-blocking",
      "environment.exclusive-resources",
      "environment.fixed-workspace-layout",
      ...(metadataSupported ? ["environment.workspace-artifact-metadata"] : []),
    ]),
    captureCapabilities: Object.freeze({
      protocols: Object.freeze(["http", "https", "wss"]),
      selectedFields: true,
      exchangeFacts: true,
    }),
    normalizeSettings: (settings) =>
      normalizeTogetherSettings(settings, normalizedDefaults),
    describeCapacity: (settings) =>
      deepFreeze({
        maximumContinuousLifetimeMs: normalizeTogetherSettings(
          settings,
          normalizedDefaults,
        ).maxLifetimeMs,
      }),
    async execute(envelope) {
      validateSandboxEnvelope(envelope, "Together");
      if (envelope.workspaceArtifactMetadata && !metadataSupported)
        throw new TypeError(
          "Together workspace artifact metadata is unsupported by this provider",
        );
      const settings = normalizeTogetherSettings(envelope.settings, normalizedDefaults);
      const provider = providerFor(settings);
      const credentialBindings = provider.sealedOnly
        ? sealedCredentialBindings(envelope)
        : envelope.credentialBindings;
      return withExecutionCredentialValues(
        envelope,
        async (credentialValues) => {
          const stdout = createBoundedControllerCapture(captureMaxBytes);
          const stderr = createBoundedControllerCapture(captureMaxBytes);
          const integrityIssues = [];
          const captureRequired = envelope.capture.mode !== "none";
          const egressCollections = [noEgress(captureRequired ? "capture-failed" : "unsupported-platform")];
          const resources = [];
          let guardianSession;
          const workloadCredentials = Object.fromEntries(credentialBindings.map(({ environmentName, delivery }) => [
            environmentName, delivery.kind === "captured-http-header"
              ? `tae_surrogate_${randomBytes(32).toString("base64url")}`
              : credentialValues[environmentName],
          ]));
          const agentSubstitutions = agentCredentials(envelope.launchPlan.env);
          const agentSurrogates = Object.fromEntries(agentSubstitutions.map(
            ({ environmentName, surrogate }) => [environmentName, surrogate],
          ));
          let resource;
          let process = null;
          let phase = "acquire";
          const reportStatus = (status) => reportExecutionProgress(progress, {
            kind: "environment-status", executionId: envelope.executionId,
            environmentId: "together", status,
          });
          let artifacts = envelope.outputArtifacts.map((declaration) => ({
            ...declaration,
            status: "missing",
            reason: "execution-not-started",
          }));
          let workspaceArtifacts = null;
          let coordinatorFailure;
          const failure = (error) =>
            integrityIssues.push(
              issue(
                error?.name === "AbortError" || envelope.signal?.aborted
                  ? "environment.cancelled"
                  : `environment.${phase === "setup" ? "setup" : phase === "artifacts" ? "artifact-collection" : phase}-failed`,
                phase,
                `Together execution could not complete during ${phase}.`,
              ),
            );
          try {
            active(envelope.signal);
            // All workload egress crosses the controller-host Guardian, so it
            // runs for every task; capture policy applies to capture hosts only.
            reportStatus("starting-guardian");
            phase = "setup";
            guardianSession = await guardian.prepare({
              capture: envelope.capture,
              credentialBindings, credentialValues,
              surrogates: workloadCredentials, profile: "external-guardian-http-metadata-v1",
              agentCredentials: agentSubstitutions,
              signal: envelope.signal,
            });
            active(envelope.signal);
            reportStatus("guardian-started");
            phase = "acquire";
            reportStatus("starting-sandbox");
            const allocatedAt = Date.now();
            resource = await provider.acquire({
              ...settings,
              apiKey,
              // Bartender's Hurdle API hands the Guardian CA to the sandbox.
              caCertificate: guardianSession.caCertificate,
              signal: envelope.signal,
            });
            resources.push(resource);
            reportExecutionProgress(progress, {
              kind: "environment-resource-allocated",
              executionId: envelope.executionId,
              environmentId: "together",
              resource: {
                provider: "together",
                role: "agent",
                id: resource.sandboxId,
              },
            });
            active(envelope.signal);
            reportStatus("sandbox-started");
            phase = "setup";
            reportStatus("preparing-environment");
            await provider.validate?.(resource, {
              ...settings,
              signal: envelope.signal,
            });
            await guardian.attach({ workload: resource,
              session: guardianSession, signal: envelope.signal });
            active(envelope.signal);
            try {
              await executeAgent(envelope, async (program) => {
                try {
                  const plan = program.initialPlan;
                  if (
                    !plan ||
                    program.maxTurns !== 1 ||
                    !Number.isSafeInteger(program.maxElapsedMs) ||
                    program.maxElapsedMs < 1
                  )
                    throw new TypeError(
                      "Together execution program is invalid",
                    );
                  phase = "stage";
                  active(envelope.signal);
                  reportStatus("preparing-workspace");
                  await provider.stage(resource, {
                    fixtures: envelope.fixtures,
                    workspaceFiles: plan.workspaceFiles ?? [],
                    signal: envelope.signal,
                  });
                  phase = "execute";
                  active(envelope.signal);
                  const remainingMs =
                    settings.maxLifetimeMs -
                    (Date.now() - allocatedAt) -
                    30_000;
                  if (remainingMs < 1000)
                    throw new Error(
                      "Together lifetime is insufficient for execution and sealing",
                    );
                  reportStatus("agent-running");
                  const facts = await provider.run(resource, {
                    launchPlan: {
                      ...plan,
                      timeoutMs: Math.min(
                        plan.timeoutMs ?? program.maxElapsedMs,
                        program.maxElapsedMs,
                        remainingMs,
                      ),
                    },
                    environment: {
                      ...Object.fromEntries(
                        Object.entries(plan.env ?? {}).filter(
                          ([name]) => !HOST_LOCATORS.has(name),
                        ),
                      ),
                      ...agentSurrogates,
                      ...workloadCredentials,
                      ...(guardianSession?.workloadEnvironment ?? {}),
                    },
                    onStdout: (value) => stdout.append(value),
                    onStderr: (value) => stderr.append(value),
                    signal: envelope.signal,
                  });
                  process = deepFreeze({
                    ...facts,
                    stdout: stdout.snapshot(),
                    stderr: stderr.snapshot(),
                    captureOverflow:
                      !stdout.snapshot().complete ||
                      !stderr.snapshot().complete,
                    turnCount: 1,
                  });
                  active(envelope.signal);
                  reportStatus("collecting-results");
                  phase = "seal";
                  try {
                    egressCollections[0] = await guardian.seal({ session: guardianSession });
                  } catch {
                    // Without capture hosts the journal is diagnostic only.
                    if (captureRequired)
                      integrityIssues.push(issue("environment.egress-seal-failed", "seal",
                        "Together egress evidence could not be sealed."));
                  }
                  if (!process.quiescent)
                    integrityIssues.push(
                      issue(
                        "environment.not-quiescent",
                        "seal",
                        "The evaluated process set could not be stopped before evidence sealing.",
                      ),
                    );
                  else {
                    phase = "artifacts";
                    artifacts = await provider.collectArtifacts(
                      resource,
                      envelope.outputArtifacts,
                    );
                    if (envelope.workspaceArtifactMetadata)
                      workspaceArtifacts =
                        await provider.collectWorkspaceArtifactMetadata(
                          resource,
                        );
                  }
                } catch (error) {
                  failure(error);
                }
                return {
                  process,
                  artifacts,
                  workspaceArtifacts,
                  integrityIssues,
                  egressCollections,
                };
              });
            } catch (error) {
              // Errors from the coordinator itself must retain the engine's
              // adapter-defect handling. Operational failures are reported below.
              coordinatorFailure = error;
            }
          } catch (error) {
            failure(error);
          } finally {
            if (resources.length) reportStatus("stopping-sandboxes");
            try { await guardian.close?.(guardianSession); }
            catch {
              integrityIssues.push(issue("environment.egress-relay-close-failed", "dispose",
                "Together capture transport could not be closed."));
            }
            for (const allocated of resources.reverse()) {
              try {
                await provider.dispose(allocated);
                let disposed = false;
                for (let attempt = 0; attempt < 10; attempt += 1) {
                  try {
                    if (await provider.isDisposed(allocated)) {
                      disposed = true;
                      break;
                    }
                  } catch { /* retry bounded confirmation */ }
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
                if (!disposed) throw new Error("resource remained present");
              } catch {
                integrityIssues.push(
                  issue(
                    "environment.dispose-failed",
                    "dispose",
                    "A Together sandbox could not be confirmed terminated.",
                  ),
                );
              }
            }
          }
          if (coordinatorFailure) throw coordinatorFailure;
          return deepFreeze({
            process,
            artifacts,
            workspaceArtifacts,
            integrityIssues,
            egressCollections,
          });
        },
      );
    },
  });
}
