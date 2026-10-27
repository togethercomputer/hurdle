import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isOkStatus, summarizeApiCalls } from "@/lib/api-calls.mjs";

export type TogetherRequest = {
  ts?: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  disposition?: "blocked";
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

// The egress-proxy capture: every call the Agent made to the Suite's API hosts,
// logged out-of-band so a pass is backed by real server receipts, not narration.
// The Agent's own model, config and telemetry calls are left out.
export function TogetherRequestsCard({
  requests,
  truncated = false,
}: {
  requests: TogetherRequest[];
  truncated?: boolean;
}) {
  if (!requests || requests.length === 0) return null;
  const { blocked, failed } = summarizeApiCalls(requests);
  const showTraffic = requests.some((request) => request.method === "WS" || request.frames_sent != null);
  const showModel = requests.some((request) => request.model);
  const showTokens = requests.some((request) => (
    request.prompt_tokens != null || request.completion_tokens != null
  ));
  const showResponseId = requests.some((request) => request.response_id);

  return (
    <div className="rounded-lg border border-rule overflow-hidden bg-background">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-rule">
        <h2 className="text-sm font-semibold text-foreground">Captured API calls</h2>
        <span className="text-xs text-fg-muted tabular-nums">
          {requests.length}{truncated ? "+" : ""} call{requests.length !== 1 || truncated ? "s" : ""}
          {blocked > 0 && <span className="text-warn"> · {blocked} blocked</span>}
          {failed > 0 && <span className="text-fail"> · {failed} non-2xx</span>}
        </span>
      </div>
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
                      className={`inline-flex items-center gap-1.5 text-xs tabular-nums ${isBlocked ? "text-warn" : ok ? "text-pass" : "text-fail"}`}
                      title={isBlocked && r.status ? `Blocked with HTTP ${r.status}` : undefined}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${isBlocked ? "bg-warn" : ok ? "bg-pass" : "bg-fail"}`} />
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
    </div>
  );
}
