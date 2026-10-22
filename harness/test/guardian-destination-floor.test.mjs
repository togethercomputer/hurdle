import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const guardianPath = new URL("../verify/proxy/generic_guardian.py", import.meta.url);

// Loads the addon with a stubbed mitmproxy module and a faked resolver, so the
// checks are deterministic and need no network.
const PRELUDE = String.raw`
import json, os, runpy, socket, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy

ANSWERS = {
    "api.together.ai": ["104.18.0.1"],
    "intranet.corp": ["10.0.0.5"],
    "dual.example": ["93.184.216.34", "192.168.1.1"],
    "azure.example": ["168.63.129.16"],
}
def getaddrinfo(host, port, **kwargs):
    if host not in ANSWERS:
        raise socket.gaierror("no answer")
    return [
        (socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0))
        for ip in ANSWERS[host]
    ]
socket.getaddrinfo = getaddrinfo

addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]

def flow(flow_id, host, path="/", scheme="https", port=443, headers=None):
    request = types.SimpleNamespace(pretty_host=host, path=path, method="get", scheme=scheme,
        port=port, headers=headers or {}, stream=False)
    return types.SimpleNamespace(id=flow_id, request=request, response=None)

def refused(value):
    return value.response is not None and value.response.status_code == 403
`;

function runAddon(t, script, env) {
  const root = mkdtempSync(join(tmpdir(), "tae-destination-floor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("python3", ["-c", PRELUDE + script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath.pathname,
      TAE_EGRESS_LOG: join(root, "requests.jsonl"),
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(["api.example.com"]),
      TAE_EGRESS_SUBSTITUTIONS: "[]",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

test("intercept-all Guardian refuses non-public destinations before dialing from this machine", (t) => {
  runAddon(t, String.raw`
# Literal addresses need no resolution; both the CONNECT and the absolute-form
# plaintext paths refuse them.
for host in ["169.254.169.254", "127.0.0.1", "10.0.0.5", "::1", "[::1]", "100.64.1.1", "168.63.129.16"]:
    value = flow("connect-" + host, host)
    addon.http_connect(value)
    assert refused(value), host
    value = flow("request-" + host, host, scheme="http", port=80)
    addon.requestheaders(value)
    assert refused(value), host

# A name is refused when any answer is non-public.
for host in ["intranet.corp", "dual.example", "azure.example"]:
    value = flow("connect-" + host, host)
    addon.http_connect(value)
    assert refused(value), host

# Public destinations reach the policy, and so do names that do not resolve:
# reserved control and preflight names must keep working.
for host in ["api.together.ai", "preflight.hurdle.invalid", "tae-egress-control.invalid"]:
    value = flow("connect-" + host, host)
    addon.http_connect(value)
    assert value.response is None, host
public = flow("request-public", "api.together.ai")
addon.requestheaders(public)
assert public.response is None and public.request.stream is True
`, { TAE_EGRESS_INTERCEPT_ALL: "1" });
});

test("the destination floor only applies when every host is intercepted", (t) => {
  runAddon(t, String.raw`
value = flow("connect-loopback", "127.0.0.1")
addon.http_connect(value)
assert value.response is None, "without intercept-all the proxy dials only capture hosts"
`, {});
});
