import { RunCost } from "@/components/RunCost";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Package, Terminal } from "lucide-react";
import { TopBar, type Crumb } from "@/components/shell/TopBar";
import { MetaDot, PageHeader } from "@/components/shell/PageHeader";
import { AgentLogo, type AgentCode } from "@/components/AgentLogo";
import { TogetherRequestsCard } from "@/components/TogetherRequestsCard";
import { SessionDetailTabs } from "@/components/SessionDetailTabs";
import { SessionReviewSummary } from "@/components/SessionReviewSummary";
import { parseSessionFromJsonl, formatDuration, type ParsedMessage } from "@/lib/sessions";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { AgentTokens, TokensDisplay } from "@/components/TokensDisplay";
import { ConversationView } from "@/components/ConversationView";
import { ResizableSessionShell } from "@/components/ResizableSessionShell";
import { readSidebarLayout } from "@/lib/browser-layout-storage";
import { ScrollToTop } from "@/components/ScrollToTop";
import { ScrollToHash } from "@/components/ScrollToHash";
import { CopyButton } from "@/components/ui/CopyButton";
import { getSessionById, getAllSessions, getVersions, type SessionSummary } from "@/lib/queries";
import { formatModel } from "@/lib/utils";
import { evalVersionDisplayNameById } from "@/lib/version-display";
import { StatusBadge, statusFromResult } from "@/components/ui/StatusBadge";
import {
  CanonicalSessionReview,
  type CanonicalJudgeReview,
  type CanonicalStoredCheck,
} from "@/components/CanonicalSessionReview";
import type { EvaluatorSourceSummary } from "@/components/canonical/EvaluatorSourceDrawer";

export const dynamic = "force-dynamic";

function serializeTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return "";
}

type ToolVersionItem = {
  key: string;
  label: string;
  value: string;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function canonicalStoredChecks(value: unknown): CanonicalStoredCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const check = entry as Record<string, unknown>;
    const id = readString(check.id);
    const summary = readString(check.summary);
    const outcome = readString(check.outcome);
    if (!id || !summary || !["pass", "fail", "skip"].includes(outcome ?? "")) return [];
    return [{
      id,
      summary,
      outcome: outcome as CanonicalStoredCheck["outcome"],
      authoredAuthority: readString(check.authoredAuthority),
      effectiveAuthority: readString(check.effectiveAuthority),
      evidenceRefs: Array.isArray(check.evidenceRefs)
        ? check.evidenceRefs.filter((reference): reference is string => typeof reference === "string")
        : [],
    }];
  });
}

function canonicalJudgeReview(value: unknown): CanonicalJudgeReview | null {
  if (!value || typeof value !== "object") return null;
  const judge = value as Record<string, unknown>;
  const verdict = readString(judge.verdict);
  if (!verdict) return null;
  return {
    verdict,
    summary: readString(judge.summary),
    judgeId: readString(judge.judgeId),
    model: readString(judge.model),
  };
}

function canonicalEvaluatorSources(value: unknown): EvaluatorSourceSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Record<string, unknown>;
    const path = readString(source.path);
    const sha256 = readString(source.sha256);
    if (
      !path
      || !sha256
      || typeof source.sizeBytes !== "number"
      || !Number.isSafeInteger(source.sizeBytes)
      || source.sizeBytes < 0
      || typeof source.entry !== "boolean"
    ) {
      return [];
    }
    return [{ path, sha256, sizeBytes: source.sizeBytes, entry: source.entry }];
  });
}

function canonicalDeterministicOverall(value: unknown) {
  if (value === "pass") return "consistent" as const;
  if (value === "fail") return "violated" as const;
  if (value === "incomplete" || value === "unknown") return "insufficient_evidence" as const;
  return null;
}

function formatRequestedResolved(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const requested = readString(record.requested);
  const resolved = readString(record.resolved);
  if (requested && resolved && requested !== resolved) return `${resolved} (requested ${requested})`;
  return resolved || requested;
}

function ModelDetails({ requested, observed }: { requested: string | null; observed: string | null }) {
  const requestedModel = readString(requested);
  const observedModel = readString(observed);
  const model = observedModel || requestedModel;
  if (!model) return <span className="text-fg-muted">Not recorded</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-mono break-all">{model}</span>
      {!observedModel ? (
        <span className="text-xs text-fg-muted">requested</span>
      ) : requestedModel && requestedModel !== observedModel ? (
        <span className="text-xs text-fg-muted">requested <span className="font-mono break-all">{requestedModel}</span></span>
      ) : null}
    </span>
  );
}

function toolVersionItems(raw: unknown, agentName: string): ToolVersionItem[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const items: ToolVersionItem[] = [];
  const runner = readString(record.runner);
  if (runner) items.push({ key: "runner", label: agentName || "Agent CLI", value: runner });
  for (const [key, label] of [["node", "Node"], ["python", "Python"], ["pip", "pip"]]) {
    const value = readString(record[key]);
    if (value) items.push({ key, label, value });
  }

  const cli = formatRequestedResolved(record.cli);
  if (cli) items.push({ key: "cli", label: "CLI", value: cli });

  const sdk = formatRequestedResolved(record.sdk);
  if (sdk) items.push({ key: "sdk", label: "SDK", value: sdk });

  const opencode = formatRequestedResolved(record.opencode);
  if (opencode) items.push({ key: "opencode", label: "OpenCode", value: opencode });

  if (record.docs && typeof record.docs === "object") {
    const docs = record.docs as Record<string, unknown>;
    const docsValue = readString(docs.fingerprint) || readString(docs.label) || readString(docs.capturedAt);
    if (docsValue) items.push({ key: "docs", label: "Docs", value: docsValue });
  }

  return items;
}

function ToolVersionIcon({ tool, agent }: { tool: string; agent: string }) {
  if (tool === "runner") {
    if (["CC", "CDX", "OC", "Pi"].includes(agent)) {
      return <AgentLogo agent={agent as AgentCode} className="h-3.5 w-3.5" />;
    }
    return <Terminal aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />;
  }
  if (tool === "node" || tool === "python") {
    return <img src={`/${tool}-logo.svg`} alt="" width={14} height={14} className="h-3.5 w-3.5 shrink-0" />;
  }
  if (tool === "pip") return <Package aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />;
  return null;
}

function ToolVersionBadges({ items, agent }: { items: ToolVersionItem[]; agent: string }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item.key} className="inline-flex items-center gap-1.5 rounded-sm border border-rule bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted">
          <ToolVersionIcon tool={item.key} agent={agent} />
          <span className="font-medium text-foreground">{item.label}</span>
          <span className="font-mono">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

function ExecutionDetails({ runtime }: { runtime: SessionSummary["runtime"] }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        {runtime?.provider === "together" && (
          // Show only the three-circle mark from the existing Together asset.
          <span aria-hidden="true" className="inline-flex h-3.5 w-[0.94rem] shrink-0 overflow-hidden">
            <img src="/together-logo.png" alt="" className="block h-full w-auto max-w-none" />
          </span>
        )}
        {runtime?.label ?? "Not recorded"}
      </span>
      {runtime?.template && <span className="font-mono text-xs text-fg-muted break-all">{runtime.template}</span>}
    </span>
  );
}

const AGENT_NAME: Record<string, string> = { CC: "Claude Code", CDX: "Codex", OC: "OpenCode", Pi: "Pi" };

function agentCode(agent: string): AgentCode {
  return (["CC", "CDX", "OC", "Pi"].includes(agent) ? agent : "CC") as AgentCode;
}

function runLabel(run: string | null | undefined): string | null {
  return run ? `Run ${run.replace(/^run/i, "")}` : null;
}

function PagerButton({ href, label, direction }: { href?: string; label: string; direction: "prev" | "next" }) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  const className = "inline-flex h-7 w-7 items-center justify-center rounded-md border border-rule text-fg-muted";
  if (!href) {
    return <span aria-hidden className={`${className} opacity-40`}><Icon className="h-3.5 w-3.5" /></span>;
  }
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className={`${className} bg-background transition-colors duration-150 hover:border-foreground/25 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

// Previous and next runs of the same task, in the order the task's tables use.
function RunPager({ index, total, prev, next }: {
  index: number;
  total: number;
  prev: { href: string; label: string } | null;
  next: { href: string; label: string } | null;
}) {
  if (total <= 1 || index < 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="mr-1 text-[12px] tabular-nums text-fg-muted">{index + 1} / {total}</span>
      <PagerButton direction="prev" href={prev?.href} label={prev ? `Previous run: ${prev.label}` : "No previous run"} />
      <PagerButton direction="next" href={next?.href} label={next ? `Next run: ${next.label}` : "No next run"} />
    </div>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const run = await getSessionById(decodeURIComponent(id)).catch(() => null);
  if (!run) return { title: "Run" };
  return { title: [run.configFull, runLabel(run.run), run.task].filter(Boolean).join(" · ") };
}
export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const cookieStore = await cookies();
  const sidebarLayout = readSidebarLayout({ getItem: key => cookieStore.get(key)?.value ?? null });
  const dbSession = await getSessionById(id);
  if (!dbSession) notFound();
  const toolVersions = toolVersionItems(dbSession.toolVersions, dbSession.agentName);

  const statusKind = statusFromResult(dbSession.result, dbSession.passed);
  const dbSessionRecord = dbSession as Record<string, unknown>;
  const rawTogetherRequests = dbSessionRecord.togetherRequests;
  const togetherRequests = Array.isArray(rawTogetherRequests)
    ? (rawTogetherRequests.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>)
    : [];
  const togetherRequestsTruncated = dbSessionRecord.togetherRequestsTruncated === true;
  // Shared frame: breadcrumbs, version chip, pager and page header.
  const [versions, allSessions] = await Promise.all([
    getVersions().catch(() => []),
    getAllSessions(dbSession.version),
  ]);
  const versionLabel = evalVersionDisplayNameById(versions, dbSession.version) || undefined;
  const versionQuery = `?v=${encodeURIComponent(dbSession.version)}`;
  const agent = agentCode(dbSession.agent);
  const agentName = AGENT_NAME[dbSession.agent] ?? dbSession.agent;
  const thisRun = runLabel(dbSession.run);
  const modelLabel = formatModel(dbSession.model, dbSession.modelResolved);
  const crumbs: Crumb[] = [
    { label: "Leaderboard", href: `/${versionQuery}` },
    { label: dbSession.task, href: `/t/${encodeURIComponent(dbSession.task)}${versionQuery}` },
    { label: [dbSession.configFull, thisRun].filter(Boolean).join(" · ") },
  ];

  // Prev / next within the same task.
  const sameTask = allSessions
    .filter((s) => s.task === dbSession.task)
    .sort((a, b) => {
      const configCmp = a.configId.localeCompare(b.configId);
      if (configCmp !== 0) return configCmp;
      return (a.run || "").localeCompare(b.run || "");
    });
  const currentIdx = sameTask.findIndex((s) => s.id === id);
  const prevSession = currentIdx > 0 ? sameTask[currentIdx - 1] : null;
  const nextSession = currentIdx >= 0 && currentIdx < sameTask.length - 1 ? sameTask[currentIdx + 1] : null;
  const prevSessionAction = prevSession
    ? {
      href: `/s/${prevSession.id}`,
      label: prevSession.configDir + (prevSession.run ? ` / ${prevSession.run}` : ""),
    }
    : null;
  const nextSessionAction = nextSession
    ? {
      href: `/s/${nextSession.id}`,
      label: nextSession.configDir + (nextSession.run ? ` / ${nextSession.run}` : ""),
    }
    : null;

  const topBar = (
    <TopBar
      crumbs={crumbs}
      versionLabel={versionLabel}
      right={<RunPager index={currentIdx} total={sameTask.length} prev={prevSessionAction} next={nextSessionAction} />}
    />
  );
  const pageHeader = (
    <PageHeader
      className="mb-8"
      title={dbSession.configFull}
      meta={(
        <>
          <span>{dbSession.task}</span>
          {thisRun && <><MetaDot /><span>{thisRun}</span></>}
          <MetaDot />
          <span className="inline-flex items-center gap-1.5"><AgentLogo agent={agent} className="h-3.5 w-3.5" />{agentName}</span>
          {modelLabel && <><MetaDot /><span>{modelLabel}</span></>}
        </>
      )}
    />
  );

  // Completed sessions without JSONL — minimal placeholder.
  if (!dbSession.sessionJsonl) {
    return (
      <div className="h-full overflow-y-auto bg-background text-foreground">
        {topBar}
        <div className="px-4 pb-16 pt-8 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-7xl">
            {pageHeader}
            <div className="rounded-lg border border-rule p-5 space-y-3 bg-background">
              <div className="flex items-center gap-2">
                <StatusBadge kind={statusKind} size="md" />
              </div>
              <div className="text-sm"><span className="text-fg-muted mr-2">Execution:</span><ExecutionDetails runtime={dbSession.runtime} /></div>
              <div className="text-sm"><span className="text-fg-muted mr-2">Model:</span><ModelDetails requested={dbSession.model} observed={dbSession.modelResolved} /></div>
              {dbSession.durationSec > 0 && <p className="text-sm text-fg-muted">Duration: {formatDuration(dbSession.durationSec)}</p>}
              {dbSession.toolCalls != null && <p className="text-sm text-fg-muted">Tool calls: {dbSession.toolCalls}</p>}
              <p className="text-sm text-fg-muted">Agent cost: <RunCost value={dbSession.costUsd} source={dbSession.costSource} /></p>
              <ToolVersionBadges items={toolVersions} agent={dbSession.agent} />
              {dbSession.note && <p className="max-w-[75ch] text-sm text-fg-muted">{dbSession.note}</p>}
              <CanonicalSessionReview prompt={dbSession.prompt} checks={canonicalStoredChecks(dbSessionRecord.storedChecks)} judge={canonicalJudgeReview(dbSessionRecord.deepAudit)} runId={readString(dbSessionRecord.canonicalRunId)} evaluatorSources={canonicalEvaluatorSources(dbSessionRecord.evaluatorSources)} />
              {togetherRequests.length > 0 && (
                <TogetherRequestsCard
                  requests={togetherRequests as Parameters<typeof TogetherRequestsCard>[0]["requests"]}
                  truncated={togetherRequestsTruncated}
                />
              )}
              <p className="text-xs text-fg-faint pt-2">Session JSONL not available — conversation view requires the full session log.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const session = parseSessionFromJsonl(dbSession.sessionJsonl, {
    id: dbSession.id,
    version: dbSession.version,
    run: dbSession.run,
    task: dbSession.task,
    agent: dbSession.agent,
    configId: dbSession.configId,
    configLabel: dbSession.configLabel,
    configFull: dbSession.configFull,
    configDir: dbSession.configDir,
    result: dbSession.result || null,
    note: dbSession.note,
    skills: dbSession.injectedSkills as string[] | null,
    taskPrompt: dbSession.prompt,
    startedAt: dbSession.createdAt?.toISOString() ?? null,
  });

  // Codex JSONL adapter — preserved from the previous implementation.
  if (dbSession.agent === "CDX") {
    let input = 0, cacheRead = 0, output = 0;
    const toolBreakdown: Record<string, number> = {};
    const mcpMethods = new Set<string>();
    for (const line of (dbSession.sessionJsonl || "").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "turn.completed" && e.usage) {
          input = (e.usage.input_tokens || 0) - (e.usage.cached_input_tokens || 0);
          cacheRead = e.usage.cached_input_tokens || 0;
          output = (e.usage.output_tokens || 0);
        }
        if (e.type === "item.completed") {
          const t = e.item?.type;
          if (t === "command_execution") toolBreakdown.Bash = (toolBreakdown.Bash || 0) + 1;
          else if (t === "file_change") toolBreakdown.FileEdit = (toolBreakdown.FileEdit || 0) + 1;
          else if (t === "mcp_tool_call") {
            const label = `${e.item.server || "?"}.${e.item.tool || "?"}`;
            toolBreakdown[label] = (toolBreakdown[label] || 0) + 1;
            if (e.item.server && e.item.tool) mcpMethods.add(`${e.item.server}.${e.item.tool}`);
          }
        }
      } catch {}
    }
    session.stats.durationSec = dbSession.durationSec || 0;
    session.stats.toolCalls = dbSession.toolCalls ?? Object.values(toolBreakdown).reduce((sum, count) => sum + count, 0);
    session.stats.toolBreakdown = toolBreakdown;
    session.stats.mcpCalls = dbSession.mcpCalls || 0;
    session.stats.mcpMethods = Array.from(mcpMethods);
    session.stats.tokens = { input, output, cacheRead, cacheCreate: 0, totalIn: input + cacheRead };
    session.stats.costUsd = dbSession.costUsd;
    session.stats.firstTimestamp = dbSession.createdAt?.toISOString() ?? "";
    session.stats.lastTimestamp = dbSession.createdAt?.toISOString() ?? "";
    session.stats.harnessVersion = dbSession.agentVersion ?? "codex-cli";
    session.messages = parseCodexJsonlToMessages(
      dbSession.sessionJsonl || "",
      dbSession.createdAt || new Date(),
      dbSession.prompt || null,
    );
    const hasText = (m: ParsedMessage) => m.blocks.some((b) => b.type === "text");
    session.stats.userMessages = session.messages.filter((m) => m.role === "user" && hasText(m)).length;
    session.stats.effectiveUserMessages = session.stats.userMessages;
    session.stats.assistantMessages = session.messages.filter((m) => m.role === "assistant" && hasText(m)).length;
    // Skills: Codex has no on-stream injection marker, so the JSONL parser leaves
    // these empty. Use the DB values (computed by sync-codex-to-db from the skill
    // file reads) so the "Skills Used" panel reaches parity with Claude Code.
    session.stats.injectedSkills = dbSession.injectedSkills ?? [];
    session.stats.skillInjections = dbSession.skillInjections ?? 0;
  }

  if (dbSession.agent === "OC") {
    let input = 0, cacheRead = 0, cacheCreate = 0, output = 0, cost = 0;
    const toolBreakdown: Record<string, number> = {};
    const mcpMethods = new Set<string>();
    const toolIds = new Set<string>();
    const finishIds = new Set<string>();
    for (const line of (dbSession.sessionJsonl || "").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "step_finish" && event.part?.type === "step-finish") {
          const id = String(event.part.id || "");
          if (id && finishIds.has(id)) continue;
          if (id) finishIds.add(id);
          const tokens = event.part.tokens || {};
          input += Number(tokens.input || 0);
          cacheRead += Number(tokens.cache?.read || 0);
          cacheCreate += Number(tokens.cache?.write || 0);
          output += Number(tokens.output || 0) + Number(tokens.reasoning || 0);
          cost += Number(event.part.cost || 0);
        }
        if (event.type === "tool_use" && event.part?.type === "tool") {
          const id = String(event.part.id || "");
          if (id && toolIds.has(id)) continue;
          if (id) toolIds.add(id);
          const tool = String(event.part.tool || "unknown");
          const label = tool.startsWith("TogetherAIDocs_")
            ? `TogetherAIDocs.${tool.slice("TogetherAIDocs_".length)}`
            : tool;
          toolBreakdown[label] = (toolBreakdown[label] || 0) + 1;
          if (tool.startsWith("TogetherAIDocs_")) mcpMethods.add(label);
        }
      } catch {}
    }
    session.stats.durationSec = dbSession.durationSec || 0;
    session.stats.toolCalls = dbSession.toolCalls ?? Object.values(toolBreakdown).reduce((sum, count) => sum + count, 0);
    session.stats.toolBreakdown = toolBreakdown;
    session.stats.mcpCalls = dbSession.mcpCalls || 0;
    session.stats.mcpMethods = dbSession.mcpMethods?.length ? dbSession.mcpMethods : Array.from(mcpMethods);
    session.stats.tokens = {
      input,
      output,
      cacheRead,
      cacheCreate,
      totalIn: input + cacheRead + cacheCreate,
    };
    session.stats.costUsd = dbSession.costUsd ?? cost;
    session.stats.firstTimestamp = dbSession.createdAt?.toISOString() ?? "";
    session.stats.lastTimestamp = dbSession.createdAt?.toISOString() ?? "";
    session.stats.harnessVersion = dbSession.agentVersion ?? "opencode";
    session.messages = parseOpenCodeJsonlToMessages(
      dbSession.sessionJsonl || "",
      dbSession.createdAt || new Date(),
      dbSession.prompt || null,
    );
    const hasText = (message: ParsedMessage) => message.blocks.some((block) => block.type === "text");
    session.stats.userMessages = session.messages.filter((message) => message.role === "user" && hasText(message)).length;
    session.stats.effectiveUserMessages = session.stats.userMessages;
    session.stats.assistantMessages = session.messages.filter((message) => message.role === "assistant" && hasText(message)).length;
    session.stats.injectedSkills = dbSession.injectedSkills ?? [];
    session.stats.skillInjections = dbSession.skillInjections ?? 0;
  }

  const { stats } = session;
  // Run duration comes from the execution record, not the message timestamp span.
  stats.durationSec = dbSession.durationSec;
  const toolsUsed = Object.entries(stats.toolBreakdown).sort((a, b) => b[1] - a[1]);

  session.stats.costUsd = dbSession.costUsd;

  const canonicalJudge = canonicalJudgeReview(dbSessionRecord.deepAudit);
  const storedChecks = canonicalStoredChecks(dbSessionRecord.storedChecks);
  const evaluatorSources = canonicalEvaluatorSources(dbSessionRecord.evaluatorSources);
  const storedDeterministicOverall = canonicalDeterministicOverall(dbSessionRecord.deterministicEffectiveVerdict);
  const reviewCount = storedChecks.length + (canonicalJudge ? 1 : 0);
  const evidenceCount = 1 + (togetherRequests.length > 0 ? 1 : 0) + (toolsUsed.length > 0 ? 1 : 0);

  return (
    <ResizableSessionShell messages={session.messages} initialRailWidth={sidebarLayout.width} initialRailCollapsed={sidebarLayout.collapsed}>
      <div id="main-scroll" className="relative h-full overflow-y-auto">
        {topBar}
        <div className="px-4 pb-16 pt-8 sm:px-6 lg:px-8">
        <div className="@container mx-auto w-full max-w-7xl">
          {pageHeader}

          {/* Results path — with copy button */}
          {dbSession.resultsPath && (
            <div className="mb-8 rounded-lg border border-rule bg-background px-4 py-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-[12px] text-fg-muted break-all">
                  open: code {dbSession.resultsPath}
                </code>
                <CopyButton value={`code ${dbSession.resultsPath}`} size="xs" />
              </div>
            </div>
          )}

          {dbSession.note && dbSession.result !== "pass" && (
            <section className="mb-8 rounded-lg border border-rule bg-background p-5" aria-label="Run limitations">
              <h2 className="mb-1.5 text-sm font-semibold">Why this run did not pass</h2>
              <p className="max-w-[75ch] whitespace-pre-wrap text-[13px] leading-5 text-fg-muted">{dbSession.note}</p>
            </section>
          )}
          <SessionReviewSummary
            statusKind={statusKind}
            auditVerdict={canonicalJudge?.verdict}
            judgeStatusLabel={readString(dbSessionRecord.judgeStatusLabel)}
            deterministicOverall={storedDeterministicOverall}
            deterministicNote={storedDeterministicOverall ? "stored evaluation result" : undefined}
            startedAt={stats.firstTimestamp}
            duration={formatDuration(stats.durationSec)}
            toolCalls={dbSession.toolCalls}
            costUsd={stats.costUsd}
            costSource={dbSession.costSource}
          />

          <SessionDetailTabs
            reviewCount={reviewCount}
            evidenceCount={evidenceCount}
            transcriptCount={session.messages.length}
            review={(
              <div id="review" className="space-y-8 scroll-mt-20">
                <CanonicalSessionReview
                  prompt={dbSession.prompt}
                  checks={storedChecks}
                  judge={canonicalJudge}
                  runId={readString(dbSessionRecord.canonicalRunId)}
                  evaluatorSources={evaluatorSources}
                />
              </div>
            )}
            evidence={(
              <div id="evidence" className="space-y-8 scroll-mt-20">
                <section className="rounded-lg border border-rule overflow-hidden bg-background">
                  <div className="border-b border-rule px-5 py-3.5">
                    <h2 className="text-sm font-semibold text-foreground">Run details</h2>
                  </div>
                  {/* Label column in muted text; both columns share the cards' 20px inset. */}
                  <Table className="text-[13px] [&_td]:py-2.5 [&_td:first-child]:w-40 [&_td:first-child]:pl-5 [&_td:first-child]:font-normal [&_td:first-child]:text-fg-muted [&_td:last-child]:pr-5">
                    <TableBody>
                      <TableRow>
                        <TableCell>Harness</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5">
                            <AgentLogo agent={agent} className="h-3.5 w-3.5" />
                            {agentName}
                            {(dbSession.agentVersion || stats.harnessVersion) && (
                              <span className="text-xs text-fg-faint font-mono">{dbSession.agentVersion || stats.harnessVersion}</span>
                            )}
                          </span>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Execution</TableCell>
                        <TableCell><ExecutionDetails runtime={dbSession.runtime} /></TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Model</TableCell>
                        <TableCell><ModelDetails requested={dbSession.model} observed={dbSession.modelResolved} /></TableCell>
                      </TableRow>
                      {toolVersions.length > 0 && (
                        <TableRow>
                          <TableCell>Tool versions</TableCell>
                          <TableCell>
                            <ToolVersionBadges items={toolVersions} agent={dbSession.agent} />
                          </TableCell>
                        </TableRow>
                      )}
                      <TableRow>
                        <TableCell>Date</TableCell>
                        <TableCell>{new Date(stats.firstTimestamp).toLocaleString()}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Result</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-2">
                            <StatusBadge kind={statusKind} />
                          </span>
                        </TableCell>
                      </TableRow>
                      {stats.interactions > 0 && (
                        <TableRow>
                          <TableCell>Interactions</TableCell>
                          <TableCell className="tabular-nums">
                            {stats.interactions}
                            <span className="text-fg-muted ml-1 text-xs">(AskUserQuestion)</span>
                          </TableCell>
                        </TableRow>
                      )}
                      {(stats.injectedSkills.length > 0 || ((session.outcome?.skills?.length ?? 0) > 0 && stats.injectedSkills.length === 0)) && (
                        <TableRow>
                          <TableCell>Skills used</TableCell>
                          <TableCell>
                            {stats.injectedSkills.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {stats.injectedSkills.map((s) => (
                                  <span key={s} className="text-[11px] px-1.5 py-0.5 rounded-sm bg-warn-faint border border-warn/30 text-warn">
                                    {s.replace("together-", "")}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-[11px] px-1.5 py-0.5 rounded-sm bg-fail-faint border border-fail/30 text-fail">
                                None injected — skills were available but agent never read them
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                      {dbSession.mcpEnabled && (
                        <TableRow>
                          <TableCell>MCP</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1 items-center">
                              {stats.mcpCalls > 0 ? (
                                <>
                                  <span className="text-[11px] tabular-nums text-fg-muted">{stats.mcpCalls} calls</span>
                                  {stats.mcpMethods.map((m) => (
                                    <span key={m} className="text-[11px] px-1.5 py-0.5 rounded-sm bg-info-faint border border-info/30 text-info">
                                      {m.replace("mcp__TogetherAIDocs__", "")}
                                    </span>
                                  ))}
                                </>
                              ) : (
                                <span className="text-[11px] px-1.5 py-0.5 rounded-sm bg-surface border border-rule text-fg-muted">
                                  Enabled — 0 calls made
                                </span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                      <TableRow>
                        <TableCell>Duration</TableCell>
                        <TableCell className="tabular-nums">{formatDuration(stats.durationSec)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Messages</TableCell>
                        <TableCell className="tabular-nums">
                          {stats.effectiveUserMessages} user, {stats.assistantMessages} assistant
                          {stats.skillInjections > 0 && (
                            <span className="text-fg-muted">, {stats.skillInjections} skill injections</span>
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Tool calls</TableCell>
                        <TableCell className="tabular-nums">{dbSession.toolCalls ?? "—"}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Agent tokens</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="shrink-0 tabular-nums"><AgentTokens total={dbSession.totalTokens} usage={dbSession.tokenUsage} showTooltip={false} />{dbSession.totalTokens !== null && " total"}</span>
                            {dbSession.tokenUsage && <TokensDisplay tokens={dbSession.tokenUsage} />}
                          </div>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Agent cost</TableCell>
                        <TableCell className="tabular-nums"><RunCost value={stats.costUsd} source={dbSession.costSource} /></TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </section>

                {togetherRequests.length > 0 && (
                  <TogetherRequestsCard
                    requests={togetherRequests as Parameters<typeof TogetherRequestsCard>[0]["requests"]}
                    truncated={togetherRequestsTruncated}
                  />
                )}

                {toolsUsed.length > 0 && (
                  <details open className="group">
                    <summary className="flex items-center justify-between py-3 cursor-pointer select-none border-b border-rule">
                      <h2 className="text-sm font-semibold">Tool breakdown</h2>
                      <span className="text-xs text-fg-muted tabular-nums">{toolsUsed.length} tool{toolsUsed.length === 1 ? "" : "s"}</span>
                    </summary>
                    <div className="pt-3">
                      <div className="rounded-lg border border-rule overflow-hidden bg-background">
                        <Table className="text-[13px] [&_td]:py-2.5 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5">
                          <TableBody>
                            {toolsUsed.map(([name, count]) => (
                              <TableRow key={name}>
                                <TableCell className="font-medium">{name}</TableCell>
                                <TableCell className="text-right tabular-nums text-fg-muted w-20">{count}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  </details>
                )}
              </div>
            )}
            transcript={(
              <div id="conversation" className="scroll-mt-20">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold">Conversation</h2>
                </div>
                <Separator className="mb-3" />
                <ConversationView messages={session.messages} />
              </div>
            )}
          />
        </div>
        </div>

        <ScrollToTop scrollContainerId="main-scroll" />
        <ScrollToHash />
      </div>
    </ResizableSessionShell>
  );
}

// Codex JSONL → CC-shaped messages (so ConversationView can render both).
function parseCodexJsonlToMessages(jsonl: string, sessionStart: Date, taskPrompt: string | null): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let parentUuid: string | null = null;
  let seq = 0;
  const nextTs = () => new Date(sessionStart.getTime() + seq++ * 1000).toISOString();

  if (taskPrompt) {
    const promptUuid = "cdx-prompt";
    messages.push({
      uuid: promptUuid, parentUuid: null, timestamp: nextTs(),
      role: "user", msgType: "user",
      blocks: [{ type: "text", text: taskPrompt }],
    });
    parentUuid = promptUuid;
  }

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; item?: { id?: string; type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; changes?: Array<{ path?: string; kind?: string }>; server?: string; tool?: string; arguments?: unknown; result?: unknown } };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "item.completed" || !e.item) continue;
    const item = e.item;
    const itemId = item.id || `cdx-${seq}`;

    if (item.type === "agent_message") {
      const uuid = `cdx-msg-${itemId}`;
      messages.push({
        uuid, parentUuid, timestamp: nextTs(),
        role: "assistant", msgType: "assistant",
        blocks: [{ type: "text", text: item.text || "" }],
      });
      parentUuid = uuid;
      continue;
    }

    if (item.type === "command_execution") {
      const useId = `cdx-tu-${itemId}`;
      const useUuid = `cdx-use-${itemId}`;
      messages.push({
        uuid: useUuid, parentUuid, timestamp: nextTs(),
        role: "assistant", msgType: "assistant",
        blocks: [{ type: "tool_use", id: useId, name: "Bash", input: { command: item.command || "" } }],
      });
      const resultUuid = `cdx-res-${itemId}`;
      messages.push({
        uuid: resultUuid, parentUuid: useUuid, timestamp: nextTs(),
        role: "user", msgType: "user",
        blocks: [{ type: "tool_result", tool_use_id: useId, content: item.aggregated_output ?? "", is_error: item.exit_code != null && item.exit_code !== 0 }],
      });
      parentUuid = resultUuid;
      continue;
    }

    if (item.type === "file_change") {
      const useId = `cdx-tu-${itemId}`;
      const useUuid = `cdx-use-${itemId}`;
      const changes = item.changes || [];
      const summary = changes.map((c) => `${c.kind || "?"} ${c.path || "?"}`).join("\n") || "(no path data)";
      messages.push({
        uuid: useUuid, parentUuid, timestamp: nextTs(),
        role: "assistant", msgType: "assistant",
        blocks: [{ type: "tool_use", id: useId, name: "FileEdit", input: { changes } }],
      });
      const resultUuid = `cdx-res-${itemId}`;
      messages.push({
        uuid: resultUuid, parentUuid: useUuid, timestamp: nextTs(),
        role: "user", msgType: "user",
        blocks: [{ type: "tool_result", tool_use_id: useId, content: summary }],
      });
      parentUuid = resultUuid;
      continue;
    }

    if (item.type === "mcp_tool_call") {
      const useId = `cdx-tu-${itemId}`;
      const useUuid = `cdx-use-${itemId}`;
      const name = `mcp__${item.server || "unknown"}__${item.tool || "unknown"}`;
      const rawResult = item.result;
      const resultContent = typeof rawResult === "string"
        ? rawResult
        : rawResult != null ? JSON.stringify(rawResult) : "";
      messages.push({
        uuid: useUuid, parentUuid, timestamp: nextTs(),
        role: "assistant", msgType: "assistant",
        blocks: [{ type: "tool_use", id: useId, name, input: (item.arguments as Record<string, unknown>) || {} }],
      });
      const resultUuid = `cdx-res-${itemId}`;
      messages.push({
        uuid: resultUuid, parentUuid: useUuid, timestamp: nextTs(),
        role: "user", msgType: "user",
        blocks: [{ type: "tool_result", tool_use_id: useId, content: resultContent }],
      });
      parentUuid = resultUuid;
      continue;
    }
  }
  return messages;
}

// OpenCode JSONL → CC-shaped messages for the shared conversation renderer.
function parseOpenCodeJsonlToMessages(jsonl: string, sessionStart: Date, taskPrompt: string | null): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const seenParts = new Set<string>();
  let parentUuid: string | null = null;
  let seq = 0;
  const nextTs = () => new Date(sessionStart.getTime() + seq++ * 1000).toISOString();

  if (taskPrompt) {
    const promptUuid = "oc-prompt";
    messages.push({
      uuid: promptUuid,
      parentUuid: null,
      timestamp: nextTs(),
      role: "user",
      msgType: "user",
      blocks: [{ type: "text", text: taskPrompt }],
    });
    parentUuid = promptUuid;
  }

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: {
      type?: string;
      error?: unknown;
      part?: {
        id?: string;
        type?: string;
        text?: string;
        tool?: string;
        state?: {
          status?: string;
          input?: unknown;
          output?: unknown;
          error?: unknown;
        };
      };
    };
    try { event = JSON.parse(line); } catch { continue; }
    const part = event.part;
    const partId = String(part?.id || `oc-${seq}`);

    if (event.type === "text" && part?.type === "text" && !seenParts.has(partId)) {
      seenParts.add(partId);
      const uuid = `oc-msg-${partId}`;
      messages.push({
        uuid,
        parentUuid,
        timestamp: nextTs(),
        role: "assistant",
        msgType: "assistant",
        blocks: [{ type: "text", text: part.text || "" }],
      });
      parentUuid = uuid;
      continue;
    }

    if (event.type === "reasoning" && part?.type === "reasoning" && !seenParts.has(partId)) {
      seenParts.add(partId);
      const uuid = `oc-reasoning-${partId}`;
      messages.push({
        uuid,
        parentUuid,
        timestamp: nextTs(),
        role: "assistant",
        msgType: "assistant",
        blocks: [{ type: "thinking", thinking: part.text || "" }],
      });
      parentUuid = uuid;
      continue;
    }

    if (event.type === "tool_use" && part?.type === "tool" && !seenParts.has(partId)) {
      seenParts.add(partId);
      const useId = `oc-tu-${partId}`;
      const useUuid = `oc-use-${partId}`;
      const input = part.state?.input && typeof part.state.input === "object"
        ? part.state.input as Record<string, unknown>
        : {};
      messages.push({
        uuid: useUuid,
        parentUuid,
        timestamp: nextTs(),
        role: "assistant",
        msgType: "assistant",
        blocks: [{ type: "tool_use", id: useId, name: part.tool || "unknown", input }],
      });
      const rawOutput = part.state?.status === "error" ? part.state?.error : part.state?.output;
      const output = typeof rawOutput === "string"
        ? rawOutput
        : rawOutput == null ? "" : JSON.stringify(rawOutput);
      const resultUuid = `oc-res-${partId}`;
      messages.push({
        uuid: resultUuid,
        parentUuid: useUuid,
        timestamp: nextTs(),
        role: "user",
        msgType: "user",
        blocks: [{
          type: "tool_result",
          tool_use_id: useId,
          content: output,
          is_error: part.state?.status === "error",
        }],
      });
      parentUuid = resultUuid;
      continue;
    }

    if (event.type === "error") {
      const uuid = `oc-error-${seq}`;
      const text = typeof event.error === "string"
        ? event.error
        : JSON.stringify(event.error ?? { message: "Unknown OpenCode error" });
      messages.push({
        uuid,
        parentUuid,
        timestamp: nextTs(),
        role: "assistant",
        msgType: "assistant",
        blocks: [{ type: "text", text: `OpenCode error: ${text}` }],
      });
      parentUuid = uuid;
    }
  }
  return messages;
}
