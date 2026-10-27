import "server-only";
import { getCanonicalDashboardSource } from "./canonical-dashboard-results.server";
import type { CanonicalDashboardRuntime } from "./canonical-dashboard-projection.mjs";

export type EvalVersionOption = {
  id: string;
  name: string;
  description: string | null;
  kind?: "weekly" | "experiment" | "smoke" | null;
  runAt?: string | null;
  createdAt?: string | null;
  model?: string | null;
  ccVersion?: string | null;
};

export type ComparableEvalVersion = EvalVersionOption & {
  sessionCount: number;
};

type VersionIdentity = {
  id: string;
  name?: string | null;
  kind?: string | null;
  runAt?: string | Date | null;
  createdAt?: string | Date | null;
};

export function isWeeklyEvalVersion(version: VersionIdentity): boolean {
  if (version.kind) return version.kind === "weekly";
  return /^\d{4}-\d{2}-\d{2}$/.test(version.id) || /weekly/i.test(`${version.id} ${version.name ?? ""}`);
}

function compareVersionsNewestFirst(a: VersionIdentity, b: VersionIdentity): number {
  const aValue = a.runAt ?? a.createdAt;
  const bValue = b.runAt ?? b.createdAt;
  const aTime = aValue instanceof Date ? aValue.getTime() : Date.parse(aValue ?? "");
  const bTime = bValue instanceof Date ? bValue.getTime() : Date.parse(bValue ?? "");
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(bTime) ? 1 : -1;
  return b.id.localeCompare(a.id);
}

export function getDefaultEvalVersionId(versions: VersionIdentity[]): string | null {
  const newestFirst = [...versions].sort(compareVersionsNewestFirst);
  return newestFirst[0]?.id ?? null;
}


export type SessionSummary = {
  id: string;
  createdAt: Date;
  version: string;
  run: string;
  agent: string;
  agentName: string;
  configId: string;
  configLabel: string;
  configFull: string;
  configDir: string;
  model: string;                // alias identity: "opus" | "sonnet" | "gpt-5.5" | "" (legacy)
  modelResolved: string | null; // concrete version, e.g. "claude-opus-4-7"
  runtime?: CanonicalDashboardRuntime | null;
  task: string;
  taskName: string;
  durationSec: number;
  // Stored canonical Decision; never recomputed from the Judge or process exit.
  passed: boolean | null;
  result: string | null;
  rawResult?: string | null;    // compatibility shape for the read-only presentation
  auditVerdict: string | null;  // separately stored Judge verdict
  manualOverride?: { reason: string } | null;
  toolCalls: number | null;
  totalTokens: number | null;
  tokenUsage: import("@/lib/session-usage.mjs").TokenUsage | null;
  costUsd: number | null;
  costSource?: "reported" | "estimated" | "unavailable";
  mcpCalls: number;
  skillInjections: number;
  injectedSkills: string[];
  mcpMethods: string[];
  toolVersions?: unknown;
  failureAnalysis?: unknown;
  failureReview?: unknown;
  note: string | null;
  prompt: string;
  gradingCriteria: string | null;
  needsFollowup: boolean;
  followupReason: string | null;
  docsCandidateCount?: number;
  docsCandidateStatuses?: string[];
  sourceKind?: "canonical" | "legacy";
  canonicalRunId?: string;
  snapshotFingerprint?: string;
};

export type SessionDetail = SessionSummary & {
  sessionJsonl: string | null;
  gradingCriteria: string | null;
  findings: string | null;
  skills: unknown;
  mcpEnabled: boolean;
  agentVersion: string | null;
  sandboxId: string | null;
  claudeSessionId: string | null;
  resultsPath: string | null;
  audit: unknown;
  deepAudit: unknown;
  togetherRequests: unknown;
  togetherRequestsTruncated?: boolean;
  toolVersions: unknown;
  failureAnalysis: unknown;
  failureReview: unknown;
  docsCandidates: never[];
  createdAt: Date;
  readOnly?: boolean;
  storedChecks?: unknown[];
  deterministicEffectiveVerdict?: string | null;
};


async function projection() {
  const source = await getCanonicalDashboardSource();
  return source.status === "ready" ? source.projection : null;
}

export async function getAllSessions(versionId: string): Promise<SessionSummary[]> {
  return await (await projection())?.listSessions(versionId) as SessionSummary[] ?? [];
}

export async function getSessionById(id: string): Promise<SessionDetail | null> {
  if (!id.startsWith("canonical--")) return null;
  return await (await projection())?.findSession(id) as SessionDetail | null ?? null;
}

export async function getTaskFindings(versionId: string) {
  const sessions = await getAllSessions(versionId);
  return [...new Map(sessions.map(session => [session.task, {
    slug: session.task, name: session.taskName, prompt: session.prompt, findings: null,
  }])).values()];
}

export async function getVersions(): Promise<EvalVersionOption[]> {
  return [...await (await projection())?.listVersions() ?? []] as EvalVersionOption[];
}

// Do not infer comparable cohorts from new-framework timestamps.
export async function getPreviousComparableVersion(_versionId: string): Promise<ComparableEvalVersion | null> {
  return null;
}
