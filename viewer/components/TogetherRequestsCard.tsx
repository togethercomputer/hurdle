import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { AgentTrafficGate } from "@/components/AgentTrafficGate";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isOkStatus, splitApiCalls, summarizeApiCalls } from "@/lib/api-calls.mjs";

export type TogetherRequest = {
  ts?: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  disposition?: "blocked";
  // "agent" marks the Agent's own traffic outside the Suite's API hosts.
  scope?: "task" | "agent";
  model?: string | null;
  response_id?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  duration_ms?: number | null;
  // WebSocket connection summary (one row per connection, from websocket_end).
  frames_sent?: number | null;
  frames_recv?: number | null;
  bytes_sent?: number | null;
  bytes_recv?: number | null;
};

// HH:MM:SS straight from the ISO string (UTC) — deterministic, no timezone math,
// so it's SSR-safe. (The conversation view renders local time; these are UTC.)
function utcTime(ts?: string): string {
  return ts && ts.length >= 19 ? ts.slice(11, 19) : "—";
}

function fmtBytes(n?: number | null): string {
  if (!n) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function plural(count: number, truncated: boolean): string {
  return `${count}${truncated ? "+" : ""} call${count !== 1 || truncated ? "s" : ""}`;
}

// Agent rows are context, not results: they keep neutral status styling.
function RequestsTable({ requests, neutral = false }: { requests: TogetherRequest[]; neutral?: boolean }) {
  const showTraffic = requests.some((request) => request.method === "WS" || request.frames_sent != null);
  const showModel = requests.some((request) => request.model);
  const showTokens = requests.some((request) => (
    request.prompt_tokens != null || request.completion_tokens != null
  ));
  const showResponseId = requests.some((request) => request.response_id);
  return (
    <div className="max-h-96 overflow-x-auto overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Time<span className="text-fg-faint font-normal"> ·UTC</span></TableHead>
            <TableHead className="w-16">Status</TableHead>
            <TableHead>Endpoint</TableHead>
            {showTraffic && <TableHead>Traffic</TableHead>}
            {showModel && <TableHead>Model</TableHead>}
            {showTokens && <TableHead className="text-right w-20">Tokens</TableHead>}
            <TableHead className="text-right w-16">ms</TableHead>
            {showResponseId && <TableHead className="w-44">Response ID</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.map((r, i) => {
            const isWs = r.method === "WS" || r.frames_sent != null;
            const isBlocked = r.disposition === "blocked";
            const ok = isOkStatus(r.status);
            const tone = neutral ? "text-fg-muted" : isBlocked ? "text-warn" : ok ? "text-pass" : "text-fail";
            const dot = neutral ? "bg-fg-faint" : isBlocked ? "bg-warn" : ok ? "bg-pass" : "bg-fail";
            const tokens = r.prompt_tokens != null || r.completion_tokens != null
              ? `${r.prompt_tokens ?? 0}→${r.completion_tokens ?? 0}`
              : "—";
            const time = utcTime(r.ts);
            return (
              <TableRow key={r.response_id || `${r.path}-${i}`}>
                <TableCell className="font-mono text-[11px] text-fg-muted tabular-nums whitespace-nowrap">
                  {time}
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs tabular-nums ${tone}`}
                    title={isBlocked && r.status ? `Blocked with HTTP ${r.status}` : undefined}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                    {isBlocked ? "Blocked" : (r.status ?? "?")}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-[11px]">
                  <span className="text-fg-faint">{r.method} {r.host ? `${r.host}` : ""}</span>{r.path}
                </TableCell>
                {showTraffic && (
                  <TableCell className="font-mono text-[11px] text-fg-muted">
                    {isWs
                      ? <span title="frames · bytes (↑ client→server, ↓ server→client)">↑{r.frames_sent ?? 0}f {fmtBytes(r.bytes_sent)} · ↓{r.frames_recv ?? 0}f {fmtBytes(r.bytes_recv)}</span>
                      : "—"}
                  </TableCell>
                )}
                {showModel && <TableCell className="font-mono text-[11px] text-fg-muted">{r.model || "—"}</TableCell>}
                {showTokens && <TableCell className="text-right font-mono text-[11px] text-fg-muted tabular-nums">{isWs ? "—" : tokens}</TableCell>}
                <TableCell className="text-right font-mono text-[11px] text-fg-muted tabular-nums">{r.duration_ms ?? "—"}</TableCell>
                {showResponseId && <TableCell className="font-mono text-[11px] text-fg-faint truncate">{r.response_id || "—"}</TableCell>}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// The Agent's own calls, collapsed, with neutral statuses: context, not results.
export function AgentTrafficDetails({ requests, truncated = false }: { requests: TogetherRequest[]; truncated?: boolean }) {
  return (
    <details className="group border-t border-rule">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-5 py-3 text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
          <span className="font-semibold text-foreground">Agent traffic</span>
          <span className="text-fg-faint"> · the Agent&apos;s own model, config and telemetry calls</span>
        </span>
        <span className="tabular-nums">{plural(requests.length, truncated)}</span>
      </summary>
      <RequestsTable requests={requests} neutral />
    </details>
  );
}

// The egress-proxy capture: every target API call the agent actually made,
// logged out-of-band so a pass is backed by real server receipts, not narration.
// On Together the Guardian also records the Agent's own model, config and
// telemetry calls. They never count here, and appear only when "Show agent
// traffic" is on in Viewer settings.
export function TogetherRequestsCard({
  requests,
  truncated = false,
  agentTruncated = false,
}: {
  requests: TogetherRequest[];
  truncated?: boolean;
  agentTruncated?: boolean;
}) {
  if (!requests || requests.length === 0) return null;
  const { task, agent } = splitApiCalls(requests);
  const { blocked, failed } = summarizeApiCalls(task);
  const agentTraffic = agent.length > 0 ? <AgentTrafficDetails requests={agent} truncated={agentTruncated} /> : null;

  const card = (agentSection: ReactNode) => (
    <div className="rounded-lg border border-rule overflow-hidden bg-background">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-rule">
        <h2 className="text-sm font-semibold text-foreground">Captured API calls</h2>
        <span className="text-xs text-fg-muted tabular-nums">
          {plural(task.length, truncated)}
          {blocked > 0 && <span className="text-warn"> · {blocked} blocked</span>}
          {failed > 0 && <span className="text-fail"> · {failed} non-2xx</span>}
        </span>
      </div>
      {task.length > 0
        ? <RequestsTable requests={task} />
        : <p className="px-5 py-3 text-xs text-fg-muted">No calls to the Suite&apos;s API hosts.</p>}
      {agentSection}
    </div>
  );

  // With no task calls, the card exists only to show Agent traffic.
  if (task.length === 0) return <AgentTrafficGate>{card(agentTraffic)}</AgentTrafficGate>;
  return card(agentTraffic && <AgentTrafficGate>{agentTraffic}</AgentTrafficGate>);
}
