import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import net from "node:net";

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
  connectSandbox,
  DEFAULT_SANDBOX_URL,
  openControl,
  pumpStream,
  stagedFiles,
  STDERR_STREAM_ID,
  STDOUT_STREAM_ID,
} from "../sandbox-lite-client.mjs";
import {
  drainSealedGuardian,
  MAX_CAPTURE_BYTES,
  sealedJournalCollection,
} from "./e2b-guardian.mjs";
import { validateSandboxEnvelope } from "./e2b.mjs";
import { agentCredentials } from "./together.mjs";
import {
  controlState,
  createTogetherGuardianController,
  stopLocalProcess,
} from "./together-guardian.mjs";

// Runs a cell on the experimental single-connection sandbox API. The Guardian
// (mitmproxy and the policy addon) runs on this machine exactly as it does for
// the Together backend; what changes is the transport. The platform boots a
// fixed image, installs the CA sent on the upgrade, confines all egress to the
// one WebSocket, and starts the agent once the control channel delivers its
// environment and workspace inputs. Every agent connection arrives as a yamux
// stream that begins with the agent's own CONNECT, and is pumped verbatim into
// the local proxy.

const DEFAULT_SETTINGS = Object.freeze({
  url: DEFAULT_SANDBOX_URL,
  image: "",
  maxLifetimeMs: 600_000,
});
const HOST_LOCATORS = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR"]);
const SEAL_RESERVE_MS = 30_000;
const PRODUCER = "together-lite-host-guardian";
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

// Profile defaults may omit the image; a run must supply one.
export function normalizeTogetherLiteSettings(
  settings = {},
  defaults = DEFAULT_SETTINGS,
  { requireImage = true } = {},
) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new RunSelectionInputError("Together Lite environment settings must be an object");
  for (const key of Object.keys(settings))
    if (!Object.hasOwn(DEFAULT_SETTINGS, key))
      throw new RunSelectionInputError(`unknown Together Lite environment setting '${key}'`);
  const selected = { ...defaults, ...structuredClone(settings) };
  let url;
  try { url = new URL(selected.url); } catch { url = null; }
  if (!url || (url.protocol !== "wss:" && url.protocol !== "ws:"))
    throw new RunSelectionInputError("Together Lite url must be a WebSocket URL");
  if (
    typeof selected.image !== "string"
    || ((requireImage || selected.image !== "") && !IMAGE_DIGEST.test(selected.image))
  )
    throw new RunSelectionInputError("Together Lite image must be a sha256 digest of a platform image");
  if (
    !Number.isSafeInteger(selected.maxLifetimeMs)
    || selected.maxLifetimeMs < 1000
    || selected.maxLifetimeMs > 3_600_000
  )
    throw new RunSelectionInputError("Together Lite maxLifetimeMs must be an integer from 1000 to 3600000");
  return deepFreeze(selected);
}

const issue = (code, phase, message) => ({ code, phase, effect: "incomplete", message });

function active(signal) {
  if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
}

function noEgress(reason) {
  return {
    status: "unavailable",
    reason,
    requests: [],
    provenance: {
      producer: "together-lite-execution-environment",
      authority: "environment",
      lifecyclePhase: "execution",
      capturedAt: new Date().toISOString(),
      trust: "environment-observed",
    },
  };
}

// Reads the pinned inputs a sandbox backend would stage, with the same bounds
// and digest checks as the Linux sandbox's stageInputs; the digests are
// verified when the entries are encoded.
async function stagedInputs(fixtures, workspaceFiles) {
  const entries = [];
  for (const fixture of fixtures) {
    const bytes = await readFile(fixture.pinnedPath);
    if (Number.isSafeInteger(fixture.maxBytes) && bytes.byteLength > fixture.maxBytes) {
      throw new Error(`Pinned fixture '${fixture.source}' exceeds its ${fixture.maxBytes}-byte limit`);
    }
    entries.push({ path: fixture.workspacePath, bytes, sha256: fixture.sha256 });
  }
  for (const file of workspaceFiles) {
    const bytes = file.source.kind === "generated"
      ? file.source.bytes
      : await readFile(file.source.pinnedPath);
    entries.push({ path: file.path, bytes, sha256: file.source.sha256 });
  }
  return entries;
}

// The Guardian session was prepared locally and never attached to a sandbox,
// so sealing is the shared drain and verification against the local journal.
export async function sealLocalGuardian(session) {
  const state = await drainSealedGuardian(
    (action) => controlState(session.proxyPort, session.controlToken, action),
    { policyFingerprint: session.policyFingerprint },
  );
  await stopLocalProcess(session.proxy);
  const info = await stat(session.journalPath);
  if (info.size !== state.journalBytes || info.size > MAX_CAPTURE_BYTES) {
    throw new Error("Guardian journal exceeded its sealed byte bound");
  }
  return sealedJournalCollection(state, await readFile(session.journalPath), PRODUCER);
}

export function createTogetherLiteExecutionEnvironment({
  apiKey,
  guardian = createTogetherGuardianController(),
  connect = connectSandbox,
  seal = sealLocalGuardian,
  defaults = DEFAULT_SETTINGS,
  captureMaxBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
  progressObserver = null,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new TypeError("Together Lite Execution Environment requires an API key");
  if (typeof guardian?.prepare !== "function")
    throw new TypeError("Together Lite Execution Environment requires a Guardian controller");
  const normalizedDefaults = normalizeTogetherLiteSettings(defaults, DEFAULT_SETTINGS, { requireImage: false });
  const progress = normalizeExecutionProgressObserver(progressObserver);
  return Object.freeze({
    id: "together-lite",
    capabilities: Object.freeze([
      "environment.trusted-egress-capture",
      "environment.trusted-request-blocking",
      "environment.exclusive-resources",
    ]),
    captureCapabilities: Object.freeze({
      protocols: Object.freeze(["http", "https", "wss"]),
      selectedFields: true,
      exchangeFacts: true,
    }),
    normalizeSettings: (settings) => normalizeTogetherLiteSettings(settings, normalizedDefaults),
    describeCapacity: (settings) => deepFreeze({
      maximumContinuousLifetimeMs: normalizeTogetherLiteSettings(settings, normalizedDefaults).maxLifetimeMs,
    }),
    async execute(envelope) {
      validateSandboxEnvelope(envelope, "Together Lite");
      if (envelope.workspaceArtifactMetadata)
        throw new TypeError("Together Lite workspace artifact metadata is unsupported");
      return withExecutionCredentialValues(envelope, async (credentialValues) => {
        const settings = normalizeTogetherLiteSettings(envelope.settings, normalizedDefaults);
        const stdout = createBoundedControllerCapture(captureMaxBytes);
        const stderr = createBoundedControllerCapture(captureMaxBytes);
        const integrityIssues = [];
        const captureRequired = envelope.capture.mode !== "none";
        const egressCollections = [noEgress(captureRequired ? "capture-failed" : "unsupported-platform")];
        const workloadCredentials = Object.fromEntries(envelope.credentialBindings.map(
          ({ environmentName, delivery }) => [
            environmentName,
            delivery.kind === "captured-http-header"
              ? `tae_surrogate_${randomBytes(32).toString("base64url")}`
              : credentialValues[environmentName],
          ],
        ));
        const agentSubstitutions = agentCredentials(envelope.launchPlan.env);
        const agentSurrogates = Object.fromEntries(agentSubstitutions.map(
          ({ environmentName, surrogate }) => [environmentName, surrogate],
        ));
        // Artifacts leave the sandbox only through the Guardian; nothing is
        // read back from the image after the run.
        const artifacts = envelope.outputArtifacts.map((declaration) => ({
          ...declaration,
          status: "missing",
          reason: "unsupported-environment",
        }));
        let guardianSession;
        let session;
        let process = null;
        let phase = "setup";
        let coordinatorFailure;
        const pumps = new Set();
        const reportStatus = (status) => reportExecutionProgress(progress, {
          kind: "environment-status", executionId: envelope.executionId,
          environmentId: "together-lite", status,
        });
        const failure = (error) => integrityIssues.push(issue(
          error?.name === "AbortError" || envelope.signal?.aborted
            ? "environment.cancelled"
            : `environment.${phase}-failed`,
          phase,
          `Together Lite execution could not complete during ${phase}.`,
        ));
        try {
          active(envelope.signal);
          reportStatus("starting-guardian");
          guardianSession = await guardian.prepare({
            capture: envelope.capture,
            credentialBindings: envelope.credentialBindings,
            credentialValues,
            surrogates: workloadCredentials,
            profile: "external-guardian-http-metadata-v1",
            agentCredentials: agentSubstitutions,
            signal: envelope.signal,
          });
          active(envelope.signal);
          reportStatus("guardian-started");
          phase = "acquire";
          reportStatus("starting-sandbox");
          const connectedAt = Date.now();
          session = await connect({
            url: settings.url,
            image: settings.image,
            apiKey,
            ca: guardianSession.caCertificate,
            signal: envelope.signal,
          });
          reportExecutionProgress(progress, {
            kind: "environment-resource-allocated",
            executionId: envelope.executionId,
            environmentId: "together-lite",
            resource: { provider: "together-lite", role: "agent", id: settings.image },
          });
          active(envelope.signal);
          reportStatus("sandbox-started");
          phase = "setup";
          reportStatus("preparing-environment");
          session.mux.onStream = (stream) => {
            const id = stream.ID();
            if (id === STDOUT_STREAM_ID) {
              stream.on("data", (chunk) => stdout.append(chunk.toString("utf8")));
              stream.on("error", () => {});
              return;
            }
            if (id === STDERR_STREAM_ID) {
              stream.on("data", (chunk) => stderr.append(chunk.toString("utf8")));
              stream.on("error", () => {});
              return;
            }
            const socket = net.connect({ host: "127.0.0.1", port: guardianSession.proxyPort });
            pumps.add(socket);
            socket.once("close", () => pumps.delete(socket));
            pumpStream(stream, socket);
          };
          const control = openControl(session.mux);
          try {
            await executeAgent(envelope, async (program) => {
              try {
                const plan = program.initialPlan;
                if (
                  !plan
                  || program.maxTurns !== 1
                  || !Number.isSafeInteger(program.maxElapsedMs)
                  || program.maxElapsedMs < 1
                )
                  throw new TypeError("Together Lite execution program is invalid");
                phase = "stage";
                active(envelope.signal);
                reportStatus("preparing-workspace");
                const files = stagedFiles(await stagedInputs(envelope.fixtures ?? [], plan.workspaceFiles ?? []));
                phase = "execute";
                active(envelope.signal);
                const remainingMs = settings.maxLifetimeMs - (Date.now() - connectedAt) - SEAL_RESERVE_MS;
                if (remainingMs < 1000)
                  throw new Error("Together Lite lifetime is insufficient for execution and sealing");
                const budgetMs = Math.min(
                  plan.timeoutMs ?? program.maxElapsedMs,
                  program.maxElapsedMs,
                  remainingMs,
                );
                // The platform owns proxy and trust settings inside the image;
                // the agent receives only its own configuration and surrogates,
                // and the staged inputs are in the workspace before it starts.
                control.hello({
                  ...Object.fromEntries(
                    Object.entries(plan.env ?? {}).filter(([name]) => !HOST_LOCATORS.has(name)),
                  ),
                  ...agentSurrogates,
                  ...workloadCredentials,
                }, files);
                const startedAt = new Date();
                await control.waitFor("ready", { signal: envelope.signal, timeoutMs: budgetMs });
                reportStatus("agent-running");
                let exit;
                try {
                  exit = await control.waitFor("exit", { signal: envelope.signal, timeoutMs: budgetMs });
                } catch (error) {
                  if (error?.name === "AbortError") throw error;
                  if (session.closeCode !== null || session.error)
                    throw new Error(`Together Lite transport closed before exit (${session.closeCode ?? "error"})`);
                  exit = { code: null, signal: null, timedOut: true, quiescent: false };
                }
                const endedAt = new Date();
                process = deepFreeze({
                  exitCode: Number.isSafeInteger(exit.code) ? exit.code : null,
                  signal: typeof exit.signal === "string" ? exit.signal : null,
                  timedOut: exit.timedOut === true,
                  quiescent: exit.quiescent !== false,
                  spawnError: null,
                  startedAt: startedAt.toISOString(),
                  endedAt: endedAt.toISOString(),
                  durationMs: endedAt - startedAt,
                  stdout: stdout.snapshot(),
                  stderr: stderr.snapshot(),
                  captureOverflow: !stdout.snapshot().complete || !stderr.snapshot().complete,
                  turnCount: 1,
                });
                active(envelope.signal);
                reportStatus("collecting-results");
                phase = "seal";
                try {
                  egressCollections[0] = await seal(guardianSession);
                } catch {
                  if (captureRequired)
                    integrityIssues.push(issue("environment.egress-seal-failed", "seal",
                      "Together Lite egress evidence could not be sealed."));
                }
                if (!process.quiescent)
                  integrityIssues.push(issue("environment.not-quiescent", "seal",
                    "The evaluated process set could not be stopped before evidence sealing."));
              } catch (error) {
                failure(error);
              }
              return { process, artifacts, workspaceArtifacts: null, integrityIssues, egressCollections };
            });
          } catch (error) {
            coordinatorFailure = error;
          }
        } catch (error) {
          failure(error);
        } finally {
          if (session) reportStatus("stopping-sandboxes");
          for (const socket of pumps) socket.destroy();
          // Closing the connection is what ends the sandbox.
          try { await session?.close(1000); } catch { /* transport already gone */ }
          try { await guardian.close?.(guardianSession); } catch {
            integrityIssues.push(issue("environment.egress-relay-close-failed", "dispose",
              "Together Lite Guardian could not be closed."));
          }
        }
        if (coordinatorFailure) throw coordinatorFailure;
        return deepFreeze({ process, artifacts, workspaceArtifacts: null, integrityIssues, egressCollections });
      });
    },
  });
}
