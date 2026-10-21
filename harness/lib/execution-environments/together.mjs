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
import { randomBytes } from "node:crypto";
import { validateSandboxEnvelope } from "./e2b.mjs";
import { createTogetherGuardianController } from "./together-guardian.mjs";
import { managedImageName } from "../managed-images.mjs";

const DEFAULT_SETTINGS = Object.freeze({
  snapshotAlias: managedImageName(["claude-code"], "together"),
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
    typeof selected.snapshotAlias !== "string" ||
    !selected.snapshotAlias.trim() ||
    selected.snapshotAlias.length > 256 ||
    /^REPLACE_WITH_/i.test(selected.snapshotAlias)
  )
    throw new RunSelectionInputError(
      "Together snapshotAlias must name a caller-owned snapshot",
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

export function createTogetherExecutionEnvironment({
  apiKey,
  provider = createTogetherProvider(),
  guardian = createTogetherGuardianController(),
  defaults = DEFAULT_SETTINGS,
  captureMaxBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
  progressObserver = null,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new TypeError("Together Execution Environment requires an API key");
  if (["prepare", "attach", "seal"].some((method) => typeof guardian?.[method] !== "function"))
    throw new TypeError("Together Execution Environment requires a Guardian controller");
  for (const method of [
    "acquire",
    "stage",
    "run",
    "collectArtifacts",
    "dispose",
    "isDisposed",
  ])
    if (typeof provider?.[method] !== "function")
      throw new TypeError("Together Execution Environment requires a provider");
  const normalizedDefaults = normalizeTogetherSettings(defaults);
  const progress = normalizeExecutionProgressObserver(progressObserver);
  const metadataSupported =
    typeof provider.collectWorkspaceArtifactMetadata === "function";
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
      return withExecutionCredentialValues(
        envelope,
        async (credentialValues) => {
          const settings = normalizeTogetherSettings(
            envelope.settings,
            normalizedDefaults,
          );
          const stdout = createBoundedControllerCapture(captureMaxBytes);
          const stderr = createBoundedControllerCapture(captureMaxBytes);
          const integrityIssues = [];
          const captureRequired = envelope.capture.mode !== "none";
          const egressCollections = [noEgress(captureRequired ? "capture-failed" : "unsupported-platform")];
          const resources = [];
          let guardianSession;
          const workloadCredentials = Object.fromEntries(envelope.credentialBindings.map(({ environmentName, delivery }) => [
            environmentName, delivery.kind === "captured-http-header"
              ? `tae_surrogate_${randomBytes(32).toString("base64url")}`
              : credentialValues[environmentName],
          ]));
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
              credentialBindings: envelope.credentialBindings, credentialValues,
              surrogates: workloadCredentials, profile: "external-guardian-http-metadata-v1",
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
