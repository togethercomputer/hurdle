import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertExchangeFactCapturePolicy,
  createE2BGuardianController,
} from "../lib/execution-environments/e2b-guardian.mjs";

const guardianPath = new URL("../verify/proxy/generic_guardian.py", import.meta.url);
const exchangeFactConformance = JSON.parse(readFileSync(
  new URL("fixtures/exchange-facts-conformance/policy-v1.json", import.meta.url),
  "utf8",
));

test("generic E2B Guardian substitutes only scoped headers and seals metadata", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "requests.jsonl");
  const secret = "real-target-secret";
  const surrogate = "tae_visible_surrogate";
  const script = String.raw`
import json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
module = runpy.run_path(os.environ["GUARDIAN_PATH"])
addon = module["addons"][0]

def flow(flow_id, host, path, headers=None):
    request = types.SimpleNamespace(
        pretty_host=host,
        path=path,
        method="post",
        scheme="https",
        headers=headers or {},
    )
    return types.SimpleNamespace(id=flow_id, request=request, response=None)

allowed = flow("allowed", "API.EXAMPLE.COM.", "/v1/chat?token=must-not-persist", {
    "authorization": "Bearer " + os.environ["SURROGATE"],
    "x-private": "must-not-persist",
})
addon.requestheaders(allowed)
assert allowed.request.headers["authorization"] == "Bearer " + os.environ["SECRET"]
allowed.response = Response.make(201, headers={
    "x-cluster": "cluster-1",
    "x-private": "must-not-persist",
})
addon.response(allowed)

policy_blocked = flow("policy-blocked", "api.example.com", "/v1/compute/clusters", {
    "authorization": "Bearer " + os.environ["SURROGATE"],
})
addon.requestheaders(policy_blocked)
assert policy_blocked.response.status_code == 403
assert policy_blocked.request.headers["authorization"] == "Bearer " + os.environ["SURROGATE"]

route_rejected = flow("route-rejected", "other.example.com", "/v1/chat")
addon.requestheaders(route_rejected)
assert route_rejected.response.status_code == 403

control = flow("control", "tae-egress-control.invalid", "/__tae_egress_control__/seal", {
    "x-tae-egress-control": os.environ["TAE_EGRESS_CONTROL_TOKEN"],
})
addon.requestheaders(control)
state = json.loads(control.response.content)
assert state["sealed"] is True
assert state["activeFlows"] == 0
assert state["rowCount"] == 2
assert state["truncated"] is False
assert state["journalDigest"].startswith("sha256:")
print(json.dumps(state, separators=(",", ":")))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      SECRET: secret,
      SURROGATE: surrogate,
      TAE_EGRESS_LOG: journal,
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify({
        "api.example.com": ["x-cluster"],
      }),
      TAE_EGRESS_BLOCKED_REQUESTS: JSON.stringify([{
        id: "no-reservation",
        method: "POST",
        path: "/v1/compute/clusters",
      }]),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([{
        surrogate,
        value: secret,
        hosts: ["api.example.com"],
        headerNames: ["authorization"],
      }]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const contents = readFileSync(journal, "utf8");
  const rows = contents.trim().split("\n").map((line) => JSON.parse(line));
  assert.doesNotMatch(contents, new RegExp(secret));
  assert.doesNotMatch(contents, /must-not-persist|authorization|token=/);
  assert.deepEqual(rows[0], {
    kind: "http-request",
    sequence: 0,
    observedAt: rows[0].observedAt,
    method: "POST",
    scheme: "https",
    host: "api.example.com",
    path: "/v1/chat",
    statusCode: 201,
    durationMs: rows[0].durationMs,
    selectedFields: { "x-cluster": "cluster-1" },
  });
  assert.deepEqual(rows[1], {
    kind: "http-request",
    sequence: 1,
    observedAt: rows[1].observedAt,
    method: "POST",
    scheme: "https",
    host: "api.example.com",
    path: "/v1/compute/clusters",
    statusCode: 403,
    durationMs: 0,
    selectedFields: {},
    disposition: "blocked",
  });
});

test("generic E2B Guardian swaps the Agent credential on pass-through hosts without journaling", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-pass-through-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "requests.jsonl");
  const agentSecret = "sk-ant-api03-real-agent-secret";
  const agentStandIn = "sk-ant-api03-hurdle_agent_stand_in_fixture";
  const targetSecret = "real-target-secret";
  const targetStandIn = "tae_visible_target";
  const script = String.raw`
import json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {}, stream=False)

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
module = runpy.run_path(os.environ["GUARDIAN_PATH"])
addon = module["addons"][0]
agent_secret = os.environ["AGENT_SECRET"]
agent_stand_in = os.environ["AGENT_STAND_IN"]
target_secret = os.environ["TARGET_SECRET"]
target_stand_in = os.environ["TARGET_STAND_IN"]

def flow(flow_id, host, path, headers=None, target=None, method="post"):
    request = types.SimpleNamespace(
        pretty_host=host,
        host=target or host,
        path=path,
        method=method,
        scheme="https",
        headers=headers or {},
        stream=False,
    )
    return types.SimpleNamespace(
        id=flow_id,
        request=request,
        response=None,
        websocket=types.SimpleNamespace(messages=[]),
    )

def control(action):
    request = flow("control-" + action, "tae-egress-control.invalid", "/__tae_egress_control__/" + action, {
        "x-tae-egress-control": os.environ["TAE_EGRESS_CONTROL_TOKEN"],
    })
    addon.requestheaders(request)
    return json.loads(request.response.content)

# Model traffic: the stand-in becomes the real key, both directions stream,
# request policy does not apply, and nothing is counted or journaled.
model = flow("model", "API.ANTHROPIC.COM.", "/v1/messages", {
    "x-api-key": agent_stand_in,
    "authorization": "Bearer " + agent_stand_in,
    "x-other": agent_stand_in,
}, target="api.anthropic.com")
addon.requestheaders(model)
assert model.response is None
assert model.request.stream is True
assert model.request.headers["x-api-key"] == agent_secret
assert model.request.headers["authorization"] == "Bearer " + agent_secret
assert model.request.headers["x-other"] == agent_stand_in
assert control("status")["activeFlows"] == 0
model.response = Response.make(200, headers={"content-type": "text/event-stream"})
addon.responseheaders(model)
assert model.response.stream is True
addon.response(model)

# A Host header that disagrees with the tunnel destination never receives a
# credential and is rejected on a pass-through route.
confused = flow("confused", "api.anthropic.com", "/v1/messages", {
    "x-api-key": agent_stand_in,
}, target="api.example.com")
addon.requestheaders(confused)
assert confused.response.status_code == 403
assert confused.request.headers["x-api-key"] == agent_stand_in

# Credentials stay scoped to their own hosts, and a captured exchange whose
# Host header disagrees with its destination is journaled without a swap.
crossed = flow("crossed", "api.example.com", "/v1/chat", {
    "authorization": "Bearer " + agent_stand_in,
})
addon.requestheaders(crossed)
assert crossed.request.headers["authorization"] == "Bearer " + agent_stand_in
crossed.response = Response.make(200)
addon.response(crossed)
mismatched = flow("mismatched", "api.example.com", "/v1/chat", {
    "authorization": "Bearer " + target_stand_in,
}, target="api.anthropic.com")
addon.requestheaders(mismatched)
assert mismatched.request.headers["authorization"] == "Bearer " + target_stand_in
mismatched.response = Response.make(200)
addon.response(mismatched)

# A pass-through WebSocket neither counts frames nor truncates the journal.
socket = flow("socket", "api.anthropic.com", "/v1/realtime", {
    "authorization": "Bearer " + agent_stand_in,
}, method="get")
addon.requestheaders(socket)
assert socket.request.headers["authorization"] == "Bearer " + agent_secret
socket.response = Response.make(101)
addon.response(socket)
addon.websocket_start(socket)
socket.websocket.messages.append(types.SimpleNamespace(from_client=True, content=b"frame"))
addon.websocket_message(socket)
addon.websocket_end(socket)

failed = flow("failed", "api.anthropic.com", "/v1/messages", {"x-api-key": agent_stand_in})
addon.requestheaders(failed)
addon.error(failed)

state = control("seal")
assert state["sealed"] is True
assert state["activeFlows"] == 0
assert state["rowCount"] == 2
assert state["truncated"] is False
late = flow("late", "api.anthropic.com", "/v1/messages", {"x-api-key": agent_stand_in})
addon.requestheaders(late)
assert late.response.status_code == 503
assert late.request.headers["x-api-key"] == agent_stand_in
assert addon._passthrough == set()
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      AGENT_SECRET: agentSecret,
      AGENT_STAND_IN: agentStandIn,
      TARGET_SECRET: targetSecret,
      TARGET_STAND_IN: targetStandIn,
      TAE_EGRESS_LOG: journal,
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_PASSTHROUGH_HOSTS: JSON.stringify(["api.anthropic.com"]),
      TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify({}),
      TAE_EGRESS_BLOCKED_REQUESTS: JSON.stringify([{
        id: "no-messages",
        method: "POST",
        path: "/v1/messages",
      }]),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([
        {
          surrogate: targetStandIn,
          value: targetSecret,
          hosts: ["api.example.com"],
          headerNames: ["authorization"],
        },
        {
          surrogate: agentStandIn,
          value: agentSecret,
          hosts: ["api.anthropic.com"],
          headerNames: ["x-api-key", "authorization"],
        },
      ]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const contents = readFileSync(journal, "utf8");
  assert.doesNotMatch(contents, new RegExp(`${agentSecret}|${targetSecret}|anthropic`));
  assert.deepEqual(
    contents.trim().split("\n").map((line) => {
      const { host, path, statusCode } = JSON.parse(line);
      return { host, path, statusCode };
    }),
    [
      { host: "api.example.com", path: "/v1/chat", statusCode: 200 },
      { host: "api.example.com", path: "/v1/chat", statusCode: 200 },
    ],
  );
});

test("generic E2B Guardian refuses a host that is both captured and pass-through", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-overlap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = String.raw`
import os, runpy, sys, types
mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=object)
sys.modules["mitmproxy"] = mitmproxy
runpy.run_path(os.environ["GUARDIAN_PATH"])
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: join(root, "requests.jsonl"),
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.anthropic.com"]),
      TAE_EGRESS_PASSTHROUGH_HOSTS: JSON.stringify(["api.anthropic.com"]),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /capture and pass-through hosts overlap/);
});

test("generic E2B Guardian projects bounded JSON facts without retaining bodies", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "requests.jsonl");
  const policyFingerprint = `sha256:${"a".repeat(64)}`;
  const requestBody = JSON.stringify({
    messages: [
      { role: "assistant", content: "request-secret-must-not-persist" },
      { role: "tool", tool_call_id: "call_native_1", content: "tool-secret-must-not-persist" },
    ],
    tools: [{ type: "function" }],
    records: [{ "a/b": "escaped-value" }],
  });
  const responseBody = JSON.stringify({
    id: "response-secret-must-not-persist",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "answer-secret-must-not-persist",
        tool_calls: [
          { id: "call_native_1", function: { name: "lookup", arguments: "{\"sku\":\"SKU-1\"}" } },
          { id: "call_native_2", function: { name: "shipping", arguments: "{\"zip\":\"94107\"}" } },
        ],
      },
    }],
  });
  const exchangeFacts = {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint,
    profiles: [{
      id: "chat-completion-v1",
      match: {
        method: "POST",
        paths: ["/v1/chat/completions"],
        statusCodes: [200],
      },
      requestJson: [
        {
          id: "message-roles",
          pointer: "/messages/*/role",
          maxMatches: 4,
          projection: { kind: "sha256-string", maxInputBytes: 32 },
        },
        {
          id: "tools-present",
          pointer: "/tools",
          projection: { kind: "present" },
        },
        {
          id: "missing-request-value",
          pointer: "/missing",
          projection: { kind: "present" },
        },
        {
          id: "escaped-pointer",
          pointer: "/records/*/a~1b",
          maxMatches: 2,
          projection: { kind: "sha256-string", maxInputBytes: 32 },
        },
      ],
      responseJson: [
        {
          id: "tool-call-count",
          pointer: "/choices/0/message/tool_calls",
          projection: { kind: "count", maxItems: 4 },
        },
        {
          id: "tool-call-ids",
          pointer: "/choices/0/message/tool_calls/*/id",
          maxMatches: 4,
          projection: { kind: "sha256-string", maxInputBytes: 64 },
        },
        {
          id: "finish-reason",
          pointer: "/choices/0/finish_reason",
          projection: { kind: "sha256-string", maxInputBytes: 32 },
        },
      ],
    }],
  };
  const script = String.raw`
import json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
module = runpy.run_path(os.environ["GUARDIAN_PATH"])
addon = module["addons"][0]

request = types.SimpleNamespace(
    pretty_host="api.example.com",
    path="/v1/chat/completions?query-secret=must-not-persist",
    method="post",
    scheme="https",
    headers={"content-type": "application/json"},
    content=os.environ["REQUEST_BODY"].encode("utf-8"),
)
flow = types.SimpleNamespace(id="facts", request=request, response=None)
addon.requestheaders(flow)
flow.response = Response.make(
    200,
    os.environ["RESPONSE_BODY"].encode("utf-8"),
    {"content-type": "application/json"},
)
addon.response(flow)

seal = types.SimpleNamespace(
    id="seal",
    request=types.SimpleNamespace(
        pretty_host="tae-egress-control.invalid",
        path="/__tae_egress_control__/seal",
        method="post",
        scheme="http",
        headers={"x-tae-egress-control": os.environ["TAE_EGRESS_CONTROL_TOKEN"]},
    ),
    response=None,
)
addon.requestheaders(seal)
state = json.loads(seal.response.content)
assert state["sealed"] is True
assert state["truncated"] is False
assert state["rowCount"] == 1
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      REQUEST_BODY: requestBody,
      RESPONSE_BODY: responseBody,
      TAE_EGRESS_LOG: journal,
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify({}),
      TAE_EGRESS_EXCHANGE_FACTS: JSON.stringify(exchangeFacts),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const journalText = readFileSync(journal, "utf8");
  assert.doesNotMatch(journalText, /request-secret|tool-secret|answer-secret|response-secret|query-secret|SKU-1|94107/);
  const row = JSON.parse(journalText);
  assert.deepEqual(row.exchangeFacts, {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint,
    profileId: "chat-completion-v1",
    request: {
      "message-roles": {
        state: "present",
        matches: [
          {
            pointer: "/messages/0/role",
            value: "sha256:a39a7ffad4a3013f29da97b84f264337f234c1cf9b3c40c7c30c677a8a18609a",
          },
          {
            pointer: "/messages/1/role",
            value: "sha256:7c9bbe5ec9b3fb774e8fa0f54247e93c34ddf8e5d16fe3073420de0ae81a262d",
          },
        ],
      },
      "tools-present": {
        state: "present",
        matches: [{ pointer: "/tools", value: true }],
      },
      "missing-request-value": { state: "absent" },
      "escaped-pointer": {
        state: "present",
        matches: [{
          pointer: "/records/0/a~1b",
          value: "sha256:e56ca682e8bb2d61048239968ad4f97505ae598a0b4632f2aaec69c1787df4a4",
        }],
      },
    },
    response: {
      "tool-call-count": {
        state: "present",
        matches: [{ pointer: "/choices/0/message/tool_calls", value: 2 }],
      },
      "tool-call-ids": {
        state: "present",
        matches: [
          {
            pointer: "/choices/0/message/tool_calls/0/id",
            value: "sha256:44b24011e254bf3b461552b50a44828d5a14dd4e4b31975f0915ea67d939770e",
          },
          {
            pointer: "/choices/0/message/tool_calls/1/id",
            value: "sha256:0616b9c36a5e114210697d1100edb2d95d3030688bedd574ceae777db29da85c",
          },
        ],
      },
      "finish-reason": {
        state: "present",
        matches: [{
          pointer: "/choices/0/finish_reason",
          value: "sha256:8e920ae7d06bef0e7e617974cd02be9c07cfbca65b0dbb89895394a1318b6534",
        }],
      },
    },
  });
});

test("generic E2B Guardian matches bounded whole-segment path templates", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-path-template-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "requests.jsonl");
  const policyFingerprint = `sha256:${"c".repeat(64)}`;
  const exchangeFacts = {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint,
    profiles: [{
      id: "dynamic-create-v1",
      match: {
        method: "POST",
        pathTemplates: ["/v2/projects/{segment}/endpoints"],
        statusCodes: [201],
      },
      requestJson: [],
      responseJson: [{
        id: "response-id-hash",
        pointer: "/id",
        projection: { kind: "sha256-string", maxInputBytes: 256 },
      }],
    }],
  };
  assert.deepEqual(assertExchangeFactCapturePolicy(exchangeFacts), exchangeFacts);
  const script = String.raw`
import json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]
request = types.SimpleNamespace(
    pretty_host="api.example.com",
    path="/v2/projects/project-1/endpoints?ignored=yes",
    method="post",
    scheme="https",
    headers={},
    content=None,
)
flow = types.SimpleNamespace(id="dynamic", request=request, response=None)
addon.requestheaders(flow)
flow.response = Response.make(201, b'{"id":"ep_dynamic"}', {"content-type":"application/json"})
addon.response(flow)
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: journal,
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify({}),
      TAE_EGRESS_EXCHANGE_FACTS: JSON.stringify(exchangeFacts),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(readFileSync(journal, "utf8"));
  assert.equal(row.path, "/v2/projects/project-1/endpoints");
  assert.deepEqual(row.exchangeFacts.response["response-id-hash"], {
    state: "present",
    matches: [{
      pointer: "/id",
      value: `sha256:${createHash("sha256").update("ep_dynamic").digest("hex")}`,
    }],
  });
});

test("generic E2B Guardian projects gzip JSON when only the response side is selected", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-gzip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "requests.jsonl");
  const policyFingerprint = `sha256:${"b".repeat(64)}`;
  const exchangeFacts = {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint,
    profiles: [{
      id: "gzip-response-v1",
      match: { method: "POST", paths: ["/v1/result"], statusCodes: [200] },
      requestJson: [],
      responseJson: [{
        id: "item-count",
        pointer: "/items",
        projection: { kind: "count", maxItems: 4 },
      }],
    }],
  };
  const script = String.raw`
import gzip, json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
module = runpy.run_path(os.environ["GUARDIAN_PATH"])
addon = module["addons"][0]

request = types.SimpleNamespace(
    pretty_host="api.example.com",
    path="/v1/result",
    method="post",
    scheme="https",
    headers={},
    content=None,
)
flow = types.SimpleNamespace(id="gzip", request=request, response=None)
addon.requestheaders(flow)
body = json.dumps({"items": [1, 2], "private": "gzip-secret-must-not-persist"}).encode("utf-8")
flow.response = Response.make(200, b"decoded-body-must-not-be-read", {
    "content-type": "application/problem+json; charset=utf-8",
    "content-encoding": "gzip",
})
flow.response.raw_content = gzip.compress(body)
addon.response(flow)

seal = types.SimpleNamespace(
    id="seal",
    request=types.SimpleNamespace(
        pretty_host="tae-egress-control.invalid",
        path="/__tae_egress_control__/seal",
        method="post",
        scheme="http",
        headers={"x-tae-egress-control": os.environ["TAE_EGRESS_CONTROL_TOKEN"]},
    ),
    response=None,
)
addon.requestheaders(seal)
state = json.loads(seal.response.content)
assert state["truncated"] is False
assert state["rowCount"] == 1
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: journal,
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify({}),
      TAE_EGRESS_EXCHANGE_FACTS: JSON.stringify(exchangeFacts),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const journalText = readFileSync(journal, "utf8");
  assert.doesNotMatch(journalText, /gzip-secret|decoded-body/);
  assert.deepEqual(JSON.parse(journalText).exchangeFacts, {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint,
    profileId: "gzip-response-v1",
    request: {},
    response: {
      "item-count": {
        state: "present",
        matches: [{ pointer: "/items", value: 2 }],
      },
    },
  });
});

test("generic E2B Guardian matches the language-neutral exchange-fact fixture", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-conformance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "requests.jsonl");
  const projectionCase = exchangeFactConformance.projectionCases[0];
  const exchangeFacts = {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint: exchangeFactConformance.expectedPolicyFingerprint,
    profiles: exchangeFactConformance.profiles,
  };
  const script = String.raw`
import json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]
request = types.SimpleNamespace(
    pretty_host="api.example.com",
    path="/v1/exchanges",
    method="post",
    scheme="https",
    headers={"content-type": "application/json"},
    content=os.environ["REQUEST_BODY"].encode("utf-8"),
)
flow = types.SimpleNamespace(id="conformance", request=request, response=None)
addon.requestheaders(flow)
flow.response = Response.make(
    200,
    os.environ["RESPONSE_BODY"].encode("utf-8"),
    {"content-type": "application/json"},
)
addon.response(flow)
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      REQUEST_BODY: JSON.stringify(projectionCase.requestJson),
      RESPONSE_BODY: JSON.stringify(projectionCase.responseJson),
      TAE_EGRESS_LOG: journal,
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify({}),
      TAE_EGRESS_EXCHANGE_FACTS: JSON.stringify(exchangeFacts),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(journal, "utf8")).exchangeFacts, {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint: exchangeFactConformance.expectedPolicyFingerprint,
    profileId: exchangeFactConformance.profiles[0].id,
    ...projectionCase.expected,
  });
});

test("generic E2B Guardian fails closed on unsafe matched JSON without body disclosure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-rejections-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exchangeFacts = {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint: `sha256:${"c".repeat(64)}`,
    profiles: [{
      id: "rejection-cases-v1",
      match: { method: "POST", paths: ["/v1/result"], statusCodes: [200] },
      requestJson: [],
      responseJson: [
        { id: "value-present", pointer: "/value", projection: { kind: "present" } },
        {
          id: "digest-hash",
          pointer: "/digest",
          projection: { kind: "sha256-string", maxInputBytes: 8 },
        },
        { id: "item-count", pointer: "/items", projection: { kind: "count", maxItems: 2 } },
        {
          id: "match-bound",
          pointer: "/values/*/id",
          maxMatches: 2,
          projection: { kind: "present" },
        },
      ],
    }],
  };
  const cases = [
    "duplicate-key",
    "invalid-utf8",
    "nonfinite-json",
    "invalid-unicode-string",
    "parser-recursion",
    "depth-limit",
    "node-limit",
    "unsupported-media",
    "unsupported-encoding",
    "encoded-limit",
    "decoded-limit",
    "digest-limit",
    "count-limit",
    "match-limit",
  ];
  const script = String.raw`
import gzip, json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]
case = os.environ["CASE"]
headers = {"content-type": "application/json"}
body = b"{}"
if case == "duplicate-key": body = b'{"value":"raw-secret","value":"other"}'
elif case == "invalid-utf8": body = b'{"value":"raw-secret"}' + bytes((255,))
elif case == "nonfinite-json": body = b'{"value":NaN}'
elif case == "invalid-unicode-string": body = b'{"digest":"\\ud800"}'
elif case == "parser-recursion": body = b"[" * 1000 + b'"raw-secret"' + b"]" * 1000
elif case == "depth-limit": body = b"[" * 33 + b'"raw-secret"' + b"]" * 33
elif case == "node-limit": body = b"[" + b"0," * 100000 + b'"raw-secret"]'
elif case == "unsupported-media":
    body = b"data: raw-secret"
    headers["content-type"] = "text/event-stream"
elif case == "unsupported-encoding":
    body = b'{"value":"raw-secret"}'
    headers["content-encoding"] = "br"
elif case == "encoded-limit": body = b'"' + b"x" * (1024 * 1024) + b'raw-secret"'
elif case == "decoded-limit":
    body = gzip.compress(b'"' + b"x" * (1024 * 1024) + b'raw-secret"')
    headers["content-encoding"] = "gzip"
elif case == "digest-limit": body = b'{"digest":"raw-secret-too-long"}'
elif case == "count-limit": body = b'{"items":[1,2,3],"marker":"raw-secret"}'
elif case == "match-limit": body = b'{"values":[{"id":1},{"id":2},{"id":3}],"marker":"raw-secret"}'

request = types.SimpleNamespace(
    pretty_host="api.example.com", path="/v1/result", method="post", scheme="https",
    headers={}, content=None,
)
flow = types.SimpleNamespace(id=case, request=request, response=None)
addon.requestheaders(flow)
flow.response = Response.make(200, body, headers)
flow.response.raw_content = body
addon.response(flow)

seal = types.SimpleNamespace(
    id="seal",
    request=types.SimpleNamespace(
        pretty_host="tae-egress-control.invalid",
        path="/__tae_egress_control__/seal",
        method="post",
        scheme="http",
        headers={"x-tae-egress-control": os.environ["TAE_EGRESS_CONTROL_TOKEN"]},
    ),
    response=None,
)
addon.requestheaders(seal)
state = json.loads(seal.response.content)
assert state["truncated"] is True
assert state["rowCount"] == 0
assert state["activeFlows"] == 0
print(json.dumps(state, separators=(",", ":")))
`;

  for (const name of cases) {
    const journal = join(root, `${name}.jsonl`);
    const result = spawnSync("python3", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        CASE: name,
        GUARDIAN_PATH: guardianPath.pathname,
        TAE_EGRESS_LOG: journal,
        TAE_EGRESS_CONTROL_TOKEN: "control-token",
        TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
        TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify({}),
        TAE_EGRESS_EXCHANGE_FACTS: JSON.stringify(exchangeFacts),
        TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([]),
      },
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(readFileSync(journal, "utf8"), "", name);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /raw-secret/, name);
  }
});

test("generic E2B Guardian seals one payload-free WebSocket session at close", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-generic-guardian-ws-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "requests.jsonl");
  const script = String.raw`
import json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
module = runpy.run_path(os.environ["GUARDIAN_PATH"])
addon = module["addons"][0]

request = types.SimpleNamespace(
    pretty_host="api.example.com",
    path="/v1/realtime?credential=must-not-persist",
    method="get",
    scheme="https",
    headers={"authorization": "must-not-persist"},
)
flow = types.SimpleNamespace(
    id="websocket",
    request=request,
    response=None,
    websocket=types.SimpleNamespace(messages=[]),
)
addon.requestheaders(flow)
flow.response = Response.make(101)
addon.response(flow)

status = types.SimpleNamespace(
    id="status",
    request=types.SimpleNamespace(
        pretty_host="tae-egress-control.invalid",
        path="/__tae_egress_control__/status",
        method="get",
        scheme="http",
        headers={"x-tae-egress-control": os.environ["TAE_EGRESS_CONTROL_TOKEN"]},
    ),
    response=None,
)
addon.requestheaders(status)
active = json.loads(status.response.content)
assert active["activeFlows"] == 1
assert active["rowCount"] == 0

for from_client, content in [
    (True, b"abc"),
    (False, b"reply"),
    (True, b"de"),
]:
    flow.websocket.messages.append(types.SimpleNamespace(
        from_client=from_client,
        content=content,
    ))
    addon.websocket_message(flow)

addon.websocket_end(flow)

failed = types.SimpleNamespace(
    id="failed-websocket",
    request=types.SimpleNamespace(
        pretty_host="api.example.com",
        path="/v1/realtime",
        method="get",
        scheme="https",
        headers={},
    ),
    response=None,
    websocket=types.SimpleNamespace(messages=[]),
)
addon.requestheaders(failed)
failed.response = Response.make(101)
addon.response(failed)
failed.websocket.messages.append(types.SimpleNamespace(
    from_client=True,
    content=b"partial-must-not-persist",
))
addon.websocket_message(failed)
addon.error(failed)
addon.websocket_end(failed)

seal = types.SimpleNamespace(
    id="seal",
    request=types.SimpleNamespace(
        pretty_host="tae-egress-control.invalid",
        path="/__tae_egress_control__/seal",
        method="post",
        scheme="http",
        headers={"x-tae-egress-control": os.environ["TAE_EGRESS_CONTROL_TOKEN"]},
    ),
    response=None,
)
addon.requestheaders(seal)
state = json.loads(seal.response.content)
assert state["sealed"] is True
assert state["activeFlows"] == 0
assert state["rowCount"] == 1
print(json.dumps(state, separators=(",", ":")))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: journal,
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify({}),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const rows = readFileSync(journal, "utf8");
  assert.doesNotMatch(rows, /credential|authorization|abc|reply|partial/);
  assert.deepEqual(JSON.parse(rows), {
    kind: "websocket-session",
    sequence: 0,
    observedAt: JSON.parse(rows).observedAt,
    scheme: "wss",
    host: "api.example.com",
    path: "/v1/realtime",
    statusCode: 101,
    durationMs: JSON.parse(rows).durationMs,
    framesSent: 2,
    bytesSent: 5,
    framesReceived: 1,
    bytesReceived: 5,
    selectedFields: {},
  });
});

test("generic E2B Guardian prepares a checksum-pinned Python 3.12 proxy runtime", async () => {
  const commands = [];
  let caReads = 0;
  let nextPid = 100;
  const sandbox = {
    commands: {
      async run(command, options = {}) {
        commands.push({ command, options });
        if (options.background) {
          return {
            pid: nextPid++,
            async kill() {},
          };
        }
        return {
          stdout: command.includes("socket.create_connection") ? "READY\n" : "",
          stderr: "",
          exitCode: 0,
        };
      },
      async list() {
        return [];
      },
    },
    files: {
      async write() {},
      async read(path) {
        assert.equal(path, "/home/user/.mitmproxy/mitmproxy-ca-cert.pem");
        caReads += 1;
        if (caReads === 1) throw new Error("CA material is not visible yet");
        return "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
      },
    },
    async updateNetwork() {},
    getHost(port) {
      return `guardian-${port}.example.invalid`;
    },
  };

  const guardian = createE2BGuardianController();
  const session = await guardian.prepare({
    sandbox,
    profile: "external-guardian-http-metadata-v1",
    capture: {
      mode: "network-egress-metadata-v1",
      protocols: ["https"],
      routes: [{ host: "api.example.com", selectedFields: [] }],
    },
    credentialBindings: [],
    credentialValues: {},
    surrogates: {},
  });
  assert.equal(caReads, 2);

  const install = commands.find(({ command }) => command.includes("guardian-requirements.lock"));
  assert.ok(install, "expected the Guardian proxy runtime install command");
  assert.match(install.command, /uname -m.*x86_64/);
  assert.match(install.command, /uv-x86_64-unknown-linux-gnu\.tar\.gz/);
  assert.match(install.command, /8cc1cd82d434ec565376f98bd938d4b715b5791a80ff2d3aa78821cf85091b4b/);
  assert.match(install.command, /sha256sum --check --strict/);
  assert.match(install.command, /python install '3\.12\.12'/);
  assert.match(install.command, /venv --clear --python '3\.12\.12'/);
  assert.match(install.command, /--require-hashes --no-deps --no-build/);
  assert.doesNotMatch(install.command, /python3 -m venv/);
  assert.equal(install.options.timeoutMs, 360_000);

  const workloadCommands = [];
  const workloadNetworkUpdates = [];
  const workload = {
    commands: {
      async run(command, options = {}) {
        workloadCommands.push({ command, options });
        if (options.background) {
          return {
            pid: nextPid++,
            async kill() {},
          };
        }
        return {
          stdout: command.includes("socket.create_connection") ? "READY\n" : "",
          stderr: "",
          exitCode: 0,
        };
      },
    },
    files: {
      async write() {},
    },
    async updateNetwork(network) {
      workloadNetworkUpdates.push(network);
    },
  };
  sandbox.trafficAccessToken = "fixture-traffic-token";

  await guardian.attach({ workload, sandbox, session });

  const trustInstall = workloadCommands.find(({ command }) => (
    command.includes("ssl.get_default_verify_paths")
  ));
  assert.ok(trustInstall, "expected the workload trust install command");
  assert.equal(trustInstall.command.includes('output.write(b"\\n")'), true);
  const trustPermissions = workloadCommands.find(({ command }) => (
    command.includes("seal workload trust permissions")
  ));
  assert.ok(trustPermissions, "expected workload trust permissions to be sealed");
  assert.equal(trustPermissions.options.user, "root");
  assert.match(trustPermissions.command, /os\.walk\(root\)/);
  assert.match(trustPermissions.command, /os\.chmod\(directory, 0o755\)/);
  assert.match(trustPermissions.command, /os\.chmod\(path, 0o555 if executable else 0o444\)/);
  assert.match(trustPermissions.command, /root = "\/tmp\/tae-egress"/);
  assert.equal(
    session.workloadEnvironment.TAE_EGRESS_CA_BUNDLE,
    "/tmp/tae-egress/ca-bundle.pem",
  );
  const routeInstall = workloadCommands.find(({ command }) => (
    command.includes("socket.getaddrinfo")
    && command.includes("iptables")
    && command.includes("ip6tables")
  ));
  assert.ok(routeInstall, "expected a root-owned direct-route block");
  assert.equal(routeInstall.options.user, "root");
  assert.deepEqual(JSON.parse(routeInstall.options.envs.TAE_CAPTURE_HOSTS), [
    "api.example.com",
  ]);
  assert.deepEqual(workloadNetworkUpdates, []);
});

function fakeGuardianSandboxes() {
  let nextPid = 100;
  const guardianCommands = [];
  const networkUpdates = [];
  const workloadCommands = [];
  const runner = (commands) => ({
    async run(command, options = {}) {
      commands.push({ command, options });
      if (options.background) return { pid: nextPid++, async kill() {} };
      return {
        stdout: command.includes("socket.create_connection") ? "READY\n" : "",
        stderr: "",
        exitCode: 0,
      };
    },
    async list() {
      return [];
    },
  });
  const sandbox = {
    commands: runner(guardianCommands),
    files: {
      async write() {},
      async read() {
        return "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
      },
    },
    async updateNetwork(network) {
      networkUpdates.push(network);
    },
    getHost(port) {
      return `guardian-${port}.example.invalid`;
    },
    trafficAccessToken: "fixture-traffic-token",
  };
  const workload = {
    commands: runner(workloadCommands),
    files: { async write() {} },
  };
  return { sandbox, workload, guardianCommands, networkUpdates, workloadCommands };
}

const anthropicAgentCredential = Object.freeze({
  surrogate: "sk-ant-api03-hurdle_agent_stand_in_fixture",
  value: "sk-ant-api03-real-agent-secret",
  hosts: ["api.anthropic.com"],
  headerNames: ["x-api-key", "authorization"],
});

test("generic E2B Guardian routes the Agent credential through a pass-through host", async () => {
  const fake = fakeGuardianSandboxes();
  const guardian = createE2BGuardianController();
  const session = await guardian.prepare({
    sandbox: fake.sandbox,
    profile: "external-guardian-http-metadata-v1",
    capture: {
      mode: "network-egress-metadata-v1",
      protocols: ["https"],
      routes: [{ host: "api.example.com", selectedFields: [] }],
    },
    credentialBindings: [{
      id: "credential:TARGET_KEY",
      environmentName: "TARGET_KEY",
      delivery: {
        kind: "captured-http-header",
        hosts: ["api.example.com"],
        headerNames: ["authorization"],
      },
    }],
    credentialValues: { TARGET_KEY: "real-target-secret" },
    surrogates: { TARGET_KEY: "tae_visible_target" },
    agentCredentials: [anthropicAgentCredential],
  });

  assert.deepEqual(fake.networkUpdates, [{
    allowOut: ["api.example.com", "api.anthropic.com"],
    denyOut: ["0.0.0.0/0"],
  }]);
  const proxy = fake.guardianCommands.find(({ command }) => command.includes("mitmdump -q -s"));
  assert.deepEqual(JSON.parse(proxy.options.envs.TAE_EGRESS_CAPTURE_HOSTS), ["api.example.com"]);
  assert.deepEqual(JSON.parse(proxy.options.envs.TAE_EGRESS_PASSTHROUGH_HOSTS), ["api.anthropic.com"]);
  assert.deepEqual(JSON.parse(proxy.options.envs.TAE_EGRESS_SUBSTITUTIONS), [
    {
      surrogate: "tae_visible_target",
      value: "real-target-secret",
      hosts: ["api.example.com"],
      headerNames: ["authorization"],
    },
    anthropicAgentCredential,
  ]);
  assert.deepEqual(session.hosts, ["api.example.com"]);

  await guardian.attach({ workload: fake.workload, sandbox: fake.sandbox, session });
  const relay = fake.workloadCommands.find(({ command }) => command.includes("tcp_ws_bridge.cjs client"));
  assert.deepEqual(JSON.parse(relay.options.envs.TAE_EGRESS_CAPTURE_HOSTS), [
    "api.example.com",
    "api.anthropic.com",
  ]);
  assert.deepEqual(JSON.parse(session.workloadEnvironment.TAE_EGRESS_CAPTURE_HOSTS), [
    "api.example.com",
    "api.anthropic.com",
  ]);
  assert.equal(session.workloadEnvironment.CODEX_CA_CERTIFICATE, "/tmp/tae-egress/ca-bundle.pem");
  const firewall = fake.workloadCommands.find(({ command }) => command.includes("socket.getaddrinfo"));
  assert.deepEqual(JSON.parse(firewall.options.envs.TAE_CAPTURE_HOSTS), ["api.example.com"]);
  const workloadText = JSON.stringify([
    ...fake.workloadCommands.map(({ command, options }) => ({ command, envs: options.envs })),
    session.workloadEnvironment,
  ]);
  assert.doesNotMatch(workloadText, /real-agent-secret|real-target-secret/);
});

test("generic E2B Guardian keeps a captured host on its capture route for the Agent credential", async () => {
  const fake = fakeGuardianSandboxes();
  const session = await createE2BGuardianController().prepare({
    sandbox: fake.sandbox,
    profile: "external-guardian-http-metadata-v1",
    capture: {
      mode: "network-egress-metadata-v1",
      protocols: ["https"],
      routes: [{ host: "api.anthropic.com", selectedFields: [] }],
    },
    credentialBindings: [],
    credentialValues: {},
    surrogates: {},
    agentCredentials: [anthropicAgentCredential],
  });
  const proxy = fake.guardianCommands.find(({ command }) => command.includes("mitmdump -q -s"));
  assert.deepEqual(JSON.parse(proxy.options.envs.TAE_EGRESS_PASSTHROUGH_HOSTS), []);
  assert.deepEqual(JSON.parse(proxy.options.envs.TAE_EGRESS_SUBSTITUTIONS), [anthropicAgentCredential]);
  assert.deepEqual(session.routedHosts, ["api.anthropic.com"]);
});

test("generic E2B Guardian protects the Agent credential when the Task captures nothing", async () => {
  const fake = fakeGuardianSandboxes();
  const session = await createE2BGuardianController().prepare({
    sandbox: fake.sandbox,
    profile: "external-guardian-http-metadata-v1",
    capture: { mode: "none" },
    credentialBindings: [],
    credentialValues: {},
    surrogates: {},
    agentCredentials: [anthropicAgentCredential],
  });
  assert.deepEqual(fake.networkUpdates, [{
    allowOut: ["api.anthropic.com"],
    denyOut: ["0.0.0.0/0"],
  }]);
  assert.deepEqual(session.hosts, []);
  assert.deepEqual(session.routedHosts, ["api.anthropic.com"]);
});

test("generic E2B Guardian rejects invalid or colliding Agent credential stand-ins", async () => {
  const prepare = (agentCredentials, surrogates = {}) => createE2BGuardianController().prepare({
    sandbox: fakeGuardianSandboxes().sandbox,
    profile: "external-guardian-http-metadata-v1",
    capture: {
      mode: "network-egress-metadata-v1",
      protocols: ["https"],
      routes: [{ host: "api.example.com", selectedFields: [] }],
    },
    credentialBindings: Object.keys(surrogates).map((name) => ({
      id: `credential:${name}`,
      environmentName: name,
      delivery: {
        kind: "captured-http-header",
        hosts: ["api.example.com"],
        headerNames: ["authorization"],
      },
    })),
    credentialValues: Object.fromEntries(Object.keys(surrogates).map((name) => [name, "target"])),
    surrogates,
    agentCredentials,
  });
  await assert.rejects(
    prepare([anthropicAgentCredential], { TARGET_KEY: anthropicAgentCredential.surrogate }),
    /stand-ins must be distinct/,
  );
  await assert.rejects(
    prepare([anthropicAgentCredential, { ...anthropicAgentCredential, value: "other" }]),
    /stand-ins must be distinct/,
  );
  await assert.rejects(
    prepare([{ ...anthropicAgentCredential, value: anthropicAgentCredential.surrogate }]),
    /Agent credential policy is invalid/,
  );
  await assert.rejects(
    prepare([{ ...anthropicAgentCredential, hosts: [] }]),
    /Agent credential policy is invalid/,
  );
});

test("generic E2B Guardian rejects attach without restricted public traffic", async () => {
  await assert.rejects(
    createE2BGuardianController().attach({
      workload: {},
      sandbox: {},
      session: {},
    }),
    /restricted public traffic and a traffic access token/,
  );
});

test("intercept-all Guardian forwards every host, streams and journals non-capture hosts within a non-truncating budget", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-intercept-all-guardian-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, "requests.jsonl");
  const script = String.raw`
import json, os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]

def flow(flow_id, host, path, scheme="https", port=443, headers=None):
    request = types.SimpleNamespace(pretty_host=host, path=path, method="get", scheme=scheme,
        port=port, headers=headers or {}, stream=False)
    return types.SimpleNamespace(id=flow_id, request=request, response=None)

def control(action):
    value = flow("control-" + action, "tae-egress-control.invalid", "/__tae_egress_control__/" + action,
        headers={"x-tae-egress-control": "control-token"})
    addon.requestheaders(value)
    return json.loads(value.response.content)

captured = flow("captured", "api.example.com", "/v1/models", headers={"authorization": "Bearer surrogate"})
addon.requestheaders(captured)
assert captured.request.headers["authorization"] == "Bearer real-secret"
assert captured.request.stream is False, "capture hosts keep buffered bodies for exchange facts"
captured.response = Response.make(200)
addon.response(captured)

plaintext = flow("plaintext", "api.example.com", "/v1/models", scheme="http", port=80,
    headers={"authorization": "Bearer surrogate"})
addon.requestheaders(plaintext)
assert plaintext.response.status_code == 403
assert plaintext.request.headers["authorization"] == "Bearer surrogate", "never substitute over plaintext"

model = flow("model", "api.anthropic.com", "/v1/messages?beta=true", headers={"authorization": "Bearer surrogate", "x-api-key": "agent-surrogate"})
addon.requestheaders(model)
assert model.response is None, "non-capture hosts are forwarded"
assert model.request.stream is True
assert model.request.headers["authorization"] == "Bearer surrogate", "substitutions stay scoped to their hosts"
assert model.request.headers["x-api-key"] == "real-agent-key", "agent credentials are substituted on their own host"
plain_model = flow("plain-model", "api.anthropic.com", "/v1/messages", scheme="http", port=80, headers={"x-api-key": "agent-surrogate"})
addon.requestheaders(plain_model)
assert plain_model.request.headers["x-api-key"] == "agent-surrogate", "never substitute over plaintext"
assert plain_model.response is None
model.response = types.SimpleNamespace(status_code=200, headers={}, stream=False)
addon.responseheaders(model)
assert model.response.stream is True
addon.response(model)

socket = flow("socket", "realtime.example.net", "/ws")
addon.requestheaders(socket)
socket.response = types.SimpleNamespace(status_code=101, headers={})
addon.response(socket)
socket.websocket = types.SimpleNamespace(messages=[types.SimpleNamespace(content=b"ping", from_client=True)])
addon.websocket_message(socket)
addon.websocket_end(socket)

overflow = flow("overflow", "registry.npmjs.org", "/left-pad")
addon.requestheaders(overflow)
overflow.response = types.SimpleNamespace(status_code=200, headers={}, stream=False)
addon.response(overflow)

pending = flow("pending", "registry.npmjs.org", "/pending")
addon.requestheaders(pending)
state = control("seal")
assert state["activeFlows"] == 0, "observed flows never block the capture drain"
assert state["journalDigest"].startswith("sha256:")
assert state["truncated"] is False
assert (state["rowCount"], state["observedRowCount"], state["observedDropped"]) == (3, 2, 1)
pending.response = types.SimpleNamespace(status_code=200, headers={}, stream=False)
addon.response(pending)
late = flow("late", "registry.npmjs.org", "/late")
addon.requestheaders(late)
assert late.response.status_code == 503
state = control("status")
assert (state["rowCount"], state["observedDropped"], state["truncated"]) == (3, 2, False)
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: journal,
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_INTERCEPT_ALL: "1",
      TAE_EGRESS_OBSERVED_MAX_ROWS: "2",
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([{
        surrogate: "surrogate", value: "real-secret", hosts: ["api.example.com"], headerNames: ["authorization"],
      }, {
        surrogate: "agent-surrogate", value: "real-agent-key", hosts: ["api.anthropic.com"], headerNames: ["x-api-key"],
      }]),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const contents = readFileSync(journal, "utf8");
  assert.doesNotMatch(contents, /real-secret|real-agent-key|surrogate|beta=true/);
  const rows = contents.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map(({ sequence, host, path, kind }) => [sequence, kind, host, path]), [
    [0, "http-request", "api.example.com", "/v1/models"],
    [1, "http-request", "api.anthropic.com", "/v1/messages"],
    [2, "websocket-session", "realtime.example.net", "/ws"],
  ]);
  assert.deepEqual(rows[1].selectedFields, {});
  assert.equal(rows[2].bytesSent, 4);
});

test("generic Guardian keeps rejecting non-capture hosts unless intercept-all is enabled", () => {
  const script = String.raw`
import os, runpy, sys, types
class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})
mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]
request = types.SimpleNamespace(pretty_host="api.anthropic.com", path="/v1/messages", method="POST", scheme="http", port=80, headers={})
value = types.SimpleNamespace(id="other", request=request, response=None)
addon.requestheaders(value)
assert value.response.status_code == 403
assert "observedRowCount" not in addon._state()
`;
  const root = mkdtempSync(join(tmpdir(), "tae-selective-guardian-"));
  try {
    const result = spawnSync("python3", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, GUARDIAN_PATH: guardianPath.pathname, TAE_EGRESS_LOG: join(root, "requests.jsonl"),
        TAE_EGRESS_CONTROL_TOKEN: "control-token", TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]) },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intercept-all Guardian never swaps a key into a tunnel to another host", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-intercept-all-host-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = String.raw`
import os, runpy, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]

def flow(flow_id, host_header, tunnel, headers):
    request = types.SimpleNamespace(pretty_host=host_header, host=tunnel, path="/v1/messages",
        method="post", scheme="https", port=443, headers=headers, stream=False)
    return types.SimpleNamespace(id=flow_id, request=request, response=None)

# The Agent tunnels to its own server but names the model host.
spoofed = flow("spoofed", "api.anthropic.com", "attacker.invalid", {"x-api-key": "agent-surrogate"})
addon.requestheaders(spoofed)
assert spoofed.response.status_code == 403
assert spoofed.request.headers["x-api-key"] == "agent-surrogate"

# The same trick against a capture host leaves its credential unswapped.
captured = flow("captured", "api.example.com", "attacker.invalid", {"authorization": "Bearer surrogate"})
addon.requestheaders(captured)
assert captured.request.headers["authorization"] == "Bearer surrogate"

# A stand-in sent to the Agent's own server is forwarded unchanged.
own = flow("own", "attacker.invalid", "attacker.invalid", {"x-api-key": "agent-surrogate"})
addon.requestheaders(own)
assert own.response is None
assert own.request.headers["x-api-key"] == "agent-surrogate"

# The real route still works.
model = flow("model", "api.anthropic.com", "api.anthropic.com", {"x-api-key": "agent-surrogate"})
addon.requestheaders(model)
assert model.response is None
assert model.request.headers["x-api-key"] == "real-agent-key"
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: join(root, "requests.jsonl"),
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_INTERCEPT_ALL: "1",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([
        { surrogate: "surrogate", value: "real-secret", hosts: ["api.example.com"], headerNames: ["authorization"] },
        { surrogate: "agent-surrogate", value: "real-agent-key", hosts: ["api.anthropic.com"], headerNames: ["x-api-key"] },
      ]),
    },
  });
  assert.equal(result.status, 0, result.stderr);
});
