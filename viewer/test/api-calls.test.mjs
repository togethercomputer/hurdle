import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { apiCallScope, splitApiCalls, summarizeApiCalls, taskApiHosts } from "../lib/api-calls.mjs";

const require = createRequire(import.meta.url);
const viewerRoot = fileURLToPath(new URL("..", import.meta.url));

// Transpiles a Viewer TypeScript module and its "@/" imports for a test render.
async function loadViewerModule(path) {
  const source = readFileSync(path, "utf8");
  let code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const specifiers = [...new Set([...code.matchAll(/from "([^"]+)"/g)].map(([, name]) => name))];
  for (const name of specifiers) {
    let target;
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? resolve(viewerRoot, name.slice(2)) : resolve(dirname(path), name);
      const file = [base, `${base}.tsx`, `${base}.ts`].find((candidate) => existsSync(candidate) && !candidate.endsWith("/"));
      target = /\.tsx?$/.test(file) ? await loadViewerModule(file) : pathToFileURL(file).href;
    } else {
      target = pathToFileURL(require.resolve(name)).href;
    }
    code = code.replaceAll(`from "${name}"`, `from "${target}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

const { TogetherRequestsCard } = await import(await loadViewerModule(resolve(viewerRoot, "components/TogetherRequestsCard.tsx")));
const render = (props) => renderToStaticMarkup(React.createElement(TogetherRequestsCard, props));

const row = (host, path, status, extra = {}) => ({ method: "GET", host, path, status, ...extra });
// A Together run: the task's two calls plus Claude Code's own traffic.
const togetherRun = [
  row("api.anthropic.com", "/api/claude_code/settings", 404, { scope: "agent" }),
  row("api.together.ai", "/v1/models", 200, { scope: "task" }),
  row("api.anthropic.com", "/v1/messages", 200, { scope: "agent" }),
  row("http-intake.logs.us5.datadoghq.com", "/api/v2/logs", undefined, { scope: "agent" }),
  row("api.together.ai", "/v1/chat/completions", 200, { method: "POST", scope: "task" }),
];

test("API calls are task calls only on the Suite's API hosts", () => {
  const hosts = taskApiHosts({ target: { egress: { relevantHosts: ["API.Together.ai", 7] } } });
  assert.deepEqual([...hosts], ["api.together.ai"]);
  assert.equal(apiCallScope("api.together.AI", hosts), "task");
  assert.equal(apiCallScope("api.anthropic.com", hosts), "agent");
  assert.equal(apiCallScope("api.anthropic.com", new Set()), "agent", "a Suite with no API hosts has no task calls");
  // Older records without the field keep every row as a task call.
  assert.equal(taskApiHosts({ target: {} }), null);
  assert.equal(apiCallScope("api.anthropic.com", null), "task");

  const { task, agent } = splitApiCalls(togetherRun);
  assert.deepEqual(task.map((call) => call.path), ["/v1/models", "/v1/chat/completions"]);
  assert.equal(agent.length, 3);
  assert.deepEqual(summarizeApiCalls(task), { calls: 2, blocked: 0, failed: 0 });
  assert.deepEqual(summarizeApiCalls([
    row("a", "/ok", 204), row("a", "/ws", 101), row("a", "/gone", 404), row("a", "/dropped", undefined),
    row("a", "/refused", 403, { disposition: "blocked" }),
  ]), { calls: 5, blocked: 1, failed: 2 });
});

test("the card counts only task calls and collapses the Agent's own traffic", () => {
  const html = render({ requests: togetherRun });
  assert.match(html, /<h2[^>]*>Task API calls<\/h2>/);
  const header = html.slice(0, html.indexOf("<table"));
  assert.match(header, />2 calls</);
  assert.doesNotMatch(header, /non-2xx|blocked/);
  assert.match(html, /<details class="group [^"]*"><summary/, "Agent traffic starts collapsed");
  assert.match(html, /Agent traffic/);
  const agentSection = html.slice(html.indexOf("<details"));
  assert.match(agentSection, />3 calls</);
  assert.match(agentSection, /api\.anthropic\.com/);
  assert.doesNotMatch(agentSection, /text-fail|bg-fail|text-pass/, "Agent traffic has no pass or failure styling");
  const taskSection = html.slice(0, html.indexOf("<details"));
  assert.doesNotMatch(taskSection, /anthropic|datadoghq/);

  // A failing task call still counts and shows as a failure.
  const failing = render({ requests: [...togetherRun, row("api.together.ai", "/v1/chat/completions", 500, { scope: "task" })] });
  assert.match(failing.slice(0, failing.indexOf("<table")), /3 calls<span class="text-fail"> · 1 non-2xx/);

  const agentOnly = render({ requests: togetherRun.filter((call) => call.scope === "agent"), agentTruncated: true });
  assert.match(agentOnly, />0 calls</);
  assert.match(agentOnly, /No calls to the Suite&#x27;s API hosts\./);
  assert.match(agentOnly, />3\+ calls</);
});

test("a run with only task calls looks as before", () => {
  const e2b = [
    row("api.together.ai", "/v1/models", 200, { scope: "task" }),
    row("api.together.ai", "/v1/chat/completions", 429, { scope: "task" }),
    row("api.together.ai", "/v1/compute/clusters", 403, { scope: "task", disposition: "blocked" }),
  ];
  for (const requests of [e2b, e2b.map(({ scope, ...call }) => call)]) {
    const html = render({ requests, truncated: true });
    assert.match(html, /<h2[^>]*>Captured API calls<\/h2>/);
    assert.match(html, /3\+ calls<span class="text-warn"> · 1 blocked<\/span><span class="text-fail"> · 1 non-2xx<\/span>/);
    assert.doesNotMatch(html, /<details|Agent traffic/);
  }
  assert.equal(render({ requests: [] }), "");
});
