import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const guardianPath = new URL("../verify/proxy/generic_guardian.py", import.meta.url);

// Loads the addon with a stubbed mitmproxy module and a resolver the script
// can change between calls, so DNS behaviour is deterministic and offline.
const PRELUDE = String.raw`
import itertools, json, os, runpy, socket, sys, types

class Response:
    @staticmethod
    def make(status, content=b"", headers=None):
        return types.SimpleNamespace(status_code=status, content=content, headers=headers or {})

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=Response)
sys.modules["mitmproxy"] = mitmproxy

ANSWERS = {
    "api.example.com": ["104.18.0.1"],
    "api.anthropic.com": ["160.79.104.10"],
    "rebind.example": ["93.184.216.34"],
}
def getaddrinfo(host, port, **kwargs):
    if host == "boom.example":
        raise RuntimeError("unexpected resolver failure")
    if host not in ANSWERS:
        raise socket.gaierror("no answer")
    return [
        (socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0))
        for ip in ANSWERS[host]
    ]
socket.getaddrinfo = getaddrinfo

addon = runpy.run_path(os.environ["GUARDIAN_PATH"])["addons"][0]

def flow(flow_id, host_header, destination=None, scheme="https", port=443, headers=None,
         authority="", server_conn=None):
    request = types.SimpleNamespace(pretty_host=host_header, host=destination or host_header,
        path="/", method="get", scheme=scheme, port=port, headers=headers or {}, stream=False,
        authority=authority)
    return types.SimpleNamespace(id=flow_id, request=request, response=None, server_conn=server_conn)

def refused(value):
    return value.response is not None and value.response.status_code == 403

server_ids = itertools.count()
def server(address, sni=None, client="client-1"):
    return types.SimpleNamespace(
        server=types.SimpleNamespace(id=f"server-{next(server_ids)}", address=address, sni=sni, error=None),
        client=types.SimpleNamespace(id=client),
    )
`;

function runAddon(t, script, env) {
  const root = mkdtempSync(join(tmpdir(), "tae-destination-hardening-"));
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

test("intercept-all checks the real destination, not the Host header", (t) => {
  runAddon(t, String.raw`
# The audit's case: the URL names loopback, the Host header names a public IP.
spoofed = flow("spoofed", "93.184.215.14", "127.0.0.1", scheme="http", port=80)
addon.requestheaders(spoofed)
assert refused(spoofed)
# The same trick on CONNECT never dials.
tunnel = flow("tunnel", "93.184.215.14", "127.0.0.1")
addon.http_connect(tunnel)
assert refused(tunnel)
# A CONNECT to a public host on another port is refused too.
other_port = flow("other-port", "api.anthropic.com", port=8443)
addon.http_connect(other_port)
assert refused(other_port)
# The reserved preflight name is answered only when it is the real target.
fake_preflight = flow("fake-preflight", "preflight.hurdle.invalid", "127.0.0.1")
addon.http_connect(fake_preflight)
assert refused(fake_preflight)
preflight = flow("preflight", "preflight.hurdle.invalid")
addon.http_connect(preflight)
assert preflight.response.status_code == 200
# Ordinary matching requests still work.
public = flow("public", "api.anthropic.com")
addon.http_connect(public)
assert public.response is None
`, { TAE_EGRESS_INTERCEPT_ALL: "1" });
});

test("the Guardian refuses plaintext and mismatched capture requests", (t) => {
  runAddon(t, String.raw`
plaintext = flow("plaintext", "api.example.com", scheme="http", port=80)
addon.requestheaders(plaintext)
assert refused(plaintext)
mismatched = flow("mismatched", "api.example.com", "127.0.0.1")
addon.requestheaders(mismatched)
assert refused(mismatched)
captured = flow("captured", "api.example.com")
addon.requestheaders(captured)
assert captured.response is None
`, {});
});

test("every name a request carries must be its real destination", (t) => {
  runAddon(t, String.raw`
# Absolute-form inside a tunnel: an upstream that routes by the request line
# would follow evil.example, so the key must not go.
absolute = flow("absolute", "api.example.com", authority="evil.example")
addon.requestheaders(absolute)
assert refused(absolute)
# HTTP/2 prefers :authority, but a Host header naming another host is forwarded too.
second_host = flow("second-host", "api.example.com", authority="api.example.com",
    headers={"host": "evil.example"})
addon.requestheaders(second_host)
assert refused(second_host)
other_port = flow("other-port", "api.example.com", headers={"host": "api.example.com:8443"})
addon.requestheaders(other_port)
assert refused(other_port)
malformed = flow("malformed", "api.example.com", headers={"host": "api.example.com/x"})
addon.requestheaders(malformed)
assert refused(malformed)
consistent = flow("consistent", "api.example.com", authority="api.example.com:443",
    headers={"host": "API.example.com."})
addon.requestheaders(consistent)
assert consistent.response is None
`, {});
});

test("a pin lasts for the client connection, not one server connection", (t) => {
  runAddon(t, String.raw`
data = server(("api.example.com", 443))
addon.server_connect(data)
pinned = data.server
assert pinned.address == ("104.18.0.1", 443)
def tunnelled(flow_id):
    # Inside a tunnel, mitmproxy reports the pinned address as the request host.
    return flow(flow_id, "api.example.com", "104.18.0.1", server_conn=pinned)
first = tunnelled("first")
addon.requestheaders(first)
assert first.response is None

# The upstream closes; the next request in the tunnel reconnects to the pinned
# address and keeps the tunnel's SNI, while its flows still name the first
# server connection.
getattr(addon, "server_disconnected", lambda data: None)(data)
reconnect = server(("104.18.0.1", 443), sni="api.example.com")
addon.server_connect(reconnect)
assert reconnect.server.error is None
assert reconnect.server.address == ("104.18.0.1", 443)
assert reconnect.server.sni == "api.example.com"
second = tunnelled("second")
addon.requestheaders(second)
assert second.response is None

# Another client's disconnect leaves it alone; its own ends the pin.
addon.client_disconnected(types.SimpleNamespace(id="client-2"))
third = tunnelled("third")
addon.requestheaders(third)
assert third.response is None
addon.client_disconnected(types.SimpleNamespace(id="client-1"))
after = tunnelled("after")
addon.requestheaders(after)
assert refused(after)

# A connection that fails to connect drops its pin at once.
failed = server(("api.example.com", 443), client="client-3")
addon.server_connect(failed)
addon.server_connect_error(failed)
orphan = flow("orphan", "api.example.com", "104.18.0.1", server_conn=failed.server)
addon.requestheaders(orphan)
assert refused(orphan)
`, {});
});

test("a check that fails unexpectedly refuses instead of letting traffic through", (t) => {
  runAddon(t, String.raw`
data = server(("boom.example", 443))
addon.server_connect(data)
assert data.server.error == "destination check failed"
tunnel = flow("boom-connect", "boom.example")
addon.http_connect(tunnel)
assert refused(tunnel) and tunnel.response.content == b"guardian check failed"
request = flow("boom-request", "boom.example")
addon.requestheaders(request)
assert refused(request) and request.request.stream is False
`, { TAE_EGRESS_INTERCEPT_ALL: "1" });
  runAddon(t, String.raw`
def fail(flow, host):
    raise RuntimeError("unexpected")
addon._substitute = fail
captured = flow("captured", "api.example.com")
addon.requestheaders(captured)
assert refused(captured) and addon.active == 0
`, {});
});

test("server_connect pins the checked address and refuses non-public answers", (t) => {
  runAddon(t, String.raw`
# A public name is pinned to the address that was checked; TLS keeps the name.
data = server(("api.anthropic.com", 443))
addon.server_connect(data)
assert data.server.error is None
assert data.server.address == ("160.79.104.10", 443)
assert data.server.sni == "api.anthropic.com"
# Upstream TLS verifies the checked name, never the client's SNI.
data = server(("api.anthropic.com", 443), sni="evil.example")
addon.server_connect(data)
assert data.server.sni == "api.anthropic.com"
# The resolver's order is kept: its first answer is the one dialled.
ANSWERS["ordered.example"] = ["160.79.104.20", "160.79.104.10", "2606:4700::1"]
data = server(("ordered.example", 443))
addon.server_connect(data)
assert data.server.address == ("160.79.104.20", 443)

# DNS rebinding: public when the request was checked, private at connect time.
early = flow("rebind", "rebind.example")
addon.http_connect(early)
assert early.response is None
ANSWERS["rebind.example"] = ["127.0.0.1"]
data = server(("rebind.example", 443))
addon.server_connect(data)
assert data.server.error == "destination is not a public address"
# A mixed answer is refused as a whole.
ANSWERS["rebind.example"] = ["93.184.216.34", "10.0.0.5"]
data = server(("rebind.example", 443))
addon.server_connect(data)
assert data.server.error == "destination is not a public address"

# Literal addresses: private ones are refused, public ones kept without SNI.
# IPv6 forms that carry an IPv4 address (NAT64, mapped, compatible, 6to4) are
# judged by that address; local-use NAT64 is never public.
for literal in ["127.0.0.1", "169.254.169.254", "::1", "64:ff9b::7f00:1", "64:ff9b::c0a8:101",
                "64:ff9b::a9fe:a9fe", "64:ff9b:1::5db8:d70e", "::ffff:10.0.0.5", "::7f00:1",
                "2002:c0a8:101::1"]:
    data = server((literal, 443))
    addon.server_connect(data)
    assert data.server.error == "destination is not a public address", literal
ANSWERS["dns64.example"] = ["64:ff9b::a9fe:a9fe"]
data = server(("dns64.example", 443))
addon.server_connect(data)
assert data.server.error == "destination is not a public address"
# NAT64 to a public IPv4 address still works on an IPv6-only network.
data = server(("64:ff9b::5db8:d70e", 443))
addon.server_connect(data)
assert data.server.error is None
data = server(("93.184.216.34", 443))
addon.server_connect(data)
assert data.server.error is None and data.server.address == ("93.184.216.34", 443)
assert data.server.sni is None

# A name that does not resolve is not dialled.
data = server(("unknown.invalid", 443))
addon.server_connect(data)
assert data.server.error == "destination did not resolve"
`, { TAE_EGRESS_INTERCEPT_ALL: "1" });
});
