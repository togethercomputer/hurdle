# The Together Hurdle socket

Together's Hurdle API, `GET /v1/compute/experimental/run`, upgrades one
authenticated request to a WebSocket and boots a sandbox from Together's Hurdle
image for it. Hurdle gets that socket and nothing else. This page is the contract
between the three parties: the controller on your machine, the server inside the
sandbox, and Together's relay between them.

## What holds

The sandbox cannot be reached or reach anything except through the one socket.
Three facts give that, and they are enforced by different parties:

- **The node refuses everything the sandbox initiates** (`disable_internet_access`),
  DNS included. Replies to connections made *to* the sandbox still flow, which is
  why the next fact matters.
- **The node admits inbound connections only to the server's port, with a token**
  (the inbound allowlist). Any other port the Agent listens on is unreachable, so
  nothing can be tunnelled in around the Guardian. The token is Together's; Hurdle
  never sees it, and the node strips it before the request reaches the sandbox.
- **The server accepts one authenticated connection.** It runs as root and
  starts the Agent as a separate user with `no_new_privs`, so the Agent
  can neither reach the server's socket nor tamper with the process that owns it.
  It checks a per-sandbox controller token before accepting the connection or
  writing the Guardian CA. The server removes the token from its environment
  before starting any child process.

The Guardian on your machine keeps the real Agent and Suite credentials, and
the Agent receives only stand-ins. The Guardian swaps the Suite's
`api.authorizationCredential` into the `Authorization` header of HTTPS requests
to the Suite's `api.hosts`, whatever the Task's checks. A credential with no API
hosts to carry it is refused before any sandbox is allocated.

## The upgrade

```
GET /v1/compute/experimental/run
Authorization: Bearer <TOGETHER_API_KEY>
X-Sandbox-CA: <base64 body of the Guardian CA's PEM>
```

Together's relay consumes the API key. For each sandbox, it generates a fresh
32-byte random token encoded as unpadded base64url. It supplies that value as
`HURDLE_SANDBOX_CONTROL_TOKEN` in the root server's launch environment and
replaces `Authorization` with `Bearer <that token>` on the sandbox-bound
upgrade. The token stays on the relay-to-sandbox hop. The server refuses to start
without it and returns 401 on unauthenticated upgrades before processing
`X-Sandbox-CA`. A second authenticated connection gets 409.
The authenticated relay forwards `X-Sandbox-CA` unchanged. The sandbox accepts a
single valid CA certificate and installs it into its trust stores during setup.

Failures before the upgrade are plain HTTP. The public API returns 401 or 403
for the API key, 502 when the sandbox never accepted, and 503 when Together has
no capacity or image. After the 101, transport failures close the WebSocket.

Hurdle connects to `wss://hurdle.us.codesandbox.io/v1/compute/experimental/run`;
`HURDLE_TOGETHER_RUN_URL` points it at another control plane.

## The wire

Binary WebSocket frames concatenate into one byte stream carrying a yamux session
(hashicorp wire format, version 0). Hurdle is the yamux client, so its streams
have odd ids; the server's have even ids. Frames are reassembled from the byte
stream, so a relay may fragment or coalesce messages. Each stream has its own
256 KiB window: a reader that stops holds back only its own sender, and the
sandbox buffers at most one window per stream.

**Control.** The first stream Hurdle opens carries one JSON object per line each
way. Hurdle asks for work by op, and names the streams it has already opened to
carry the bytes:

```jsonc
{"op":"run",   "id":1, "job":{"kind":"setup", ...}, "stdout":3, "stderr":5}
{"op":"write", "id":2, "path":"/tmp/hurdle-task/inputs/fixture-0", "stream":7}
{"op":"read",  "id":3, "path":"/home/user/.tae-controller/sealed-artifacts/0", "stream":9}
```

The server answers each with `{"op":"done","id",value}` or
`{"op":"error","id","message"}`. For `run` it writes the step's output to the two
named streams and ends them when the step ends; for `write` Hurdle ends the stream
after the file's bytes; for `read` the server does. A step's `job.kind` is one of
`setup`, `stage`, `agent`, `collect`, `metadata`. Writes are confined to the task
root and reads to the sealed artifact root; anything else is refused.

**Egress.** Every stream the server opens is one TCP connection the Agent made to
the sandbox's loopback proxy port, carried verbatim: its first bytes are the
Agent's own `CONNECT host:443 HTTP/1.1` or absolute-form request. Hurdle pipes
each into the Guardian on your machine, which answers the CONNECT and intercepts
the TLS inside it. The server does no filtering; there is no other way out, and
the Guardian decides. The Guardian refuses non-public destinations, so the Agent
cannot reach your machine's loopback or network through it.

**Ending.** Closing the socket from either side terminates the sandbox. Hurdle
closes it after the last step; Together terminates the sandbox when either side
closes, and a one-hour ttl is the backstop.

## What Together runs

Together builds its Hurdle image from the context
`npm run together:image-context -- DIR` writes: the pinned Agent CLIs, the
harness modules the server loads, and the Agent's Node runtime, under
`/opt/hurdle`. Roll out relay token provisioning before switching to an image
that requires the token. Together runs
`node /opt/hurdle/harness/bin/hurdle-sandbox-server.mjs` as root once the sandbox
is running, with the sandbox launched as above and the egress proxy on
`127.0.0.1:18082`. The server listens on 18083, which is the one admitted port.

Everything else about a run, including the Guardian, capture, request blocking
and credential substitution, is as described in
[sandbox setup](./sandbox-setup.md#together-sandbox).
