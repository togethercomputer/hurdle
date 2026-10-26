import { randomBytes } from "node:crypto";

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
import {
  assertCredentialRoutes,
  prepareAgentCredentials,
  withAgentCredentialStandIns,
} from "../agent-credential-routes.mjs";
import {
  assertExchangeFactCapturePolicy,
  createE2BGuardianController,
} from "./e2b-guardian.mjs";
import { createE2BProvider } from "./e2b-provider.mjs";

const DEFAULT_SETTINGS = Object.freeze({
  captureProfile: "external-guardian-http-metadata-v1",
  workloadTemplate: "base",
  guardianTemplate: "base",
  region: null,
  cpuCount: 2,
  memoryMiB: 512,
  maxLifetimeMs: 3_600_000,
});

const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
const HOST_PROCESS_LOCATORS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
]);

function sandboxLaunchEnvironment(environment = {}) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !HOST_PROCESS_LOCATORS.has(name)
  )));
}

function normalizeSettings(settings = {}, defaults = DEFAULT_SETTINGS) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new RunSelectionInputError("E2B environment settings must be an object");
  }
  for (const key of Object.keys(settings)) {
    if (!SETTING_KEYS.has(key)) {
      throw new RunSelectionInputError(`unknown E2B environment setting '${key}'`);
    }
  }
  const normalized = { ...defaults, ...structuredClone(settings) };
  for (const key of ["captureProfile", "workloadTemplate", "guardianTemplate"]) {
    if (typeof normalized[key] !== "string" || !normalized[key].trim()) {
      throw new RunSelectionInputError(`E2B ${key} must be a nonblank string`);
    }
  }
  for (const key of ["workloadTemplate", "guardianTemplate"]) {
    if (/^REPLACE_WITH_/i.test(normalized[key].trim())) {
      throw new RunSelectionInputError(
        `E2B ${key} is an example placeholder. Set environment.settings.${key} to a valid template ID or name:tag in your Runtime file before running.`,
      );
    }
  }
  if (normalized.captureProfile !== DEFAULT_SETTINGS.captureProfile) {
    throw new RunSelectionInputError(
      `unsupported E2B capture profile '${normalized.captureProfile}'`,
    );
  }
  if (normalized.region !== null) {
    throw new RunSelectionInputError("E2B region selection is not supported by this provider");
  }
  for (const [key, minimum, maximum] of [
    ["cpuCount", 1, 64],
    ["memoryMiB", 512, 262_144],
    ["maxLifetimeMs", 1_000, 86_400_000],
  ]) {
    if (
      !Number.isSafeInteger(normalized[key])
      || normalized[key] < minimum
      || normalized[key] > maximum
    ) {
      throw new RunSelectionInputError(
        `E2B ${key} must be an integer from ${minimum} to ${maximum}`,
      );
    }
  }
  return deepFreeze(normalized);
}

// Configuration checks can reuse the execution rules without allocating resources.
export { normalizeSettings as normalizeE2BSettings };

function unavailableEgress(reason = "capture-failed") {
  return {
    status: "unavailable",
    reason,
    requests: [],
    provenance: {
      producer: "e2b-guardian",
      authority: "environment",
      lifecyclePhase: "execution",
      capturedAt: new Date().toISOString(),
      trust: "environment-observed",
    },
  };
}

function missingArtifacts(declarations, reason) {
  return declarations.map((declaration) => ({
    ...declaration,
    status: "missing",
    reason,
  }));
}

function issue(code, phase, message) {
  return { code, phase, effect: "incomplete", message };
}

function aggregateProcesses(turns, stdout, stderr) {
  if (turns.length === 0) return null;
  const last = turns.at(-1);
  const stdoutSnapshot = stdout.snapshot();
  const stderrSnapshot = stderr.snapshot();
  return deepFreeze({
    ...last,
    stdout: stdoutSnapshot,
    stderr: stderrSnapshot,
    captureOverflow: !stdoutSnapshot.complete || !stderrSnapshot.complete,
    timedOut: turns.some(({ timedOut }) => timedOut),
    quiescent: turns.every(({ quiescent }) => quiescent),
    startedAt: turns[0].startedAt,
    endedAt: last.endedAt,
    durationMs: turns.reduce((sum, { durationMs }) => sum + durationMs, 0),
    turnCount: turns.length,
  });
}

function surrogateValue(entropy) {
  return `tae_visible_${entropy()}`;
}

function defaultEntropy() {
  return randomBytes(32).toString("base64url");
}

class EnvironmentCancellation extends Error {}

function requireActive(signal) {
  if (signal?.aborted) throw new EnvironmentCancellation("cancelled");
}

export function validateSandboxEnvelope(envelope, providerName = "E2B") {
  if (!envelope || typeof envelope !== "object") {
    throw new TypeError(`${providerName} execution requires an execution envelope`);
  }
  if (!Array.isArray(envelope.credentialBindings)) {
    throw new TypeError(`${providerName} credential bindings must be an array`);
  }
  if (typeof envelope.workspaceArtifactMetadata !== "boolean") {
    throw new TypeError(`${providerName} workspace metadata selection must be boolean`);
  }
  assertCredentialRoutes(envelope.launchPlan?.credentialRoutes, envelope.launchPlan?.env);
  const routes = envelope.capture?.routes ?? [];
  const blockedRequests = envelope.capture?.blockedRequests ?? [];
  assertExchangeFactCapturePolicy(envelope.capture?.exchangeFacts);
  const requestedProtocols = envelope.capture?.mode === "none"
    ? []
    : (envelope.capture?.protocols ?? ["http", "https"]);
  if (
    !Array.isArray(routes)
    || routes.some((route) => (
      typeof route?.host !== "string"
      || !route.host
      || !Array.isArray(route.selectedFields)
      || route.selectedFields.length > 32
      || route.selectedFields.some((field) => (
        typeof field !== "string"
        || !/^[a-z][a-z0-9-]{0,63}$/.test(field)
      ))
    ))
  ) {
    throw new TypeError(`${providerName} selected-field capture is not supported by this profile`);
  }
  if (
    !Array.isArray(blockedRequests)
    || blockedRequests.length > 128
    || blockedRequests.some((rule) => (
      !rule
      || typeof rule !== "object"
      || Array.isArray(rule)
      || Object.keys(rule).length !== 3
      || Object.keys(rule).some((key) => !["id", "method", "path"].includes(key))
      || typeof rule.id !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id)
      || typeof rule.method !== "string"
      || !/^[A-Z]{1,16}$/.test(rule.method)
      || typeof rule.path !== "string"
      || !rule.path.startsWith("/")
      || rule.path.includes("?")
      || rule.path.includes("#")
      || Buffer.byteLength(rule.path) > 4_096
    ))
    || new Set(blockedRequests.map(({ id }) => id)).size !== blockedRequests.length
    || new Set(blockedRequests.map(({ method, path }) => `${method}\n${path}`)).size
      !== blockedRequests.length
  ) {
    throw new TypeError(`${providerName} request blocking is not supported by this profile`);
  }
  const captureHosts = new Set(routes.map(({ host }) => host));
  for (const binding of envelope.credentialBindings) {
    const delivery = binding?.delivery;
    if (delivery?.kind === "environment") continue;
    if (
      delivery?.kind !== "captured-http-header"
      || !Array.isArray(delivery.hosts)
      || delivery.hosts.length === 0
      || delivery.hosts.some((host) => !captureHosts.has(host))
      || !Array.isArray(delivery.headerNames)
      || delivery.headerNames.length === 0
    ) {
      throw new TypeError(`${providerName} credential delivery is not supported by this capture profile`);
    }
  }
  if (
    !["none", "http-egress-metadata-v1", "network-egress-metadata-v1"].includes(
      envelope.capture?.mode,
    )
    || !Array.isArray(requestedProtocols)
    || requestedProtocols.some((protocol) => (
      !["http", "https", "wss"].includes(protocol)
    ))
    || (
      envelope.capture?.mode === "none"
      && (
        blockedRequests.length > 0
        || envelope.credentialBindings.some(({ delivery }) => (
          delivery.kind === "captured-http-header"
        ))
      )
    )
  ) {
    throw new TypeError(`${providerName} capture request is not supported by this capture profile`);
  }
}

const FAILURE_CODES = Object.freeze({
  acquire: "environment.acquire-failed",
  setup: "environment.capture-setup-failed",
  stage: "environment.stage-failed",
  execute: "environment.execute-failed",
  artifacts: "environment.artifact-collection-failed",
});

async function disposeResources(provider, resources, integrityIssues) {
  for (const resource of [...resources].reverse()) {
    try {
      await provider.dispose(resource);
      let disposed = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          if (await provider.isDisposed(resource)) {
            disposed = true;
            break;
          }
        } catch { /* retry bounded confirmation */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!disposed) throw new Error("resource remained present");
    } catch {
      integrityIssues.push(issue(
        "environment.dispose-failed",
        "dispose",
        "An E2B resource could not be confirmed disposed.",
      ));
    }
  }
}

export function createE2BExecutionEnvironment({
  apiKey,
  provider = createE2BProvider(),
  guardian = createE2BGuardianController(),
  entropy = defaultEntropy,
  captureMaxBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
  defaults = DEFAULT_SETTINGS,
  progressObserver = null,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new TypeError("E2B Execution Environment requires an API key");
  }
  if (
    !provider
    || ["acquire", "stage", "run", "collectArtifacts", "dispose", "isDisposed"]
      .some((method) => typeof provider[method] !== "function")
  ) {
    throw new TypeError("E2B Execution Environment requires a provider");
  }
  if (
    !guardian
    || ["prepare", "attach", "seal"]
      .some((method) => typeof guardian[method] !== "function")
  ) {
    throw new TypeError("E2B Execution Environment requires a Guardian controller");
  }
  if (typeof entropy !== "function") {
    throw new TypeError("E2B Execution Environment entropy must be a function");
  }
  const normalizedDefaults = normalizeSettings(defaults, DEFAULT_SETTINGS);
  const progress = normalizeExecutionProgressObserver(progressObserver);
  const workspaceArtifactMetadataSupported = typeof provider.collectWorkspaceArtifactMetadata
    === "function";

  return Object.freeze({
    id: "e2b",
    capabilities: Object.freeze([
      "environment.isolated-workspace",
      "environment.trusted-egress-capture",
      "environment.trusted-request-blocking",
      "environment.exclusive-resources",
      "environment.fixed-workspace-layout",
      ...(workspaceArtifactMetadataSupported
        ? ["environment.workspace-artifact-metadata"]
        : []),
    ]),
    captureCapabilities: Object.freeze({
      protocols: Object.freeze(["http", "https", "wss"]),
      selectedFields: true,
      exchangeFacts: true,
    }),
    normalizeSettings(settings = {}) {
      return normalizeSettings(settings, normalizedDefaults);
    },
    describeCapacity(settings = {}) {
      const normalized = normalizeSettings(settings, normalizedDefaults);
      return deepFreeze({
        maximumContinuousLifetimeMs: normalized.maxLifetimeMs,
      });
    },
    async execute(envelope) {
      validateSandboxEnvelope(envelope);
      if (envelope.workspaceArtifactMetadata && !workspaceArtifactMetadataSupported) {
        throw new TypeError("E2B workspace artifact metadata is unsupported by this provider");
      }
      return withExecutionCredentialValues(envelope, async (credentialValues) => {
        const settings = normalizeSettings(envelope.settings, normalizedDefaults);
        const stdout = createBoundedControllerCapture(captureMaxBytes);
        const stderr = createBoundedControllerCapture(captureMaxBytes);
        const resources = [];
        const integrityIssues = [];
        let process = null;
        let artifacts = missingArtifacts(envelope.outputArtifacts, "execution-not-started");
        let workspaceArtifacts = null;
        let egress = unavailableEgress("capture-failed");
        let guardianSession = null;
        let workload = null;
        let phase = "acquire";
        const reportStatus = (status) => reportExecutionProgress(progress, {
          kind: "environment-status", executionId: envelope.executionId,
          environmentId: "e2b", status,
        });
        let coordinatorFailure = null;
        try {
          if (envelope.signal?.aborted) {
            integrityIssues.push(issue(
              "environment.cancelled",
              "acquire",
              "E2B execution was cancelled before resource allocation.",
            ));
          } else {
            reportStatus("starting-guardian");
            const capture = await provider.acquire({
              role: "capture",
              template: settings.guardianTemplate,
              region: settings.region,
              maxLifetimeMs: settings.maxLifetimeMs,
              apiKey,
              signal: envelope.signal,
            });
            resources.push(capture);
            reportExecutionProgress(progress, {
              kind: "environment-resource-allocated",
              executionId: envelope.executionId,
              environmentId: "e2b",
              resource: {
                provider: "e2b",
                role: "guardian",
                id: capture.sandboxId,
              },
            });
            requireActive(envelope.signal);
            const surrogates = Object.fromEntries(
              envelope.credentialBindings.map(({ environmentName, delivery }) => [
                environmentName,
                delivery.kind === "captured-http-header"
                  ? surrogateValue(entropy)
                  : credentialValues[environmentName],
              ]),
            );
            // The Agent's own model credential stays with the Guardian too:
            // the workload receives a stand-in on every turn.
            const agentCredentials = prepareAgentCredentials(envelope.launchPlan, entropy);
            phase = "setup";
            guardianSession = await guardian.prepare({
              sandbox: capture,
              capture: envelope.capture,
              credentialBindings: envelope.credentialBindings,
              credentialValues,
              surrogates,
              agentCredentials,
              profile: settings.captureProfile,
              signal: envelope.signal,
            });
            requireActive(envelope.signal);
            reportStatus("guardian-started");
            phase = "acquire";
            reportStatus("starting-sandbox");
            workload = await provider.acquire({
              role: "execution",
              template: settings.workloadTemplate,
              region: settings.region,
              cpuCount: settings.cpuCount,
              memoryMiB: settings.memoryMiB,
              maxLifetimeMs: settings.maxLifetimeMs,
              apiKey,
              signal: envelope.signal,
            });
            resources.push(workload);
            reportExecutionProgress(progress, {
              kind: "environment-resource-allocated",
              executionId: envelope.executionId,
              environmentId: "e2b",
              resource: {
                provider: "e2b",
                role: "agent",
                id: workload.sandboxId,
              },
            });
            requireActive(envelope.signal);
            reportStatus("sandbox-started");
            reportStatus("preparing-environment");
            if (typeof provider.validate === "function") {
              await provider.validate(workload, {
                cpuCount: settings.cpuCount,
                memoryMiB: settings.memoryMiB,
                signal: envelope.signal,
              });
            }
            phase = "setup";
            await guardian.attach({
              workload,
              sandbox: capture,
              session: guardianSession,
              capture: envelope.capture,
              signal: envelope.signal,
            });
            requireActive(envelope.signal);
            try {
              const coordinated = await executeAgent(envelope, async (program) => {
                const turns = [];
                let agentElapsedMs = 0;
                let plan = program?.initialPlan;
                let firstTurn = true;
                if (
                  !plan
                  || !Number.isSafeInteger(program.maxTurns)
                  || program.maxTurns < 1
                  || program.maxTurns > 16
                  || !Number.isSafeInteger(program.maxElapsedMs)
                  || program.maxElapsedMs < 1
                ) {
                  throw new TypeError("E2B agent execution program is invalid");
                }
                try {
                  for (let ordinal = 1; ordinal <= program.maxTurns; ordinal += 1) {
                    if (agentElapsedMs >= program.maxElapsedMs) {
                      integrityIssues.push(issue(
                        "environment.agent-elapsed-limit",
                        "execute",
                        "Agent execution exceeded its elapsed-time limit.",
                      ));
                      break;
                    }
                    const remainingMs = program.maxElapsedMs - agentElapsedMs;
                    phase = "stage";
                    reportStatus("preparing-workspace");
                    await provider.stage(workload, {
                      fixtures: firstTurn ? envelope.fixtures : [],
                      workspaceFiles: plan.workspaceFiles ?? [],
                      signal: envelope.signal,
                    });
                    firstTurn = false;
                    requireActive(envelope.signal);
                    phase = "execute";
                    const turnStdout = createBoundedControllerCapture(captureMaxBytes);
                    const turnStderr = createBoundedControllerCapture(captureMaxBytes);
                    reportStatus("agent-running");
                    const processFacts = await provider.run(workload, {
                      launchPlan: {
                        ...plan,
                        timeoutMs: Math.min(plan.timeoutMs ?? remainingMs, remainingMs),
                      },
                      environment: {
                        ...sandboxLaunchEnvironment(withAgentCredentialStandIns(
                          plan,
                          agentCredentials,
                        )),
                        ...surrogates,
                        ...(guardianSession.workloadEnvironment ?? {}),
                      },
                      onStdout(value) {
                        stdout.append(value);
                        turnStdout.append(value);
                      },
                      onStderr(value) {
                        stderr.append(value);
                        turnStderr.append(value);
                      },
                      signal: envelope.signal,
                    });
                    requireActive(envelope.signal);
                    const turn = deepFreeze({
                      ...processFacts,
                      stdout: turnStdout.snapshot(),
                      stderr: turnStderr.snapshot(),
                      captureOverflow: !turnStdout.snapshot().complete
                        || !turnStderr.snapshot().complete,
                    });
                    turns.push(turn);
                    agentElapsedMs += turn.durationMs;
                    const elapsedLimitReached = agentElapsedMs >= program.maxElapsedMs;
                    if (elapsedLimitReached) {
                      integrityIssues.push(issue(
                        "environment.agent-elapsed-limit",
                        "execute",
                        "Agent execution exceeded its elapsed-time limit.",
                      ));
                    }
                    if (!turn.quiescent) {
                      integrityIssues.push(issue(
                        "environment.not-quiescent",
                        "seal",
                        "The evaluated process set could not be stopped before evidence sealing.",
                      ));
                      break;
                    }
                    if (elapsedLimitReached) break;
                    const directive = await program.onTurn(deepFreeze({ ordinal, process: turn }));
                    if (directive?.kind !== "continue") break;
                    if (ordinal >= program.maxTurns || !directive.nextPlan) {
                      integrityIssues.push(issue(
                        "environment.agent-turn-limit",
                        "execute",
                        "Agent continuation exceeded its turn limit.",
                      ));
                      break;
                    }
                    plan = directive.nextPlan;
                  }
                } catch (error) {
                  const cancelled = error instanceof EnvironmentCancellation
                    || envelope.signal?.aborted
                    || error?.name === "AbortError";
                  integrityIssues.push(cancelled
                    ? issue(
                      "environment.cancelled",
                      turns.length > 0 ? "execute" : phase,
                      "E2B execution was cancelled before all controller evidence could be completed.",
                    )
                    : issue(
                      FAILURE_CODES[phase],
                      phase,
                      "E2B execution failed before all controller evidence could be completed.",
                    ));
                }
                const aggregate = aggregateProcesses(turns, stdout, stderr);
                reportStatus("collecting-results");
                try {
                  egress = await guardian.seal({
                    sandbox: capture,
                    session: guardianSession,
                    signal: envelope.signal,
                  });
                } catch {
                  integrityIssues.push(issue(
                    "environment.egress-seal-failed",
                    "seal",
                    "External E2B egress evidence could not be sealed.",
                  ));
                  egress = unavailableEgress("capture-failed");
                }
                if (aggregate?.quiescent) {
                  try {
                    phase = "artifacts";
                    artifacts = await provider.collectArtifacts(
                      workload,
                      envelope.outputArtifacts,
                    );
                  } catch {
                    integrityIssues.push(issue(
                      FAILURE_CODES.artifacts,
                      "artifacts",
                      "E2B artifact collection failed.",
                    ));
                  }
                  if (envelope.workspaceArtifactMetadata) {
                    try {
                      phase = "artifacts";
                      workspaceArtifacts = await provider.collectWorkspaceArtifactMetadata(
                        workload,
                      );
                      if (
                        !Array.isArray(workspaceArtifacts)
                        || workspaceArtifacts.length > 200
                        || workspaceArtifacts.some((artifact, index) => (
                          !artifact
                          || typeof artifact !== "object"
                          || Array.isArray(artifact)
                          || Object.keys(artifact).sort().join("\0") !== "bytes\0path\0source"
                          || typeof artifact.path !== "string"
                          || !artifact.path
                          || artifact.path.startsWith("/")
                          || artifact.path.includes("\\")
                          || artifact.path.split("/").includes("..")
                          || !Number.isSafeInteger(artifact.bytes)
                          || artifact.bytes < 0
                          || artifact.source !== "controller_capture"
                          || (index > 0 && workspaceArtifacts[index - 1].path >= artifact.path)
                        ))
                      ) {
                        throw new TypeError("invalid workspace artifact metadata");
                      }
                    } catch {
                      workspaceArtifacts = null;
                      integrityIssues.push(issue(
                        "environment.workspace-artifact-metadata-failed",
                        "artifacts",
                        "E2B workspace artifact metadata could not be sealed.",
                      ));
                    }
                  }
                } else {
                  artifacts = missingArtifacts(
                    envelope.outputArtifacts,
                    "process-not-quiescent",
                  );
                }
                return {
                  process: aggregate,
                  artifacts,
                  workspaceArtifacts,
                  integrityIssues,
                  egressCollections: [egress],
                };
              });
              process = coordinated?.process ?? null;
            } catch (error) {
              coordinatorFailure = error;
            }
          }
        } catch (error) {
          const cancelled = error instanceof EnvironmentCancellation
            || envelope.signal?.aborted
            || error?.name === "AbortError";
          integrityIssues.push(cancelled
            ? issue(
              "environment.cancelled",
              process ? "execute" : "acquire",
              "E2B execution was cancelled before all controller evidence could be completed.",
            )
            : issue(
              FAILURE_CODES[phase],
              phase,
              "E2B execution failed before all controller evidence could be completed.",
            ));
        } finally {
          if (resources.length) reportStatus("stopping-sandboxes");
          await disposeResources(provider, resources, integrityIssues);
        }
        if (coordinatorFailure) throw coordinatorFailure;
        return deepFreeze({
          process,
          artifacts,
          workspaceArtifacts,
          integrityIssues,
          egressCollections: [egress],
        });
      });
    },
  });
}
