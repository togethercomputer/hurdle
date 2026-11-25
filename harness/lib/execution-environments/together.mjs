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
import { createTogetherSocketProvider } from "./together-socket-provider.mjs";
import { randomBytes } from "node:crypto";
import { sealCredentialBindings } from "../sealed-credential-delivery.mjs";
import {
  agentCredentialStandIn,
  assertCredentialRoutes,
  prepareAgentCredentials,
  withAgentCredentialStandIns,
} from "../agent-credential-routes.mjs";
import { assertExchangeFactCapturePolicy } from "./guardian.mjs";
import { createTogetherGuardianController } from "./together-guardian.mjs";

// A run uses Together's Hurdle API, which boots Together's own Hurdle image
// over one socket. Together sizes that sandbox and ends it after 1 hour, so
// the only setting is how long Hurdle plans to keep it.
export const TOGETHER_MAX_LIFETIME_MS = 3_600_000;
const DEFAULT_SETTINGS = Object.freeze({
  maxLifetimeMs: TOGETHER_MAX_LIFETIME_MS,
});
// These were validated but never sent: the socket carries no sizing.
const REMOVED_SETTINGS = Object.freeze({
  cpuCount: "Together cpuCount is not supported: Together sizes its own sandbox. Remove cpuCount.",
  memoryMiB: "Together memoryMiB is not supported: Together sizes its own sandbox. Remove memoryMiB.",
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
  for (const key of Object.keys(settings)) {
    if (Object.hasOwn(REMOVED_SETTINGS, key))
      throw new RunSelectionInputError(REMOVED_SETTINGS[key]);
    if (!Object.hasOwn(DEFAULT_SETTINGS, key))
      throw new RunSelectionInputError(
        `unknown Together environment setting '${key}'`,
      );
  }
  const selected = { ...defaults, ...structuredClone(settings) };
  if (
    !Number.isSafeInteger(selected.maxLifetimeMs) ||
    selected.maxLifetimeMs < 1000 ||
    selected.maxLifetimeMs > TOGETHER_MAX_LIFETIME_MS
  )
    throw new RunSelectionInputError(
      `Together maxLifetimeMs must be an integer from 1000 to ${TOGETHER_MAX_LIFETIME_MS}; Together ends every sandbox after 1 hour`,
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
function defaultEntropy() {
  return randomBytes(32).toString("base64url");
}

// Keeps the shape a CLI may inspect before sending: a key's non-secret
// prefix (sk-ant-oat01-), or a JWT's header and claims with a fresh
// signature. The shared Agent credential module makes every stand-in.
export function agentCredentialSurrogate(value) {
  return agentCredentialStandIn(value, defaultEntropy);
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

export function validateSandboxEnvelope(envelope, providerName = "Together") {
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

function validProvider(provider) {
  return ["acquire", "stage", "run", "collectArtifacts", "dispose", "isDisposed"]
    .every((method) => typeof provider?.[method] === "function");
}

// `provider` serves every run when given; otherwise the Hurdle socket does.
export function createTogetherExecutionEnvironment({
  apiKey,
  provider: fixedProvider = null,
  guardian = createTogetherGuardianController(),
  defaults = DEFAULT_SETTINGS,
  captureMaxBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
  progressObserver = null,
  entropy = defaultEntropy,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new TypeError("Together Execution Environment requires an API key");
  if (typeof entropy !== "function")
    throw new TypeError("Together Execution Environment entropy must be a function");
  if (["prepare", "attach", "seal"].some((method) => typeof guardian?.[method] !== "function"))
    throw new TypeError("Together Execution Environment requires a Guardian controller");
  if (fixedProvider !== null && !validProvider(fixedProvider))
    throw new TypeError("Together Execution Environment requires a provider");
  const provider = fixedProvider ?? createTogetherSocketProvider();
  const normalizedDefaults = normalizeTogetherSettings(defaults);
  const progress = normalizeExecutionProgressObserver(progressObserver);
  // The socket provider reports workspace metadata.
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
      // The socket carries no credential into the sandbox; the Guardian
      // delivers every one on the Task's API hosts.
      const credentialBindings = sealCredentialBindings(envelope, { sandboxName: "Together" });
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
          // The Agent Adapter declares where its own model credential may go;
          // the controller-host Guardian keeps the real value and the workload
          // receives only a stand-in.
          const agentSubstitutions = prepareAgentCredentials(envelope.launchPlan, entropy);
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
              maxLifetimeMs: settings.maxLifetimeMs,
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
              // Together's Hurdle API hands the Guardian CA to the sandbox.
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
                        Object.entries(withAgentCredentialStandIns(plan, agentSubstitutions)).filter(
                          ([name]) => !HOST_LOCATORS.has(name),
                        ),
                      ),
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
