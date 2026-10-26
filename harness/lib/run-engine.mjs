import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RUN_CONCURRENCY, mapConcurrentRunCells, normalizeRunConcurrency } from "./run-concurrency.mjs";
import { credentialRoutesAreValid } from "./agent-credential-routes.mjs";

import { runDeterministicEvaluator } from "./evaluator-runtime.mjs";
import { evaluateAuthority } from "./evaluation-authority.mjs";
import { resolveAuthoritySelections } from "./authority-profile.mjs";
import {
  captureCompatibilityDiagnostics,
  normalizeEgressCollections,
} from "./egress-evidence.mjs";
import { redactEvidenceText, redactSecretBytes, redactSecretText } from "./evidence-redaction.mjs";
import {
  createJudgePhase,
  JudgeSelectionInputError,
} from "./judge-phase.mjs";
import {
  normalizeExecutionProgressObserver,
  projectVerdictReasons,
  reportExecutionProgress,
} from "./execution-progress.mjs";
import { deriveRunTrust } from "./run-trust.mjs";
import { composeResultStoreRunEngine } from "./result-store-composition.mjs";
import {
  closeExecutionCredentialLease,
  createExecutionEnvelope,
} from "./execution-envelope.mjs";
import {
  deepFreeze,
  prepareRunDefinition,
  RunDefinitionInputError,
  RunSelectionInputError,
  selectDefinitionIds,
  sha256,
} from "./run-model.mjs";

const MAX_EVALUATOR_SOURCE_BYTES = 512 * 1024;
const MAX_EVALUATOR_SOURCE_TOTAL_BYTES = 2 * 1024 * 1024;

function evaluatorSourceMediaType(path) {
  return path.endsWith(".json")
    ? "application/json; charset=utf-8"
    : "text/javascript; charset=utf-8";
}

async function persistEvaluatorSources(writer, runId, prepared, capturedAt) {
  const references = [];
  let totalBytes = 0;
  for (const module of prepared.evaluatorSourceModules ?? []) {
    const bytes = await readFile(module.pinnedPath);
    if (sha256(bytes) !== module.sha256) {
      throw new Error("Pinned Deterministic Evaluator source changed before capture");
    }
    if (
      bytes.byteLength > MAX_EVALUATOR_SOURCE_BYTES
      || totalBytes + bytes.byteLength > MAX_EVALUATOR_SOURCE_TOTAL_BYTES
    ) {
      continue;
    }
    totalBytes += bytes.byteLength;
    references.push(await writer.putEvidence(runId, {
      kind: "canonical-evidence",
      bytes,
      mediaType: evaluatorSourceMediaType(module.path),
      provenance: `run_definition_behavior_source:${encodeURIComponent(module.path)}`,
      authority: "controller",
      producer: "run-engine",
      lifecyclePhase: "definition",
      capturedAt,
      trust: "controller_verified",
    }));
  }
  return deepFreeze(references);
}

function normalizedAgentSettings(adapter, requestedModel, settings) {
  const normalized = adapter.normalizeSettings
    ? adapter.normalizeSettings({ requestedModel: requestedModel ?? null, settings: settings ?? {} })
    : { requestedModel: requestedModel ?? null, settings: settings ?? {} };
  if (
    !normalized
    || typeof normalized !== "object"
    || normalized.settings === null
    || typeof normalized.settings !== "object"
    || Array.isArray(normalized.settings)
  ) {
    throw new TypeError("Agent Adapter returned invalid normalized settings");
  }
  return deepFreeze({
    requestedModel: normalized.requestedModel ?? null,
    settings: structuredClone(normalized.settings),
  });
}

// Environments skip collection after interrupted or untrusted execution. Every
// declared artifact still needs an outcome, or checks read undeclared paths.
function withUncollectedArtifacts(artifacts, declarations) {
  const capturedAt = new Date().toISOString();
  const uncollected = ({ path, kind, maxBytes, required }) => ({
    path,
    kind,
    maxBytes,
    required,
    status: "rejected",
    reason: "not_collected",
    capturedAt,
  });
  // Sandboxes report every artifact as not started until they collect it, so
  // such an artifact was never collected rather than missing from the workspace.
  const collected = artifacts.map((artifact) => (
    artifact.status === "missing" && artifact.reason === "execution-not-started" ? uncollected(artifact) : artifact
  ));
  const reported = new Set(collected.map(({ path }) => path));
  return [
    ...collected,
    ...declarations.filter(({ path }) => !reported.has(path)).map(uncollected),
  ];
}

function requiredArtifactIssues(artifacts) {
  return artifacts
    .filter((artifact) => (
      artifact.required
      && (artifact.status !== "captured" || artifact.textEncoding === "invalid_utf8")
    ))
    .map((artifact) => ({
      code: artifact.textEncoding === "invalid_utf8"
        ? "artifact.required-invalid-text"
        : artifact.status === "missing"
          ? "artifact.required-missing"
          : artifact.reason === "not_collected"
            ? "artifact.required-uncollected"
            : "artifact.required-rejected",
      phase: "seal",
      effect: "incomplete",
      message: artifact.textEncoding === "invalid_utf8"
        ? `Required text Output Artifact '${artifact.path}' is not valid UTF-8.`
        : artifact.status === "missing"
          ? `Required Output Artifact '${artifact.path}' was not produced.`
          : artifact.reason === "not_collected"
            ? `Required Output Artifact '${artifact.path}' was not collected because execution did not complete.`
            : `Required Output Artifact '${artifact.path}' could not be sealed safely.`,
    }));
}

function processIssues(processResult, operatorReason = null) {
  const issues = [];
  if (!processResult.stdout.complete || !processResult.stderr.complete) {
    issues.push({
      code: "controller.capture-incomplete",
      phase: "execute",
      effect: "incomplete",
      message: "Controller-owned process output exceeded its capture limit.",
    });
  }
  if (processResult.spawnError) {
    issues.push({
      code: "environment.spawn-failed",
      phase: "execute",
      effect: "incomplete",
      message: "The evaluated agent process could not be started.",
    });
  } else if (processResult.timedOut) {
    issues.push({
      code: "environment.timed-out",
      phase: "execute",
      effect: "incomplete",
      message: "The evaluated agent process exceeded its timeout.",
    });
  } else if (processResult.exitCode !== 0) {
    const reason = boundedFailureReason(operatorReason);
    issues.push({
      code: "environment.nonzero-exit",
      phase: "execute",
      effect: "incomplete",
      message: reason
        ? `The evaluated agent process did not exit cleanly: ${reason}`
        : "The evaluated agent process did not exit cleanly.",
    });
  }
  return issues;
}

function transcriptInvalidIssue() {
  return {
    code: "controller.transcript-invalid",
    phase: "execute",
    effect: "incomplete",
    message: "The Agent Adapter could not normalize the controller-observed transcript.",
  };
}

function judgeRequestInputUnavailableIssue() {
  return {
    code: "judge.request-input-unavailable",
    phase: "judge-input",
    effect: "incomplete",
    message: "The selected exact Judge request could not be formed from complete, byte-preserving controller evidence.",
  };
}

function assertDecodedControllerEvidence(candidate) {
  if (
    !candidate
    || typeof candidate.transcript !== "string"
    || !candidate.transcript.trim()
  ) {
    throw new TypeError("Agent Adapter returned no transcript");
  }
  return candidate;
}

function executionShape(snapshot, values = {}) {
  return {
    adapterId: snapshot.agent.adapterId,
    environmentId: snapshot.environment.environmentId,
    requestedModel: snapshot.agent.requestedModel,
    observedModel: null,
    sessionId: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    ...values,
  };
}

function judgeRequires(judgePlan, requirement) {
  const requirements = judgePlan?.requestProtocol?.requirements ?? [];
  return requirements.includes(requirement);
}

// Legacy c52 rendered the run label, the wrapper's reported result, a
// whole-second duration, and the session id into the audit prompt. The Judge
// renders these verbatim, so this projection is a scored surface: keep the
// rounding and the label shape identical to harness/run.mjs.
function legacyExecutionSummary(processResult, decoded, invocation) {
  const reportedResult = decoded?.reportedResult;
  if (
    typeof reportedResult !== "string"
    || !reportedResult
    || !Number.isSafeInteger(processResult?.durationMs)
    || processResult.durationMs < 0
    || !Number.isSafeInteger(invocation?.repeatOrdinal)
    || invocation.repeatOrdinal < 1
  ) {
    return null;
  }
  return deepFreeze({
    reportedResult,
    durationSeconds: Math.round(processResult.durationMs / 1000),
    runLabel: `run${invocation.repeatOrdinal}`,
    sessionId: decoded.sessionId ?? null,
  });
}

function executionFacts(processResult, decoded, snapshot) {
  return deepFreeze(executionShape(snapshot, {
    observedModel: decoded.observedModel ?? null,
    sessionId: decoded.sessionId ?? null,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    timedOut: processResult.timedOut,
    startedAt: processResult.startedAt,
    endedAt: processResult.endedAt,
    durationMs: processResult.durationMs,
  }));
}

function emptyExecution(snapshot) {
  return executionShape(snapshot);
}

function observedToolVersions(observed, agentAdapter, credentials, evidenceRedaction) {
  // Framework observation always overrides decoded/controller-supplied metrics.
  if (!observed.toolVersions || typeof observed.toolVersions !== "object" || Array.isArray(observed.toolVersions)) {
    return { toolVersions: null };
  }
  const toolVersions = {};
  for (const name of ["runner", "node", "python", "pip"]) {
    const value = observed.toolVersions[name];
    const valid = typeof value === "string"
      && /^\d{1,4}\.\d{1,4}(?:\.\d{1,8})?(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(value);
    const redacted = valid
      ? redactTargetText(redactControllerText(agentAdapter, value), credentials, evidenceRedaction)
      : null;
    toolVersions[name] = valid && redacted === value ? value : null;
  }
  return { toolVersions };
}

function redactControllerText(agentAdapter, value) {
  if (!value) return "";
  const redacted = agentAdapter.redactControllerText
    ? agentAdapter.redactControllerText(value)
    : value;
  if (typeof redacted !== "string") {
    throw new TypeError("Agent Adapter returned invalid redacted controller evidence");
  }
  return redacted;
}

function redactTargetText(value, credentials, evidenceRedaction = null) {
  const redacted = redactSecretText(value, Object.values(credentials));
  return redactEvidenceText(redacted, evidenceRedaction);
}

function redactTargetBytes(value, credentials, evidenceRedaction = null) {
  const redacted = redactSecretBytes(value, Object.values(credentials));
  return evidenceRedaction
    ? Buffer.from(redactEvidenceText(redacted.toString("utf8"), evidenceRedaction))
    : redacted;
}

function observedEvidenceMetadata({ capturedAt, lifecyclePhase, provenance, trust }) {
  return {
    authority: "controller",
    producer: "agent",
    lifecyclePhase,
    capturedAt,
    trust,
    provenance,
  };
}

async function persistEgressCollections(
  writer,
  runId,
  observed,
  credentials,
  selectedFieldNames,
  exchangeFactProfiles,
  blockedRequests,
  relevantHosts = null,
) {
  const normalized = normalizeEgressCollections({
    collections: observed.egressCollections ?? [{
      status: "unavailable",
      reason: "not-configured",
      requests: [],
      provenance: {
        producer: observed?.environmentId ?? "execution-environment",
        authority: "environment",
        lifecyclePhase: "execution",
        capturedAt: new Date().toISOString(),
        trust: "environment-observed",
      },
    }],
    selectedFieldNames,
    exchangeFactProfiles,
    blockedRequests,
    relevantHosts,
    redactText: (value) => redactTargetText(value, credentials),
  });
  const manifest = [];
  const evaluator = [];
  for (const collection of normalized) {
    const body = {
      status: collection.status,
      ...(collection.status === "unavailable" ? { reason: collection.reason } : {}),
      requests: collection.requests,
    };
    const bytes = Buffer.from(`${JSON.stringify(body)}\n`);
    if (bytes.byteLength > 16 * 1024 * 1024) {
      throw new TypeError("Execution Environment egress collection exceeds the limit");
    }
    const content = await writer.putEvidence(runId, {
      kind: "canonical-evidence",
      bytes,
      mediaType: "application/json",
      provenance: "bounded_egress_collection",
      authority: collection.provenance.authority,
      producer: collection.provenance.producer,
      lifecyclePhase: collection.provenance.lifecyclePhase,
      capturedAt: collection.provenance.capturedAt,
      trust: collection.provenance.trust,
    });
    const common = {
      status: collection.status,
      ...(collection.status === "unavailable" ? { reason: collection.reason } : {}),
      provenance: collection.provenance,
      content,
    };
    manifest.push(common);
    evaluator.push({
      ...body,
      provenance: collection.provenance,
      evidenceRef: content.sha256,
      requests: body.requests.map((request) => ({
        ...request,
        evidenceRef: content.sha256,
      })),
    });
  }
  return { manifest, evaluator };
}

function redactArtifacts(agentAdapter, artifacts, credentials, evidenceRedaction) {
  return artifacts.map((artifact) => {
    if (artifact.status !== "captured") {
      return artifact;
    }
    const adapterRedacted = agentAdapter.redactEvidenceBytes
      ? agentAdapter.redactEvidenceBytes(artifact.bytes)
      : artifact.bytes;
    const bytes = redactTargetBytes(
      adapterRedacted,
      credentials,
      artifact.kind === "text" ? evidenceRedaction : null,
    );
    if (bytes.byteLength > artifact.maxBytes) {
      return {
        path: artifact.path,
        kind: artifact.kind,
        maxBytes: artifact.maxBytes,
        required: artifact.required,
        status: "rejected",
        reason: "redaction_exceeds_limit",
        capturedAt: artifact.capturedAt,
      };
    }
    return {
      ...artifact,
      bytes,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
  });
}

const MAX_FAILURE_REASON_BYTES = 512;

// An operator whose first run fails needs the cause, not just the phase. Keep
// it short and single-line so it stays readable in a record and the Viewer.
function boundedFailureReason(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) return null;
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= MAX_FAILURE_REASON_BYTES) return text;
  return new TextDecoder()
    .decode(bytes.subarray(0, MAX_FAILURE_REASON_BYTES - 1))
    .replace(/\uFFFD+$/u, "") + "\u2026";
}

class ExpectedExecutionError extends Error {
  constructor(reason = null) {
    super("The selected agent could not complete its execution contract");
    this.name = "ExpectedExecutionError";
    // Only a reason the thrower explicitly marked operator-safe may travel.
    // Arbitrary Adapter or Environment error text can carry anything it had in
    // scope, so it stays scrubbed even though it would be more informative.
    this.reason = boundedFailureReason(reason?.operatorReason ?? null);
  }
}

class LaunchPlanInputError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "LaunchPlanInputError";
    this.code = code;
  }
}

function assertValidLaunchPlan(launchPlan) {
  const argsValid = launchPlan?.args === undefined || (
    Array.isArray(launchPlan.args)
    && launchPlan.args.every((arg) => typeof arg === "string")
  );
  const envValid = launchPlan?.env === undefined || (
    launchPlan.env !== null
    && typeof launchPlan.env === "object"
    && !Array.isArray(launchPlan.env)
    && Object.values(launchPlan.env).every((value) => typeof value === "string")
  );
  const stdinValid = launchPlan?.stdin === undefined
    || typeof launchPlan.stdin === "string"
    || launchPlan.stdin instanceof Uint8Array;
  const timeoutValid = launchPlan?.timeoutMs === undefined
    || (Number.isSafeInteger(launchPlan.timeoutMs) && launchPlan.timeoutMs > 0);
  const credentialRoutesValid = envValid
    && credentialRoutesAreValid(launchPlan?.credentialRoutes, launchPlan?.env);
  const workspaceFilesValid = launchPlan?.workspaceFiles === undefined || (
    Array.isArray(launchPlan.workspaceFiles)
    && launchPlan.workspaceFiles.every((file) => (
      file
      && typeof file === "object"
      && typeof file.path === "string"
      && file.source
      && typeof file.source === "object"
      && ["selected-resource", "generated"].includes(file.source.kind)
    ))
  );
  const workspaceLayoutValid = launchPlan?.workspaceLayout === undefined || (
    launchPlan.workspaceLayout
    && typeof launchPlan.workspaceLayout === "object"
    && !Array.isArray(launchPlan.workspaceLayout)
    && Object.keys(launchPlan.workspaceLayout).length === 4
    && launchPlan.workspaceLayout.schemaVersion === 1
    && [
      "workingDirectory",
      "homeDirectory",
      "temporaryDirectory",
    ].every((key) => (
      typeof launchPlan.workspaceLayout[key] === "string"
      && launchPlan.workspaceLayout[key].startsWith("/")
      && !launchPlan.workspaceLayout[key].includes("\0")
    ))
  );
  if (
    !launchPlan
    || typeof launchPlan !== "object"
    || Array.isArray(launchPlan)
    || typeof launchPlan.command !== "string"
    || !launchPlan.command.trim()
    || !argsValid
    || !envValid
    || !stdinValid
    || !timeoutValid
    || !credentialRoutesValid
    || !workspaceFilesValid
    || !workspaceLayoutValid
  ) {
    throw new TypeError("Agent Adapter returned an invalid launch plan");
  }
}

function safeWorkspacePath(path) {
  return typeof path === "string"
    && path.length > 0
    && !path.includes("\\")
    && !path.startsWith("/")
    && !path.split("/").some((segment) => (
      segment === "" || segment === "." || segment === ".."
    ));
}

function bindLaunchPlan(launchPlan, prepared, credentials) {
  const paths = new Set([
    ".home",
    ...prepared.pinnedFixtures.map(({ workspacePath }) => workspacePath),
    ...prepared.snapshot.task.outputArtifacts.map(({ path }) => path),
  ]);
  const workspaceFiles = [];
  for (const file of launchPlan.workspaceFiles ?? []) {
    const overlaps = [...paths].some((path) => (
      file.path === path
      || file.path.startsWith(`${path}/`)
      || path.startsWith(`${file.path}/`)
    ));
    if (!safeWorkspacePath(file.path) || overlaps) {
      throw new LaunchPlanInputError(
        "resource.invalid-workspace-plan",
        "Agent Adapter returned an invalid workspace file path.",
      );
    }
    paths.add(file.path);
    if (file.source.kind === "selected-resource") {
      const selected = prepared.pinnedResourceByHandle[file.source.handle];
      if (!selected || selected.sha256 !== file.source.sha256) {
        throw new LaunchPlanInputError(
          "resource.unselected-reference",
          "Agent Adapter referenced an unselected resource.",
        );
      }
      workspaceFiles.push({
        path: file.path,
        source: {
          kind: "pinned",
          pinnedPath: selected.pinnedPath,
          sha256: selected.sha256,
        },
      });
      continue;
    }
    if (
      file.source.kind !== "generated"
      || !(file.source.bytes instanceof Uint8Array)
      || file.source.bytes.byteLength > 1024 * 1024
      || sha256(file.source.bytes) !== file.source.sha256
    ) {
      throw new LaunchPlanInputError(
        "resource.invalid-generated-file",
        "Agent Adapter returned an invalid generated workspace file.",
      );
    }
    workspaceFiles.push({
      path: file.path,
      source: {
        kind: "generated",
        bytes: new Uint8Array(file.source.bytes),
        sha256: file.source.sha256,
      },
    });
  }
  const env = { ...(launchPlan.env ?? {}) };
  for (const name of Object.keys(credentials)) {
    if (Object.hasOwn(env, name) || (
      prepared.snapshot.environment.environmentId === "local"
      && ["HOME", "PIP_REQUIRE_VIRTUALENV"].includes(name)
    )) {
      throw new LaunchPlanInputError(
        "credential.environment-collision",
        `Execution environment collides with Target credential '${name}'.`,
      );
    }
  }
  return {
    ...launchPlan,
    env,
    workspaceFiles,
  };
}

function runReference(record) {
  const runTrustReasons = record.verdict === "pass"
    ? []
    : projectVerdictReasons(record.runTrust.reasons);
  return deepFreeze({
    id: record.id,
    revision: record.revision,
    state: record.state,
    verdict: record.verdict,
    verdictReasons: record.verdict === "pass" ? [] : projectVerdictReasons(record.verdictReasons),
    ...(runTrustReasons.length > 0 ? { runTrustReasons } : {}),
    judgeStatus: record.judgeStatus,
    authorityProfileId: record.snapshot.evaluation.authority?.id ?? null,
    judgeRequired: record.snapshot.evaluation.authority?.judge.availability === "required",
    baselineVerdict: record.deterministic.baseline?.verdict ?? null,
    effectiveVerdict: record.deterministic.effective?.verdict ?? null,
    judgeOutcome: record.judge?.kind === "result" ? record.judge.outcome : null,
    headlineDecidedBy: record.headline.decidedBy,
    snapshotFingerprint: record.snapshotFingerprint,
    invocation: {
      ordinal: record.invocation.ordinal,
      repeatOrdinal: record.invocation.repeatOrdinal,
      attemptOrdinal: record.invocation.attemptOrdinal,
      rootRunId: record.invocation.rootRunId,
      retryOf: record.invocation.retryOf,
    },
  });
}

function completedAttempt({
  record,
  integrityIssues,
  evaluatorStatus,
  judgeSources,
  preparedJudgeRequest = null,
}) {
  return {
    record,
    reference: runReference(record),
    integrityIssueCodes: integrityIssues.map(({ code }) => code),
    evaluatorStatus,
    judgeSources,
    preparedJudgeRequest,
  };
}

function authorityEvaluatorStatus(status) {
  return {
    not_requested: "not_configured",
    blocked_by_evidence: "blocked_by_run_trust",
    invalid: "invalid_output",
  }[status] ?? status;
}

function authorityRecordFields({
  snapshot,
  checks,
  integrityIssues,
  evaluatorStatus,
  judgeStatus = "not_requested",
  judge = null,
}) {
  const runTrust = deriveRunTrust({ integrityIssues });
  const normalizedEvaluatorStatus = snapshot.evaluation.deterministicEvaluator === null
    ? "not_configured"
    : authorityEvaluatorStatus(evaluatorStatus);
  const evaluated = evaluateAuthority({
    taskKind: snapshot.evaluation.taskKind,
    authority: snapshot.evaluation.authority,
    runTrust,
    evaluatorStatus: normalizedEvaluatorStatus,
    checks,
    judgeStatus,
    judge,
  });
  return deepFreeze({
    headline: evaluated.headline,
    verdict: evaluated.headline.verdict,
    verdictReasons: evaluated.headline.verdictReasons,
    runTrust,
    deterministic: evaluated.deterministic,
    checks: evaluated.resolvedChecks,
  });
}

async function runOne({
  writer,
  judgePhase,
  prepared,
  task,
  agentAdapter,
  executionEnvironment,
  agentSettings,
  experimentVersion,
  invocation,
  credentials,
  signal,
  onExecutionStarted,
}) {
  const id = `run_${randomUUID()}`;
  const evidenceRedaction = prepared.snapshot.task.evidenceRedaction;
  const createdAt = new Date().toISOString();
  const storedInvocation = deepFreeze({
    ...invocation,
    rootRunId: invocation.rootRunId ?? id,
  });
  const base = {
    schemaVersion: 3,
    id,
    snapshot: prepared.snapshot,
    snapshotFingerprint: prepared.snapshotFingerprint,
    experimentVersion: experimentVersion ?? null,
    invocation: storedInvocation,
    createdAt,
  };
  await writer.createQueued(deepFreeze({
    ...base,
    revision: 0,
    state: "queued",
    headline: null,
    verdict: null,
    judgeStatus: "not_requested",
    judge: null,
  }));

  const startedAt = new Date().toISOString();
  await writer.transition(0, deepFreeze({
    ...base,
    revision: 1,
    state: "running",
    headline: null,
    verdict: null,
    judgeStatus: "not_requested",
    judge: null,
    startedAt,
  }));
  let evaluatorSourceEvidencePromise = null;
  const captureEvaluatorSources = () => {
    evaluatorSourceEvidencePromise ??= persistEvaluatorSources(
      writer,
      id,
      prepared,
      createdAt,
    ).catch(() => deepFreeze([]));
    return evaluatorSourceEvidencePromise;
  };

  try {
    onExecutionStarted?.(id);
    if (signal?.aborted) throw new ExpectedExecutionError(new Error("Evaluation cancelled before execution."));
    let observed = null;
    let launchPlan = prepared.launchPlan ?? null;
    if (!launchPlan) {
      try {
        launchPlan = await agentAdapter.createLaunchPlan({
          prompt: task.prompt,
          snapshot: prepared.snapshot,
          requestedModel: agentSettings.requestedModel,
          settings: agentSettings.settings,
          resources: prepared.pinnedResources,
        });
      } catch (error) {
        throw new ExpectedExecutionError(error);
      }
      assertValidLaunchPlan(launchPlan);
      launchPlan = bindLaunchPlan(launchPlan, prepared, credentials);
    }
    if (signal?.aborted) throw new ExpectedExecutionError(new Error("Evaluation cancelled before execution."));
    const envelope = createExecutionEnvelope({
      executionId: id,
      settings: prepared.snapshot.environment.settings,
      launchPlan,
      fixtures: prepared.pinnedFixtures,
      outputArtifacts: prepared.snapshot.task.outputArtifacts,
      workspaceArtifactMetadata: judgeRequires(
        prepared.judgePlan,
        "workspace-artifact-metadata",
      ),
      target: prepared.snapshot.target,
      credentialDefinitions: prepared.snapshot.task.credentialDefinitions,
      credentialValues: credentials,
      signal,
    });
    try {
      observed = await executionEnvironment.execute(envelope);
    } catch (error) {
      throw new ExpectedExecutionError(error);
    } finally {
      closeExecutionCredentialLease(envelope);
    }
    if (!observed?.process) {
      if (
        !observed
        || !Array.isArray(observed.integrityIssues)
        || observed.integrityIssues.length === 0
        || !Array.isArray(observed.artifacts)
        || !Array.isArray(observed.egressCollections)
      ) {
        throw new TypeError("Execution Environment returned no process observation");
      }
      const integrityIssues = [
        ...observed.integrityIssues.map((issueValue) => ({
          ...issueValue,
          message: redactTargetText(
            redactControllerText(agentAdapter, issueValue.message),
            credentials,
            evidenceRedaction,
          ),
        })),
      ];
      const egress = await persistEgressCollections(
        writer,
        id,
        observed,
        credentials,
        prepared.snapshot.target.egress.selectedFields,
        prepared.snapshot.target.egress.exchangeFactProfiles,
        prepared.snapshot.target.egress.blockedRequests,
        prepared.snapshot.target.egress.relevantHosts,
      );
      const authorityFields = authorityRecordFields({
        snapshot: prepared.snapshot,
        checks: [],
        integrityIssues,
        evaluatorStatus: "blocked_by_evidence",
      });
      const evaluatorSourceEvidence = await captureEvaluatorSources();
      const completed = deepFreeze({
        ...base,
        revision: 2,
        state: "complete",
        ...authorityFields,
        judgeStatus: "not_requested",
        judge: null,
        startedAt,
        completedAt: new Date().toISOString(),
        execution: emptyExecution(prepared.snapshot),
        metrics: { common: {}, adapters: {}, targets: {} },
        integrityIssues,
        evidence: {
          transcript: null,
          stderr: null,
          structured: evaluatorSourceEvidence,
          artifacts: [],
          egress: egress.manifest,
        },
      });
      const stored = await writer.transition(1, completed);
      return completedAttempt({
        record: stored,
        integrityIssues,
        evaluatorStatus: "blocked_by_evidence",
        judgeSources: {
          transcript: null,
          executionSummary: null,
          workspaceArtifacts: null,
          stderr: null,
          artifacts: [],
          egress: egress.evaluator,
          lifecycle: {},
        },
      });
    }

    const redactedStdout = redactTargetText(
      redactControllerText(agentAdapter, observed.process.stdout.text),
      credentials,
      evidenceRedaction,
    );
    const redactedStderr = redactTargetText(
      redactControllerText(agentAdapter, observed.process.stderr.text),
      credentials,
      evidenceRedaction,
    );

    let decoded = null;
    let rawJudgeTranscript = null;
    const decodeIssues = [];
    try {
      const rawCandidate = assertDecodedControllerEvidence(
        await agentAdapter.decodeControllerEvidence({
          stdout: observed.process.stdout.text,
          stderr: observed.process.stderr.text,
          exitCode: observed.process.exitCode,
          signal: observed.process.signal,
          timedOut: observed.process.timedOut,
        }),
      );
      const candidate = assertDecodedControllerEvidence(
        await agentAdapter.decodeControllerEvidence({
          stdout: redactedStdout,
          stderr: redactedStderr,
          exitCode: observed.process.exitCode,
          signal: observed.process.signal,
          timedOut: observed.process.timedOut,
        }),
      );
      decoded = {
        ...candidate,
        transcript: redactTargetText(
          redactControllerText(agentAdapter, candidate.transcript),
          credentials,
          evidenceRedaction,
        ),
      };
      rawJudgeTranscript = rawCandidate.transcript;
    } catch {
      decodeIssues.push(transcriptInvalidIssue());
    }

    const execution = executionFacts(observed.process, decoded ?? {}, prepared.snapshot);
    const processEvidenceMetadata = observedEvidenceMetadata({
      capturedAt: observed.process.endedAt,
      lifecyclePhase: "execute",
      provenance: "controller_observed_parent_pipe",
      trust: "controller_observed",
    });
    const transcript = decoded
      ? await writer.putEvidence(id, {
          kind: "canonical-evidence",
          bytes: Buffer.from(decoded.transcript),
          mediaType: "application/x-ndjson",
          ...processEvidenceMetadata,
        })
      : null;
    const rawStdout = decoded || !redactedStdout
      ? null
      : await writer.putEvidence(id, {
          kind: "canonical-evidence",
          bytes: Buffer.from(redactedStdout),
          mediaType: "text/plain; charset=utf-8",
          ...processEvidenceMetadata,
        });
    const stderr = redactedStderr
      ? await writer.putEvidence(id, {
          kind: "canonical-evidence",
          bytes: Buffer.from(redactedStderr),
          mediaType: "text/plain; charset=utf-8",
          ...processEvidenceMetadata,
        })
      : null;

    const artifacts = redactArtifacts(
      agentAdapter,
      withUncollectedArtifacts(observed.artifacts, prepared.snapshot.task.outputArtifacts),
      credentials,
      evidenceRedaction,
    );
    const artifactManifest = [];
    for (const artifact of artifacts) {
      const artifactEvidenceMetadata = observedEvidenceMetadata({
        capturedAt: artifact.capturedAt,
        lifecyclePhase: "seal",
        provenance: "controller_sealed_workspace_file",
        trust: "controller_sealed",
      });
      if (artifact.status === "captured") {
        const content = await writer.putEvidence(id, {
          kind: "output-artifact",
          bytes: artifact.bytes,
          mediaType: artifact.kind === "text"
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
          ...artifactEvidenceMetadata,
        });
        artifactManifest.push({
          path: artifact.path,
          kind: artifact.kind,
          maxBytes: artifact.maxBytes,
          required: artifact.required,
          status: "captured",
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          ...(artifact.textEncoding
            ? { textEncoding: artifact.textEncoding }
            : {}),
          ...artifactEvidenceMetadata,
          content,
        });
      } else {
        artifactManifest.push({
          path: artifact.path,
          kind: artifact.kind,
          maxBytes: artifact.maxBytes,
          required: artifact.required,
          status: artifact.status,
          reason: artifact.reason ?? null,
          ...artifactEvidenceMetadata,
          content: null,
        });
      }
    }

    const artifactIssues = requiredArtifactIssues(artifacts);
    const egress = await persistEgressCollections(
      writer,
      id,
      observed,
      credentials,
      prepared.snapshot.target.egress.selectedFields,
      prepared.snapshot.target.egress.exchangeFactProfiles,
      prepared.snapshot.target.egress.blockedRequests,
      prepared.snapshot.target.egress.relevantHosts,
    );
    const evaluatorArtifacts = artifacts.map((artifact) => {
      const sealed = artifactManifest.find(({ path }) => path === artifact.path);
      return {
        ...artifact,
        evidenceRef: sealed?.content?.sha256 ?? null,
      };
    });
    const operatorReason = boundedFailureReason(decoded?.operatorReason ?? null);
    const redactedOperatorReason = operatorReason
      ? redactTargetText(
          redactControllerText(agentAdapter, operatorReason),
          credentials,
          evidenceRedaction,
        )
      : null;
    // A cancelled run's process exit and transcript follow from the
    // cancellation, so report the cancellation instead of them.
    const cancelled = observed.integrityIssues.some(({ code }) => code === "environment.cancelled");
    const integrityIssues = [
      ...observed.integrityIssues.map((issue) => ({
        ...issue,
        message: redactTargetText(
          redactControllerText(agentAdapter, issue.message),
          credentials,
          evidenceRedaction,
        ),
      })),
      ...(cancelled ? [] : processIssues(observed.process, redactedOperatorReason)),
      ...artifactIssues,
      ...(cancelled ? [] : decodeIssues),
    ];
    const transcriptInvalid = !decoded
      || decodeIssues.some(({ code }) => code === "controller.transcript-invalid");
    const evaluated = transcriptInvalid || artifactIssues.length > 0
      ? { status: "blocked_by_evidence", checks: [], integrityIssues: [] }
      : await runDeterministicEvaluator({
          evaluatorPath: prepared.evaluatorPath,
          behaviorRoot: prepared.behaviorRoot,
          snapshot: prepared.snapshot,
          transcript: {
            jsonl: decoded.transcript,
            sha256: transcript.sha256,
            provenance: "controller_observed_parent_pipe",
            evidenceRef: transcript.sha256,
          },
          execution,
          artifacts: evaluatorArtifacts,
          egress: egress.evaluator,
          lifecycle: {},
        });
    integrityIssues.push(...evaluated.integrityIssues);
    const judgeSources = {
      transcript: rawJudgeTranscript,
      executionSummary: legacyExecutionSummary(
        observed.process,
        decoded,
        storedInvocation,
      ),
      workspaceArtifacts: observed.workspaceArtifacts ?? null,
      stderr: redactedStderr || null,
      artifacts,
      egress: egress.evaluator,
      lifecycle: {},
    };
    const preparedJudgeRequest = judgePhase.prepareRequest({
      plan: prepared.judgePlan,
      deterministic: base,
      sources: judgeSources,
      redactText(value) {
        return redactTargetText(
          redactControllerText(agentAdapter, value),
          credentials,
          evidenceRedaction,
        );
      },
    });
    if (preparedJudgeRequest.kind === "unavailable") {
      integrityIssues.push(judgeRequestInputUnavailableIssue());
    }
    const authorityFields = authorityRecordFields({
      snapshot: prepared.snapshot,
      checks: evaluated.checks,
      integrityIssues,
      evaluatorStatus: evaluated.status,
    });
    const evaluatorSourceEvidence = await captureEvaluatorSources();
    const completedAt = new Date().toISOString();
    const completed = deepFreeze({
      ...base,
      revision: 2,
      state: "complete",
      ...authorityFields,
      judgeStatus: "not_requested",
      judge: null,
      startedAt,
      completedAt,
      execution,
      metrics: {
        common: structuredClone(decoded?.metrics?.common ?? {}),
        adapters: {
          [agentAdapter.id]: {
            ...structuredClone(decoded?.metrics?.adapter ?? {}),
            ...observedToolVersions(observed, agentAdapter, credentials, evidenceRedaction),
          },
        },
        targets: evaluated.status === "complete"
          ? { [prepared.snapshot.target.id]: structuredClone(evaluated.targetMetrics) }
          : {},
      },
      integrityIssues,
      evidence: {
        transcript,
        stderr,
        structured: [
          ...evaluatorSourceEvidence,
          ...(rawStdout ? [rawStdout] : []),
        ],
        artifacts: artifactManifest,
        egress: egress.manifest,
      },
    });
    const stored = await writer.transition(1, completed);
    return completedAttempt({
      record: stored,
      integrityIssues,
      evaluatorStatus: evaluated.status,
      judgeSources,
      preparedJudgeRequest,
    });
  } catch (error) {
    if (!(error instanceof ExpectedExecutionError)) throw error;
    // Report the cause through the same redactor as any other evidence: a
    // spawn failure can echo an argv-borne secret back in its message.
    const failureReason = error.reason
      ? redactTargetText(
          redactControllerText(agentAdapter, error.reason),
          credentials,
          evidenceRedaction,
        )
      : null;
    const integrityIssues = [{
      code: "run.execution-failed",
      phase: "execute",
      effect: "incomplete",
      message: failureReason
        ? `Run execution failed before controller evidence could be completed: ${failureReason}`
        : "Run execution failed before controller evidence could be completed.",
    }];
    const authorityFields = authorityRecordFields({
      snapshot: prepared.snapshot,
      checks: [],
      integrityIssues,
      evaluatorStatus: "blocked_by_evidence",
    });
    const evaluatorSourceEvidence = await captureEvaluatorSources();
    const completed = deepFreeze({
      ...base,
      revision: 2,
      state: "complete",
      ...authorityFields,
      judgeStatus: "not_requested",
      judge: null,
      startedAt,
      completedAt: new Date().toISOString(),
      execution: emptyExecution(prepared.snapshot),
      metrics: { common: {}, adapters: {}, targets: {} },
      integrityIssues,
      evidence: {
        transcript: null,
        stderr: null,
        structured: evaluatorSourceEvidence,
        artifacts: [],
        egress: [],
      },
    });
    const stored = await writer.transition(1, completed);
    return completedAttempt({
      record: stored,
      integrityIssues,
      evaluatorStatus: "blocked_by_evidence",
      judgeSources: {
        transcript: null,
        executionSummary: null,
        workspaceArtifacts: null,
        stderr: null,
        artifacts: [],
        egress: [],
        lifecycle: {},
      },
    });
  }
}

const RETRYABLE_EXECUTION_ISSUE_CODES = Object.freeze([
  "environment.spawn-failed",
  "environment.timed-out",
  "environment.nonzero-exit",
]);

const BLOCKING_RETRY_ISSUE_CODES = Object.freeze([
  "environment.not-quiescent",
  "environment.dispose-failed",
]);

function fixedRetryPolicy(maxRetries) {
  return deepFreeze({
    kind: "fixed-execution-failures-v1",
    maxRetries,
    retryableIssueCodes: [...RETRYABLE_EXECUTION_ISSUE_CODES],
    blockingIssueCodes: [...BLOCKING_RETRY_ISSUE_CODES],
  });
}

function retryTrigger(integrityIssueCodes) {
  const codes = new Set(integrityIssueCodes);
  if (BLOCKING_RETRY_ISSUE_CODES.some((code) => codes.has(code))) return null;
  return RETRYABLE_EXECUTION_ISSUE_CODES.find((code) => codes.has(code)) ?? null;
}

function adapterList(agentAdapter, agentAdapters) {
  if (agentAdapter && agentAdapters !== undefined) {
    throw new TypeError("Run Engine accepts agentAdapter or agentAdapters, not both");
  }
  const adapters = agentAdapters ?? (agentAdapter ? [agentAdapter] : []);
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new TypeError("Run Engine requires at least one Agent Adapter");
  }
  const ids = new Set();
  for (const adapter of adapters) {
    if (!adapter?.id || typeof adapter.createLaunchPlan !== "function") {
      throw new TypeError("Run Engine requires an Agent Adapter");
    }
    if (ids.has(adapter.id)) {
      throw new TypeError(`Agent Adapter '${adapter.id}' is registered more than once`);
    }
    ids.add(adapter.id);
  }
  return Object.freeze([...adapters]);
}

function selectedAgents({
  adapters,
  agentSelections,
  requestedModel,
  agentSettings,
}) {
  const usingLegacy = requestedModel !== undefined || agentSettings !== undefined;
  if (agentSelections !== undefined && usingLegacy) {
    throw new RunSelectionInputError(
      "agentSelections cannot be mixed with requestedModel or agentSettings",
    );
  }
  const requested = agentSelections ?? [{
    adapterId: adapters[0].id,
    requestedModel: requestedModel ?? null,
    settings: agentSettings ?? {},
  }];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new RunSelectionInputError(
      "agentSelections must contain at least one selection",
    );
  }
  const adaptersById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const normalized = [];
  const identities = new Set();
  for (const selection of requested) {
    const adapter = adaptersById.get(selection?.adapterId);
    if (!adapter) {
      throw new RunSelectionInputError(
        `Agent Adapter '${selection?.adapterId}' is not available`,
      );
    }
    const settings = normalizedAgentSettings(
      adapter,
      selection.requestedModel ?? null,
      selection.settings ?? {},
    );
    const identity = JSON.stringify([adapter.id, settings]);
    if (identities.has(identity)) {
      throw new RunSelectionInputError(
        `Agent selection '${adapter.id}' is selected more than once`,
      );
    }
    identities.add(identity);
    normalized.push(Object.freeze({ adapter, settings }));
  }
  return Object.freeze(normalized);
}

function verdictCounts(runs) {
  const counts = { pass: 0, fail: 0, incomplete: 0, unknown: 0 };
  for (const run of runs) counts[run.verdict] += 1;
  return counts;
}

function authorityCoverage(runs) {
  const recorded = runs.filter(({ authorityProfileId }) => authorityProfileId !== null);
  const judgeRequired = runs.filter((run) => run.judgeRequired);
  const judgeCompleted = judgeRequired.filter(({ judgeOutcome }) => judgeOutcome !== null);
  const comparable = runs.filter((run) => (
    ["pass", "fail", "incomplete"].includes(run.effectiveVerdict)
    && run.judgeOutcome !== null
  ));
  const agreements = comparable.filter(
    ({ effectiveVerdict, judgeOutcome }) => effectiveVerdict === judgeOutcome,
  ).length;
  return {
    recordedRuns: recorded.length,
    totalRuns: runs.length,
    judgeCompletedRuns: judgeCompleted.length,
    judgeRequiredRuns: judgeRequired.length,
    comparableRuns: comparable.length,
    agreements,
    disagreements: comparable.length - agreements,
  };
}

function summarizeRuns({ plannedCells, plannedRepeats, runs, terminalRuns }) {
  const nonPasses = terminalRuns.filter(({ verdict }) => verdict !== "pass");
  return deepFreeze({
    plannedCells,
    plannedRepeats,
    attempts: runs.length,
    retriesPerformed: runs.length - plannedRepeats,
    terminalVerdicts: verdictCounts(terminalRuns),
    authorityCoverage: authorityCoverage(terminalRuns),
    nonPasses: nonPasses.slice(0, 10),
    omittedNonPasses: Math.max(0, nonPasses.length - 10),
  });
}

function capabilitySet(component, label) {
  const capabilities = component.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== "string")) {
    throw new TypeError(`${label} capabilities must be an array of strings`);
  }
  return new Set(capabilities);
}

function capabilityDiagnostics(
  cells,
  taskDefinitions,
  conditionDefinitions,
  environment,
  authorityByTaskId = {},
) {
  const environmentCapabilities = capabilitySet(
    environment,
    `Execution Environment '${environment.id}'`,
  );
  const diagnostics = [];
  for (const cell of cells) {
    const agentCapabilities = capabilitySet(
      cell.agent.adapter,
      `Agent Adapter '${cell.agent.adapter.id}'`,
    );
    const requirements = new Set([
      ...(taskDefinitions[cell.taskId].executionRequirements ?? []),
      ...(conditionDefinitions[cell.conditionId].executionRequirements ?? []),
    ]);
    const judgeRequirements = authorityByTaskId[cell.taskId]?.judge?.capability
      ?.requestProtocol?.requirements ?? [];
    if (judgeRequirements.includes("workspace-artifact-metadata")) {
      requirements.add("environment.workspace-artifact-metadata");
    }
    for (const capability of requirements) {
      const supported = capability.startsWith("agent.")
        ? agentCapabilities.has(capability)
        : environmentCapabilities.has(capability);
      if (supported) continue;
      diagnostics.push(deepFreeze({
        category: "capability",
        code: "matrix.capability-missing",
        message: `${cell.taskId}/${cell.conditionId}/${cell.agent.adapter.id} requires unsupported capability '${capability}'.`,
        taskId: cell.taskId,
        conditionId: cell.conditionId,
        adapterId: cell.agent.adapter.id,
        requestedModel: cell.agent.settings.requestedModel,
        environmentId: environment.id,
        capability,
      }));
    }
  }
  return Object.freeze(diagnostics);
}

function rejectedRunResult({
  category,
  code,
  message,
  repeat = 1,
  plannedCells = 0,
  details = {},
}) {
  return deepFreeze({
    status: "rejected",
    diagnostics: [{ category, code, message, ...details }],
    runs: [],
    summary: {
      plannedCells,
      plannedRepeats: plannedCells * repeat,
      attempts: 0,
    },
  });
}

function selectionRejection(error, repeat = 1) {
  return rejectedRunResult({
    category: "selection",
    code: "matrix.selection-invalid",
    message: error instanceof Error ? error.message : "Run selection is invalid.",
    repeat,
  });
}

export function createRunEngineWithWriter({
  writer,
  agentAdapter,
  agentAdapters,
  executionEnvironment,
  judge = null,
  progressObserver = null,
} = {}) {
  if (
    !writer
    || typeof writer.createQueued !== "function"
    || typeof writer.transition !== "function"
    || typeof writer.putEvidence !== "function"
  ) {
    throw new TypeError("Run Engine requires a Result Store write capability");
  }
  const adapters = adapterList(agentAdapter, agentAdapters);
  if (!executionEnvironment?.id || typeof executionEnvironment.execute !== "function") {
    throw new TypeError("Run Engine requires an Execution Environment");
  }
  const judgePhase = createJudgePhase({ writer, judge });
  const progress = normalizeExecutionProgressObserver(progressObserver);
  return Object.freeze({
    async run({
      runPlan,
      taskId,
      taskIds,
      conditionId,
      conditionIds,
      requestedModel,
      agentSettings: rawAgentSettings,
      agentSelections,
      environmentSettings: rawEnvironmentSettings = {},
      repeat = 1,
      retries = 0,
      concurrency = DEFAULT_RUN_CONCURRENCY,
      experimentVersion = null,
      credentials: runtimeCredentials = {},
      signal = null,
      judging = "task",
      authorityProfileId,
    } = {}) {
      if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) {
        return selectionRejection(
          new TypeError("repeat must be an integer between 1 and 100"),
        );
      }
      if (!Number.isSafeInteger(retries) || retries < 0 || retries > 100) {
        return selectionRejection(
          new TypeError("retries must be an integer between 0 and 100"),
          repeat,
        );
      }
      try { concurrency = normalizeRunConcurrency(concurrency); }
      catch (error) { return selectionRejection(error, repeat); }
      if (!["task", "disabled", "required"].includes(judging)) {
        return selectionRejection(
          new TypeError("judging must be task, disabled, or required"),
          repeat,
        );
      }
      if (
        signal !== null
        && (
          typeof signal !== "object"
          || typeof signal.aborted !== "boolean"
          || typeof signal.addEventListener !== "function"
        )
      ) {
        return selectionRejection(
          new TypeError("signal must be an AbortSignal"),
          repeat,
        );
      }
      if (taskId !== undefined && taskIds !== undefined) {
        return selectionRejection(
          new TypeError("taskId and taskIds cannot be combined"),
          repeat,
        );
      }
      if (conditionId !== undefined && conditionIds !== undefined) {
        return selectionRejection(
          new TypeError("conditionId and conditionIds cannot be combined"),
          repeat,
        );
      }
      const taskDefinitions = runPlan?.definition?.tasks ?? {};
      const conditionDefinitions = runPlan?.definition?.conditions ?? {};
      let selectedTaskIds;
      let selectedConditionIds;
      let normalizedAgents;
      let normalizedEnvironment;
      try {
        selectedTaskIds = selectDefinitionIds(
          taskDefinitions,
          taskIds ?? taskId,
          "Task",
        );
        selectedConditionIds = selectDefinitionIds(
          conditionDefinitions,
          conditionIds ?? conditionId,
          "Condition",
        );
        normalizedAgents = selectedAgents({
          adapters,
          agentSelections,
          requestedModel,
          agentSettings: rawAgentSettings,
        });
        normalizedEnvironment = executionEnvironment.normalizeSettings
          ? executionEnvironment.normalizeSettings(rawEnvironmentSettings)
          : deepFreeze(structuredClone(rawEnvironmentSettings));
      } catch (error) {
        if (!(error instanceof RunSelectionInputError)) throw error;
        return selectionRejection(error, repeat);
      }
      if (selectedTaskIds.length === 0 || selectedConditionIds.length === 0) {
        return selectionRejection(
          new TypeError("Run matrix must contain at least one cell"),
          repeat,
        );
      }
      const retryDiagnostics = selectedTaskIds.flatMap((selectedTaskId) => {
        const limit = taskDefinitions[selectedTaskId].maxExecutionRetries;
        if (limit === undefined || retries <= limit) return [];
        return [deepFreeze({
          category: "selection",
          code: "retry.task-limit-exceeded",
          message: `Task '${selectedTaskId}' permits at most ${limit} execution retries.`,
          taskId: selectedTaskId,
          requestedRetries: retries,
          maxExecutionRetries: limit,
        })];
      });
      if (retryDiagnostics.length > 0) {
        const plannedCells = selectedTaskIds.length
          * selectedConditionIds.length
          * normalizedAgents.length;
        return deepFreeze({
          status: "rejected",
          diagnostics: retryDiagnostics,
          runs: [],
          summary: {
            plannedCells,
            plannedRepeats: plannedCells * repeat,
            attempts: 0,
          },
        });
      }
      const authoritySelections = resolveAuthoritySelections({
        definition: runPlan.definition,
        selectedTaskIds,
        authorityProfileId,
        legacyJudging: judging,
        judgeCapability: judgePhase.capability,
      });
      if (!authoritySelections.ok) {
        const plannedCells = selectedTaskIds.length
          * selectedConditionIds.length
          * normalizedAgents.length;
        return deepFreeze({
          status: "rejected",
          diagnostics: authoritySelections.diagnostics,
          runs: [],
          summary: {
            plannedCells,
            plannedRepeats: plannedCells * repeat,
            attempts: 0,
          },
        });
      }
      if (
        !runtimeCredentials
        || typeof runtimeCredentials !== "object"
        || Array.isArray(runtimeCredentials)
      ) {
        return selectionRejection(new RunSelectionInputError("credentials must be an object"), repeat);
      }
      const selectedCredentialsByTask = {};
      const credentialDiagnostics = [];
      for (const selectedTaskId of selectedTaskIds) {
        const selected = {};
        for (const name of taskDefinitions[selectedTaskId].credentialRequirements) {
          const value = runtimeCredentials[name];
          if (typeof value !== "string" || !value.trim()) {
            credentialDiagnostics.push(deepFreeze({
              category: "capability",
              code: "credential.missing",
              message: `Task '${selectedTaskId}' requires credential '${name}'.`,
              taskId: selectedTaskId,
            }));
          } else {
            selected[name] = value;
          }
        }
        selectedCredentialsByTask[selectedTaskId] = deepFreeze(selected);
      }
      if (credentialDiagnostics.length > 0) {
        return deepFreeze({
          status: "rejected",
          diagnostics: credentialDiagnostics,
          runs: [],
          summary: {
            plannedCells: selectedTaskIds.length
              * selectedConditionIds.length
              * normalizedAgents.length,
            plannedRepeats: selectedTaskIds.length
              * selectedConditionIds.length
              * normalizedAgents.length
              * repeat,
            attempts: 0,
          },
        });
      }
      const cells = selectedTaskIds.flatMap((selectedTaskId) => (
        selectedConditionIds.flatMap((selectedConditionId) => (
          normalizedAgents.map((agent) => ({
            taskId: selectedTaskId,
            conditionId: selectedConditionId,
            agent,
          }))
        ))
      ));
      const compatibilityDiagnostics = capabilityDiagnostics(
        cells,
        taskDefinitions,
        conditionDefinitions,
        executionEnvironment,
        authoritySelections.value.byTaskId,
      );
      const captureDiagnostics = captureCompatibilityDiagnostics({
        targetDefinition: runPlan?.definition?.target,
        taskDefinitions,
        conditionDefinitions,
        cells,
        environment: executionEnvironment,
      });
      if (
        compatibilityDiagnostics.length > 0
        || captureDiagnostics.length > 0
      ) {
        return deepFreeze({
          status: "rejected",
          diagnostics: [
            ...compatibilityDiagnostics,
            ...captureDiagnostics,
          ],
          runs: [],
          summary: {
            plannedCells: cells.length,
            plannedRepeats: cells.length * repeat,
            attempts: 0,
          },
        });
      }
      const pinRoot = await mkdtemp(join(tmpdir(), "hurdle-run-definition-"));
      try {
        const preparedCells = [];
        const preparationDiagnostics = [];
        const preparedFingerprints = new Set();
        for (const [index, cell] of cells.entries()) {
          try {
            const preparedDefinition = await prepareRunDefinition({
                runPlan,
                taskId: cell.taskId,
                conditionId: cell.conditionId,
                adapterId: cell.agent.adapter.id,
                agentSettings: cell.agent.settings,
                environmentId: executionEnvironment.id,
                environmentSettings: normalizedEnvironment,
                pinRoot: join(pinRoot, `cell-${index}`),
                resolvedAuthority: authoritySelections.value.byTaskId[cell.taskId],
              });
            let launchPlan = null;
            if (
              taskDefinitions[cell.taskId].credentialRequirements.length > 0
            ) {
              try {
                launchPlan = await cell.agent.adapter.createLaunchPlan({
                  prompt: taskDefinitions[cell.taskId].prompt,
                  snapshot: preparedDefinition.snapshot,
                  requestedModel: cell.agent.settings.requestedModel,
                  settings: cell.agent.settings.settings,
                  resources: preparedDefinition.pinnedResources,
                });
              } catch {
                throw new LaunchPlanInputError(
                  "agent.launch-plan-unavailable",
                  "Agent Adapter could not prepare the selected credential-bearing cell.",
                );
              }
              assertValidLaunchPlan(launchPlan);
              launchPlan = bindLaunchPlan(
                launchPlan,
                preparedDefinition,
                selectedCredentialsByTask[cell.taskId],
              );
            }
            const prepared = deepFreeze({
              ...preparedDefinition,
              agent: cell.agent,
              launchPlan,
              judgePlan: judgePhase.select(preparedDefinition.snapshot),
            });
            if (preparedFingerprints.has(prepared.snapshotFingerprint)) {
              preparationDiagnostics.push(deepFreeze({
                category: "selection",
                code: "matrix.duplicate-cell",
                message: `${cell.taskId}/${cell.conditionId}/${cell.agent.adapter.id} resolves to a duplicate Run Definition Snapshot.`,
                taskId: cell.taskId,
                conditionId: cell.conditionId,
                adapterId: cell.agent.adapter.id,
                requestedModel: cell.agent.settings.requestedModel,
                environmentId: executionEnvironment.id,
              }));
            } else {
              preparedFingerprints.add(prepared.snapshotFingerprint);
              preparedCells.push(prepared);
            }
          } catch (error) {
            if (
              !(error instanceof RunDefinitionInputError)
              && !(error instanceof LaunchPlanInputError)
              && !(error instanceof JudgeSelectionInputError)
            ) throw error;
            preparationDiagnostics.push(deepFreeze({
              category: "preparation",
              code: error instanceof LaunchPlanInputError
                || error instanceof JudgeSelectionInputError
                ? error.code
                : "matrix.definition-preparation-failed",
              message: error instanceof Error
                ? error.message
                : "Run definition preparation failed.",
              taskId: cell.taskId,
              conditionId: cell.conditionId,
              adapterId: cell.agent.adapter.id,
              requestedModel: cell.agent.settings.requestedModel,
              environmentId: executionEnvironment.id,
            }));
          }
        }
        if (preparationDiagnostics.length > 0) {
          return deepFreeze({
            status: "rejected",
            diagnostics: preparationDiagnostics,
            runs: [],
            summary: {
              plannedCells: cells.length,
              plannedRepeats: cells.length * repeat,
              attempts: 0,
            },
          });
        }
        const groupId = `group_${randomUUID()}`;
        const total = preparedCells.length * repeat;
        reportExecutionProgress(progress, { kind: "matrix-ready", total });
        const retryPolicy = fixedRetryPolicy(retries);
        const jobs = preparedCells.flatMap((prepared, index) => Array.from({ length: repeat }, (_, repeatIndex) => ({
          prepared, repeatIndex, ordinal: index * repeat + repeatIndex + 1,
        })));
        const results = await mapConcurrentRunCells(jobs, { concurrency, signal }, async ({ prepared, repeatIndex, ordinal }, cellSignal) => {
          const task = runPlan.definition.tasks[prepared.snapshot.task.id];
          const attemptRuns = [];
          const progressCell = {
            ordinal,
            total,
            taskId: prepared.snapshot.task.id,
            conditionId: prepared.snapshot.condition.id,
            adapterId: prepared.agent.adapter.id,
            repeatOrdinal: repeatIndex + 1,
            repeatTotal: repeat,
          };
          reportExecutionProgress(progress, {
            kind: "cell-started",
            cell: progressCell,
          });
          let rootRunId = null;
          let retryOf = null;
          let trigger = null;
          let terminal = null;
          let terminalAttempt = null;
          for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
            const completed = await runOne({
              writer,
              judgePhase,
              prepared,
              task,
              agentAdapter: prepared.agent.adapter,
              executionEnvironment,
              agentSettings: prepared.agent.settings,
              experimentVersion,
              invocation: {
                groupId,
                ordinal,
                total,
                repeatOrdinal: repeatIndex + 1,
                repeatTotal: repeat,
                retryPolicy,
                attemptOrdinal: attemptIndex + 1,
                rootRunId,
                retryOf,
                retryTrigger: trigger,
              },
              credentials: selectedCredentialsByTask[prepared.snapshot.task.id],
              signal: cellSignal,
              onExecutionStarted(executionId) {
                reportExecutionProgress(progress, { kind: "cell-attempt-started", cell: progressCell, executionId });
              },
            });
            terminalAttempt = completed;
            terminal = completed.reference;
            attemptRuns.push(terminal);
            rootRunId ??= terminal.id;
            if (cellSignal.aborted || attemptIndex >= retries) break;
            trigger = retryTrigger(completed.integrityIssueCodes);
            if (!trigger) break;
            retryOf = terminal.id;
          }
          const selectedCredentials = selectedCredentialsByTask[
            prepared.snapshot.task.id
          ];
          reportExecutionProgress(progress, { kind: "cell-finalizing", cell: progressCell });
          const settled = await judgePhase.settle({
            plan: prepared.judgePlan,
            deterministic: terminalAttempt.record,
            evaluatorStatus: terminalAttempt.evaluatorStatus,
            sources: terminalAttempt.judgeSources,
            preparedRequest: terminalAttempt.preparedJudgeRequest,
            redactText(value) {
              return redactTargetText(
                redactControllerText(prepared.agent.adapter, value),
                selectedCredentials,
                prepared.snapshot.task.evidenceRedaction,
              );
            },
            signal: cellSignal,
          });
          terminal = runReference(settled);
          attemptRuns[attemptRuns.length - 1] = terminal;
          reportExecutionProgress(progress, {
            kind: "cell-completed",
            cell: progressCell,
            terminal: { ...terminal, checks: settled.checks },
          });
          return { runs: attemptRuns, terminal };
        });
        const runs = results.flatMap(result => result.runs);
        const terminalRuns = results.map(result => result.terminal);
        return deepFreeze({
          status: "complete",
          groupId,
          diagnostics: [],
          runs,
          summary: summarizeRuns({
            plannedCells: preparedCells.length,
            plannedRepeats: total,
            runs,
            terminalRuns,
          }),
        });
      } finally {
        await rm(pinRoot, { recursive: true, force: true });
      }
    },
  });
}

export function createRunEngine({
  resultStore,
  agentAdapter,
  agentAdapters,
  executionEnvironment,
  judge = null,
  progressObserver = null,
} = {}) {
  return composeResultStoreRunEngine(
    resultStore,
    {
      agentAdapter,
      agentAdapters,
      executionEnvironment,
      judge,
      progressObserver,
    },
  );
}
