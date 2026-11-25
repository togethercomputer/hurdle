import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const guardianPath = new URL("../verify/proxy/generic_guardian.py", import.meta.url);

const REAL = "tgp_v1_REAL_VALUE_0123456789abcdef";
const STAND_IN = "tae_surrogate_STANDIN_9876543210";

// Loads the addon with a stubbed mitmproxy whose Headers keep raw fields and
// whose Response decodes content, like mitmproxy's own.
const PRELUDE = String.raw`
import json, os, random, runpy, sys, types

class Headers(dict):
    def __init__(self, items=None):
        super().__init__()
        for name, value in (items or {}).items():
            self[name] = value
    @property
    def fields(self):
        return tuple((k.encode(), v.encode()) for k, v in self.items())
    @fields.setter
    def fields(self, value):
        self.clear()
        for name, raw in value:
            self[name.decode()] = raw.decode()

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=Headers(headers), stream=False)

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy
module = runpy.run_path(os.environ["GUARDIAN_PATH"])
addon = module["addons"][0]
Scrubber = module["_ResponseScrubber"]
REAL, STAND_IN = os.environ["REAL"], os.environ["STAND_IN"]

def flow(flow_id, host, headers):
    request = types.SimpleNamespace(pretty_host=host, host=host, path="/v1/models", method="get",
        scheme="https", port=443, headers=Headers(headers), stream=False, authority="")
    return types.SimpleNamespace(id=flow_id, request=request, response=None, server_conn=None)
`;

function runAddon(t, script, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "tae-response-scrub-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("python3", ["-c", PRELUDE + script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: join(root, "requests.jsonl"),
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_PASSTHROUGH_HOSTS: JSON.stringify(["api.model.example"]),
      TAE_EGRESS_SUBSTITUTIONS: JSON.stringify([
        { surrogate: STAND_IN, value: REAL, hosts: ["api.example.com", "api.model.example"], headerNames: ["authorization", "x-api-key"] },
      ]),
      REAL,
      STAND_IN,
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

test("only a whole stand-in, bare or as one Bearer credential, is swapped", (t) => {
  runAddon(t, String.raw`
cases = {
    STAND_IN: REAL,
    "Bearer " + STAND_IN: "Bearer " + REAL,
    "bearer " + STAND_IN: "bearer " + REAL,
    "Bearer x" + STAND_IN: None,
    "Bearer " + STAND_IN + " extra": None,
    STAND_IN + "," + STAND_IN: None,
    "Basic " + STAND_IN: None,
    "token=" + STAND_IN: None,
}
for index, (sent, expected) in enumerate(cases.items()):
    f = flow(f"case-{index}", "api.example.com", {"authorization": sent})
    addon.requestheaders(f)
    assert f.response is None, sent
    assert f.request.headers["authorization"] == (expected or sent), sent
    swapped = expected is not None
    assert (f.request.headers.get("accept-encoding") == "identity") == swapped, sent
`);
});

test("a real value split across chunks never leaves the Guardian", (t) => {
  runAddon(t, String.raw`
rng = random.Random(7)
body = ("data: " + REAL + "\n\nfiller " * 20 + REAL + " end s").encode()
expected = body.replace(REAL.encode(), STAND_IN.encode())
for trial in range(300):
    scrubber = Scrubber({REAL.encode(): STAND_IN.encode()})
    cuts = sorted(rng.sample(range(1, len(body)), rng.randint(1, 12)))
    pieces = [body[a:b] for a, b in zip([0] + cuts, cuts + [len(body)])]
    out = [scrubber(piece) for piece in pieces] + [scrubber(b"")]
    assert all(REAL.encode() not in chunk for chunk in out), trial
    assert b"".join(out) == expected, trial
# Ordinary text is not held back.
scrubber = Scrubber({REAL.encode(): STAND_IN.encode()})
assert scrubber(b"hello\n\n") == b"hello\n\n"
`);
});

test("responses to a swapped request get the stand-in back in headers and bodies", (t) => {
  runAddon(t, String.raw`
# A buffered capture route: header and body echoes are scrubbed in response().
captured = flow("captured", "api.example.com", {"authorization": "Bearer " + STAND_IN})
addon.requestheaders(captured)
captured.response = Response.make(400, ("invalid key: Bearer " + REAL).encode(), {"x-echo": REAL, "content-type": "text/plain"})
addon.responseheaders(captured)
assert captured.response.headers["x-echo"] == STAND_IN
addon.response(captured)
assert captured.response.content == ("invalid key: Bearer " + STAND_IN).encode()

# A streamed pass-through route is scrubbed chunk by chunk.
model = flow("model", "api.model.example", {"x-api-key": STAND_IN})
addon.requestheaders(model)
model.response = Response.make(200, b"", {"content-type": "text/event-stream"})
addon.responseheaders(model)
assert callable(model.response.stream)
assert model.response.stream(REAL.encode()[:10]) + model.response.stream(REAL.encode()[10:]) + model.response.stream(b"") == STAND_IN.encode()
addon.response(model)

# A compressed stream cannot be scrubbed per chunk: it is buffered, then scrubbed whole.
gz = flow("gz", "api.model.example", {"x-api-key": STAND_IN})
addon.requestheaders(gz)
gz.response = Response.make(200, REAL.encode(), {"content-encoding": "gzip"})
addon.responseheaders(gz)
assert gz.response.stream is False
addon.response(gz)
assert gz.response.content == STAND_IN.encode()

# Server WebSocket messages are scrubbed; the Agent's own are not touched.
ws = flow("ws", "api.model.example", {"authorization": "Bearer " + STAND_IN})
addon.requestheaders(ws)
ws.response = Response.make(101)
addon.responseheaders(ws)
addon.response(ws)
server = types.SimpleNamespace(from_client=False, content=("hello " + REAL).encode())
ws.websocket = types.SimpleNamespace(messages=[server])
addon.websocket_message(ws)
assert server.content == ("hello " + STAND_IN).encode()
client = types.SimpleNamespace(from_client=True, content=("mine " + REAL).encode())
ws.websocket.messages.append(client)
addon.websocket_message(ws)
assert client.content == ("mine " + REAL).encode()
addon.websocket_end(ws)
assert "ws" not in addon._scrub

# Without a swap nothing changes: streams pass through untouched.
plain = flow("plain", "api.model.example", {"x-api-key": "not-a-stand-in"})
addon.requestheaders(plain)
assert "accept-encoding" not in plain.request.headers
plain.response = Response.make(200, b"", {"content-type": "text/event-stream"})
addon.responseheaders(plain)
assert plain.response.stream is True
assert addon._scrub == {}
`);
});
