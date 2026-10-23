# Sandbox Lite: the in-sandbox server and its wire protocol

The experimental single-connection sandbox API (`GET /v1/compute/experimental/run`)
hands a client one WebSocket per sandbox. Bartender relays that socket, byte for
byte, to a server started inside the sandbox. This document is the contract that
server, Bartender, and the Hurdle client build against, and the properties the
server must have for the design to hold.

Decision for the first release: the server runs **inside** the sandbox. It is
written so that moving it onto the node, inside runsb, is a relocation of the same
code (see §8), which is the shape the follow-on service wants.

## 1. The property, and the three things that give it

The property: **nothing but the one authenticated connection can ever talk to the
sandbox, and nothing the agent does can tamper with what the connection carries.**
Two halves live in runsb (§6): `disable_internet_access` refuses connections the
sandbox initiates, and the inbound network policy refuses connections made *to* it
through its URL — which matters because the egress block alone lets replies to an
inbound connection flow, so any port the agent listened on would otherwise be a
tunnel around the Guardian. The server supplies the rest with three behaviours.
They are not optional.

1. **Accept one connection, then close the relay listener.** Bartender connects
   before the agent exists (the agent is started only after `hello`). Once the
   listener is closed there is nothing for the agent to `connect(127.0.0.1:18083)`
   to, and nothing for anyone outside either. Keep the listener only until the
   first upgrade succeeds; refuse a second upgrade during that window.
2. **Run as root; start the agent as a non-root user with `no_new_privs`.** The
   agent then cannot kill, ptrace, or read the server, so the control channel and
   stdio it carries are evidence the agent cannot forge.
3. **No secrets in argv, and none in the environment the agent inherits.** With
   (1) the server needs no token at all. Everything it is told arrives on the
   connection.

The egress proxy listener (§4.4) is different: it stays open on loopback for the
sandbox's lifetime, because the agent is meant to reach it. Only the relay listener
closes.

## 2. Transport

One WebSocket. Binary frame payloads concatenate into a single byte stream, over
which both ends run **yamux** (hashicorp/yamux wire format, version 0). Text frames
are a protocol error: close with 1011.

- The Hurdle client is the yamux client (odd stream ids). The server is the yamux
  server (even ids). Either side may open streams; the protocol needs both.
- Keepalive: yamux pings, 30 s interval, both directions.
- Limits: 1 MiB per WebSocket frame; 256 KiB stream window; at most 32 concurrent
  streams. A peer that exceeds them is closed with 4413 (frame) or 1011.

The byte stream is the unit, not the WebSocket message. A relay may fragment or
coalesce messages, so each end must reassemble yamux frames from the bytes it
receives rather than assume a message holds whole frames. A peer-opened stream is
acknowledged on arrival (the reference implementation's behaviour; hashicorp/yamux
closes the whole session when an ACK is late), and each side closes a stream it
has finished reading once the peer's FIN arrives.

Transport library note: the Node side uses `yamux-js`, with the client itself
doing the frame reassembly and the on-arrival acknowledgement above, since the
library does neither; the Go side should use `hashicorp/yamux`, which does both,
and should treat EOF on the socket as a normal peer close. The two were verified
to interoperate (stream ids, FIN, window updates on a multi-megabyte transfer, 20
concurrent streams, keepalives both ways). The frame format is small enough that
either side can carry its own implementation if a library proves unsound.

## 3. The upgrade

The client sends:

```
GET /v1/compute/experimental/run HTTP/1.1
Authorization: Bearer <platform API key>
X-Sandbox-CA: <base64 of the DER of one X.509 CA certificate>
```

`Authorization` is consumed by Bartender and never reaches the sandbox.
`X-Sandbox-CA` is forwarded to the server unchanged. The value is **base64 DER**,
not PEM: header values cannot carry newlines. The server must refuse the connection
(close 1011 before any stream) unless the value decodes to exactly one certificate
with no private key, at most 8 KiB.

Request failures (bad key, no snapshot, capacity, the sandbox never accepting) are
plain HTTP responses from Bartender before the upgrade: 401, 403, 502, 503. Once
the 101 is sent, every failure is a WebSocket close.

## 4. Streams

### 4.1 Stream 1: control (client-opened, newline-delimited JSON, UTF-8)

Each line is one object with a `type`. Lines over 64 KiB are a protocol error.

Client → server, first message, exactly once:

```jsonc
{"type":"hello","v":1,
 "env":{"ANTHROPIC_API_KEY":"sk-ant-api03-<surrogate>","AGENT_FLAG":"on"},
 "files":[{"path":"input/data.txt","sha256":"sha256:<hex>","content":"<base64>"}]}
```

- `env`: the agent's environment. It carries surrogates, never real credentials;
  the client's own Guardian substitutes them on egress. The server merges it over
  its own base environment (§4.5). It must not contain host locators (`PATH`,
  `HOME`, …) and the server should not honour them if it does.
- `files`: workspace inputs, written before the agent starts. `path` is relative,
  no `..`, no absolute paths, no backslashes. `sha256` is `sha256:<hex>` of the
  decoded content; the server verifies it and refuses the run on mismatch. Total
  decoded size at most **4 MiB**. Files are written as the agent user.

Server → client:

```jsonc
{"type":"ready","stdout":2,"stderr":4}          // after files are written and the agent is started
{"type":"exit","code":0,"signal":null,"timedOut":false,"quiescent":true}
{"type":"error","code":"<short-code>","message":"…"}   // a failure before exit; the connection then closes
```

`exit.code` is the agent's exit status (`null` with a `signal` when killed).
`timedOut` is true when the server stopped the agent at the lifetime cap.
`quiescent` is true when no agent process remains.

### 4.2 Streams 2 and 4: stdout and stderr (server-opened)

Opened immediately after `ready`, in that order, so they receive ids 2 and 4. Raw
bytes of the agent's stdout and stderr, server → client only. Each is closed with a
FIN when the agent's corresponding descriptor closes. The client never writes to
them. (Stdin is not provided in this version; the agent's stdin is `/dev/null`.)

### 4.3 Egress streams (server-opened, one per agent connection)

Every TCP connection the agent makes to the proxy (§4.4) becomes one yamux stream.
The stream's first bytes are the agent's own proxy request, **verbatim**:

```
CONNECT api.together.ai:443 HTTP/1.1\r\n
Host: api.together.ai:443\r\n
\r\n
```

or an absolute-form plaintext request (`GET http://host/path HTTP/1.1 …`). The
server does not answer the request itself, parse beyond finding the end of the
headers, or inspect what follows; it pumps bytes both ways. The reply the client's
Guardian produces (`HTTP/1.1 200 Connection established`, then the agent's TLS)
flows back on the same stream to the agent. A FIN on one side ends only that
direction, so a response that follows the agent's EOF still drains.

Bounds: the header block must end within 16 KiB and 10 s, or the connection is
refused with `400` to the agent and the stream is not opened.

The server performs **no destination filtering**. There is no direct path; every
destination goes to the client, whose Guardian decides. (The client applies its own
non-public-address floor there.)

### 4.4 The proxy listener

`127.0.0.1:18082`, loopback only, HTTP CONNECT and absolute-form. The agent reaches
it through `HTTPS_PROXY`/`HTTP_PROXY` and the fetch bootstrap (§4.5). Stays open for
the sandbox's lifetime.

### 4.5 Starting the agent

After `files` are written and the proxy listener is up:

- Install the CA from `X-Sandbox-CA` into a root-owned, read-only bundle, and also
  into the system trust store (`update-ca-certificates`): git and Rust TLS stacks
  ignore the bundle variables.
- Environment, in increasing precedence: the image's base; `HTTPS_PROXY`/`HTTP_PROXY`
  = `http://127.0.0.1:18082`, `NO_PROXY=localhost,127.0.0.1,::1`, `SSL_CERT_FILE`,
  `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT`,
  `NODE_EXTRA_CA_CERTS` pointing at the bundle, `NODE_OPTIONS=--require <fetch
  bootstrap>` (Node's native fetch ignores proxy variables); then `hello.env`.
- Exec the image's agent command (configured on the server's argv — it is not a
  secret) as the non-root agent user, `no_new_privs`, cwd = the workspace, stdin
  `/dev/null`, stdout/stderr to streams 2/4.
- Send `ready`.

### 4.6 Ending

When the agent exits: send `exit`, FIN streams 2 and 4, give open egress streams up
to 5 s to drain, then send a yamux GoAway and close the WebSocket with 1000.
Bartender terminates the sandbox when either side closes; the client may also
close first, which is equally final.

Close codes the client should expect: `1000` normal · `4408` lifetime cap ·
`4413` frame over 1 MiB · `1011` protocol error or internal failure.

## 5. What the server is started with

Bartender starts it through Pint, after the sandbox is running, as a configured
command: for example `hurdle-server --relay-port 18083 --proxy-port 18082
--agent-user agent --workspace /home/agent/workspace --exec claude -p …`. Every
argument is non-secret and may appear in `/proc/*/cmdline`. The server must not
accept a token, key, or credential by argv or environment; it has no need for one.

## 6. Bartender

- Launch Hurdle sandboxes with `disable_internet_access: true` in the runsb spec.
- Launch with `experimental.network_policy = {inbound_allowlist: [{ports:
  ["18083"], requires_token: true}]}` and send `X-Sandbox-Token` on the upstream
  hop. The policy is enforced on runsb's Host-routed proxy, which is the preview
  URL path; Bartender's hop to the server rides that path, hence the one admitted
  port. Every other port is denied, which is what stops the agent from turning a
  preview URL into an inbound channel that bypasses the Guardian — the egress
  block does not cover that, since replies to inbound connections flow. The token
  additionally covers the window before the server's listener closes. runsb strips
  the header before forwarding; the server never sees it. (Once the server moves
  onto the node, §8, the allowlist becomes empty: nothing is reachable by URL.)
- A node in forwarding network mode refuses a policy with 400: treat it as a
  placement miss and choose another node.
- Forward `X-Sandbox-CA` as received, bounded to 8 KiB; reject larger with 400.
- The upstream hop should be TLS where the node offers it; it carries stdio and
  control in the clear otherwise.
- Keep: no termination policy, `snapshot: nil` on terminate, terminate on either
  close, and the ttl as a backstop.

## 7. The Hurdle client

`harness/lib/sandbox-lite-client.mjs` implements §2–§4 as the client. It sends
`?image=<digest>`, which Bartender currently ignores (every connection boots the
project's `hurdle` snapshot); that is fine for a single-image release.

## 8. Moving onto the node (the follow-on)

Write the server as a Go package whose two dependencies are interfaces: *run a
process and hand me its stdio and exit status*, and *write these files*. Inside the
sandbox they are local syscalls. Inside runsb they are Pint's exec and fs APIs,
which already exist and are already authenticated. The relocation then adds:

- a WebSocket endpoint on runsb's agent API, reached by Bartender with the bearer
  it already holds — no sandbox token, no inbound policy needed;
- the proxy listener bound on the sandbox's gateway address, per slot, so the
  sandbox's only reachable address is the proxy;
- one INPUT rule admitting the sandbox's veth to that port, beside the existing
  egress REJECT.

Nothing in the sandbox then needs starting but the agent, and §1's three
behaviours become properties of the node rather than conditions on a process.

## 9. The test that has to exist

One end-to-end test, run against a real sandbox: a Hurdle sandbox cannot open an
outbound connection; a second upgrade to its relay port is refused once the first
has succeeded; the agent cannot connect to the relay port; the real credential
never appears in anything the sandbox receives. That test is what gives this
property an owner.
