// The Viewer lists only the Task's API calls. On Together the Guardian sees
// every connection the sandbox makes, so its journal also holds the Agent's
// own model, config and telemetry calls. Journal rows carry no route, so the
// Suite's API hosts decide.

/** The run's Suite API hosts, or null when the record does not say. */
export function taskApiHosts(snapshot) {
  const hosts = snapshot?.target?.egress?.relevantHosts;
  if (!Array.isArray(hosts)) return null;
  return new Set(hosts.filter((host) => typeof host === "string").map((host) => host.toLowerCase()));
}

/** True for a call to one of the Suite's API hosts. */
export function isTaskApiCall(host, taskHosts) {
  // Without recorded hosts, keep every call.
  if (taskHosts === null) return true;
  return taskHosts.has(String(host).toLowerCase());
}

// 101 (WebSocket upgrade) is a success.
export function isOkStatus(status) {
  return Number.isFinite(status) && ((status >= 200 && status < 300) || status === 101);
}

/** Header counts. A blocked call is counted as blocked, not as non-2xx. */
export function summarizeApiCalls(rows) {
  let blocked = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.disposition === "blocked") blocked += 1;
    else if (!isOkStatus(row.status)) failed += 1;
  }
  return { calls: rows.length, blocked, failed };
}
