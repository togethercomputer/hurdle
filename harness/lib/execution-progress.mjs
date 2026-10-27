import { stripVTControlCharacters } from "node:util";

const VERDICTS = new Set(["pass", "fail", "incomplete", "unknown"]);
const RESOURCE_ROLES = new Set(["guardian", "agent"]);
const CHECK_OUTCOMES = new Set(["pass", "fail", "skip"]);
const CHECK_AUTHORITIES = new Set(["required", "advisory", "disabled"]);
// Same bound as the Judge projection; the terminal reports any remainder as a count.
const MAX_PROGRESS_CHECKS = 128;

export const ENVIRONMENT_STATUS_LABELS = Object.freeze({
  "starting-guardian": "Starting Guardian",
  "guardian-started": "Guardian started",
  "starting-sandbox": "Starting sandbox",
  "sandbox-started": "Sandbox started",
  "preparing-environment": "Preparing environment",
  "preparing-workspace": "Preparing workspace",
  "agent-running": "Agent running",
  "collecting-results": "Collecting results",
  "stopping-sandboxes": "Stopping sandboxes",
});

function terminalSummary(value) {
  const summary = stripVTControlCharacters(value.slice(0, 16 * 1024))
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  return summary.length > 300 ? `${summary.slice(0, 299)}…` : summary;
}

// Presentation only: callers supply already-redacted stored verdict reasons,
// never provider exceptions, stderr or credentials. Keep terminal output small.
export function projectVerdictReasons(value) {
  const reasons = [];
  const seen = new Set();
  for (const reason of Array.isArray(value) ? value.slice(0, 100) : []) {
    if (!reason || typeof reason.code !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(reason.code)
      || typeof reason.summary !== "string") continue;
    const summary = terminalSummary(reason.summary);
    if (!summary) continue;
    const key = `${reason.code}:${summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push(Object.freeze({ code: reason.code, summary }));
    if (reasons.length === 3) break;
  }
  return Object.freeze(reasons);
}

// Presentation only: callers supply the stored, authority-resolved checks of a
// terminal Run. Evidence references and details stay in the Result Store.
// Projecting an already projected list is lossless, as observers re-report events.
function projectChecks(value, omitted) {
  const omittedCheckCount = Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0;
  if (!Array.isArray(value)) return { checks: Object.freeze([]), omittedCheckCount };
  const checks = [];
  const ids = new Set();
  for (const check of value.slice(0, MAX_PROGRESS_CHECKS)) {
    if (!check || typeof check.id !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(check.id)
      || ids.has(check.id) || !CHECK_OUTCOMES.has(check.outcome)
      || !CHECK_AUTHORITIES.has(check.effectiveAuthority) || typeof check.summary !== "string") continue;
    ids.add(check.id);
    checks.push(Object.freeze({
      id: check.id,
      outcome: check.outcome,
      effectiveAuthority: check.effectiveAuthority,
      summary: terminalSummary(check.summary),
    }));
  }
  return {
    checks: Object.freeze(checks),
    omittedCheckCount: omittedCheckCount + value.length - checks.length,
  };
}

function boundedText(value, maximum = 256) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function projectCell(value) {
  if (
    !value
    || typeof value !== "object"
    || !positiveInteger(value.ordinal)
    || !positiveInteger(value.total)
    || value.ordinal > value.total
    || !boundedText(value.taskId)
    || !boundedText(value.conditionId)
    || !boundedText(value.adapterId)
    || !positiveInteger(value.repeatOrdinal)
    || !positiveInteger(value.repeatTotal)
    || value.repeatOrdinal > value.repeatTotal
  ) return null;
  return Object.freeze({
    ordinal: value.ordinal,
    total: value.total,
    taskId: value.taskId,
    conditionId: value.conditionId,
    adapterId: value.adapterId,
    repeatOrdinal: value.repeatOrdinal,
    repeatTotal: value.repeatTotal,
  });
}

function projectEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "matrix-ready" && positiveInteger(value.total)) {
    return Object.freeze({ kind: value.kind, total: value.total });
  }
  if (["cell-started", "cell-finalizing"].includes(value.kind)) {
    const cell = projectCell(value.cell);
    return cell ? Object.freeze({ kind: value.kind, cell }) : null;
  }
  if (value.kind === "cell-attempt-started") {
    const cell = projectCell(value.cell);
    return cell && boundedText(value.executionId)
      ? Object.freeze({ kind: value.kind, cell, executionId: value.executionId }) : null;
  }
  if (value.kind === "environment-status") {
    if (value.environmentId !== "together"
      || !boundedText(value.executionId)
      || typeof value.status !== "string"
      || !Object.hasOwn(ENVIRONMENT_STATUS_LABELS, value.status)) return null;
    return Object.freeze({ kind: value.kind, executionId: value.executionId,
      environmentId: value.environmentId, status: value.status });
  }
  if (value.kind === "environment-resource-allocated") {
    const resource = value.resource;
    if (
      value.environmentId !== "together"
      || !boundedText(value.executionId)
      || !resource
      || typeof resource !== "object"
      || resource.provider !== value.environmentId
      || !RESOURCE_ROLES.has(resource.role)
      || !boundedText(resource.id)
    ) return null;
    return Object.freeze({
      kind: value.kind,
      executionId: value.executionId,
      environmentId: value.environmentId,
      resource: Object.freeze({
        provider: resource.provider,
        role: resource.role,
        id: resource.id,
      }),
    });
  }
  if (value.kind === "cell-completed") {
    const cell = projectCell(value.cell);
    const terminal = value.terminal;
    if (
      !cell
      || !terminal
      || typeof terminal !== "object"
      || !boundedText(terminal.id)
      || !VERDICTS.has(terminal.verdict)
    ) return null;
    const runTrustReasons = terminal.verdict === "pass"
      ? Object.freeze([])
      : projectVerdictReasons(terminal.runTrustReasons);
    const { checks, omittedCheckCount } = projectChecks(terminal.checks, terminal.omittedCheckCount);
    return Object.freeze({
      kind: value.kind,
      cell,
      terminal: Object.freeze({
        id: terminal.id, verdict: terminal.verdict,
        verdictReasons: terminal.verdict === "pass" ? Object.freeze([]) : projectVerdictReasons(terminal.verdictReasons),
        ...(runTrustReasons.length > 0 ? { runTrustReasons } : {}),
        ...(checks.length > 0 ? { checks } : {}),
        ...(omittedCheckCount > 0 ? { omittedCheckCount } : {}),
      }),
    });
  }
  return null;
}

export function normalizeExecutionProgressObserver(observer = null) {
  if (observer === null || observer === undefined) return null;
  if (
    typeof observer !== "object"
    || Array.isArray(observer)
    || typeof observer.observe !== "function"
  ) {
    throw new TypeError("Execution progress observer must expose observe(event)");
  }
  return Object.freeze({ observe: observer.observe.bind(observer) });
}

export function reportExecutionProgress(observer, candidateEvent) {
  if (!observer) return false;
  const event = projectEvent(candidateEvent);
  if (!event) return false;
  try {
    const result = observer.observe(event);
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {}
  return true;
}
