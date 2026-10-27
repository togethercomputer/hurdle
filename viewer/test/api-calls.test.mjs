import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { isTaskApiCall, summarizeApiCalls, taskApiHosts } from "../lib/api-calls.mjs";

const require = createRequire(import.meta.url);
const viewerRoot = fileURLToPath(new URL("..", import.meta.url));

// Transpiles a Viewer TypeScript module and its "@/" imports for a test render.
async function loadViewerModule(path, overrides = {}) {
  const source = readFileSync(path, "utf8");
  let code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const specifiers = [...new Set([...code.matchAll(/from "([^"]+)"/g)].map(([, name]) => name))];
  for (const name of specifiers) {
    let target;
    if (Object.hasOwn(overrides, name)) {
      target = overrides[name];
    } else if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? resolve(viewerRoot, name.slice(2)) : resolve(dirname(path), name);
      const file = [base, `${base}.tsx`, `${base}.ts`].find((candidate) => existsSync(candidate) && !candidate.endsWith("/"));
      target = /\.tsx?$/.test(file) ? await loadViewerModule(file, overrides) : pathToFileURL(file).href;
    } else {
      target = pathToFileURL(require.resolve(name)).href;
    }
    code = code.replaceAll(`from "${name}"`, `from "${target}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

const cardPath = resolve(viewerRoot, "components/TogetherRequestsCard.tsx");
const card = await import(await loadViewerModule(cardPath));
const render = (props) => renderToStaticMarkup(React.createElement(card.TogetherRequestsCard, props));

const row = (host, path, status, extra = {}) => ({ method: "GET", host, path, status, ...extra });

test("only calls to the Suite's API hosts are Task API calls", () => {
  const hosts = taskApiHosts({ target: { egress: { relevantHosts: ["API.Together.ai", 7] } } });
  assert.deepEqual([...hosts], ["api.together.ai"]);
  assert.equal(isTaskApiCall("api.together.AI", hosts), true);
  assert.equal(isTaskApiCall("api.anthropic.com", hosts), false);
  assert.equal(isTaskApiCall("api.anthropic.com", new Set()), false, "a Suite with no API hosts has no Task calls");
  // Older records without the field keep every call.
  assert.equal(taskApiHosts({ target: {} }), null);
  assert.equal(isTaskApiCall("api.anthropic.com", null), true);

  assert.deepEqual(summarizeApiCalls([
    row("a", "/ok", 204), row("a", "/ws", 101), row("a", "/gone", 404), row("a", "/dropped", undefined),
    row("a", "/refused", 403, { disposition: "blocked" }),
  ]), { calls: 5, blocked: 1, failed: 2 });
});

test("the card lists the Task's API calls with their counts", () => {
  const html = render({ requests: [
    row("api.together.ai", "/v1/models", 200),
    row("api.together.ai", "/v1/chat/completions", 200, { method: "POST" }),
  ] });
  assert.match(html, /<h2[^>]*>Captured API calls<\/h2>/);
  assert.match(html, />2 calls</);
  assert.doesNotMatch(html, /non-2xx|blocked|Agent traffic|<details/);

  const e2b = [
    row("api.together.ai", "/v1/models", 200),
    row("api.together.ai", "/v1/chat/completions", 429),
    row("api.together.ai", "/v1/compute/clusters", 403, { disposition: "blocked" }),
  ];
  assert.match(render({ requests: e2b, truncated: true }),
    /3\+ calls<span class="text-warn"> · 1 blocked<\/span><span class="text-fail"> · 1 non-2xx<\/span>/);
  assert.equal(render({ requests: [] }), "");
});
