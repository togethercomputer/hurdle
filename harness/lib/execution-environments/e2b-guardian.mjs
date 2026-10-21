import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../run-model.mjs";

const CAPTURE_ROOT = "/tmp/tae-egress";
const PROXY_PATH = `${CAPTURE_ROOT}/generic_guardian.py`;
const LOG_PATH = `${CAPTURE_ROOT}/requests.jsonl`;
const CA_PATH = `${CAPTURE_ROOT}/guardian-ca.pem`;
export const CA_BUNDLE_PATH = `${CAPTURE_ROOT}/ca-bundle.pem`;
const PYTHON_ROOT = `${CAPTURE_ROOT}/python`;
const NODE_ROOT = `${CAPTURE_ROOT}/node`;
const NODE_BOOTSTRAP_PATH = `${NODE_ROOT}/node_proxy_bootstrap.cjs`;
export const BRIDGE_PATH = `${NODE_ROOT}/tcp_ws_bridge.cjs`;
const PROXY_PORT = 18080;
const BRIDGE_PORT = 18081;
export const RELAY_PORT = 18082;
export const CONTROL_HOST = "tae-egress-control.invalid";
export const CONTROL_PREFIX = "/__tae_egress_control__";
export const PROCESS_TIMEOUT_MS = 86_400_000;
export const MAX_CAPTURE_ROWS = 10_000;
export const MAX_CAPTURE_BYTES = 15 * 1024 * 1024;
const MAX_CAPTURE_PATH_BYTES = 4096;
const UV_VERSION = "0.11.31";
const UV_LINUX_ARCHIVE = "uv-x86_64-unknown-linux-gnu.tar.gz";
const UV_LINUX_SHA256 = "8cc1cd82d434ec565376f98bd938d4b715b5791a80ff2d3aa78821cf85091b4b";
const UV_ARCHIVE_PATH = `${CAPTURE_ROOT}/${UV_LINUX_ARCHIVE}`;
const UV_PATH = `${CAPTURE_ROOT}/uv`;
const MITMPROXY_PYTHON = "3.12.12";

export const asset = (...parts) => join(import.meta.dirname, "..", "..", "verify", "proxy", ...parts);
const GENERIC_PROXY = readFileSync(asset("generic_guardian.py"), "utf8");
const NODE_BOOTSTRAP = readFileSync(asset("node_proxy_bootstrap.cjs"), "utf8");
const PYTHON_BOOTSTRAP = readFileSync(asset("python_proxy_bootstrap.py"), "utf8");
const BRIDGE = readFileSync(asset("tcp_ws_bridge.cjs"), "utf8");
const REQUIREMENTS = readFileSync(asset("guardian-requirements.lock"), "utf8");
const AGENT_NODE_PACKAGE = readFileSync(asset("agent-node-runtime", "package.json"), "utf8");
const AGENT_NODE_LOCK = readFileSync(asset("agent-node-runtime", "package-lock.json"), "utf8");
const GUARDIAN_NODE_PACKAGE = readFileSync(asset("guardian-node-runtime", "package.json"), "utf8");
const GUARDIAN_NODE_LOCK = readFileSync(asset("guardian-node-runtime", "package-lock.json"), "utf8");

const EXCHANGE_FACT_PROFILE = "bounded-json-exchange-facts-v1";
const SENSITIVE_POINTER_TERMS = Object.freeze([
  "answer",
  "authorization",
  "content",
  "cookie",
  "embedding",
  "input",
  "output",
  "password",
  "prompt",
  "reasoning",
  "secret",
  "text",
  "token",
]);

function hasExactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => allowed.has(key));
}

function validId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(value);
}

function decodedPointerSegments(pointer) {
  if (
    typeof pointer !== "string"
    || !pointer.startsWith("/")
    || Buffer.byteLength(pointer) > 256
  ) return null;
  const segments = pointer.slice(1).split("/");
  if (segments.length > 16) return null;
  const decoded = [];
  for (const segment of segments) {
    if (/(?:~(?![01]))|~$/.test(segment)) return null;
    decoded.push(segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return decoded.filter((segment) => segment === "*").length <= 2 ? decoded : null;
}

function validSelector(selector) {
  if (!hasExactKeys(selector, ["id", "pointer", "projection"], ["maxMatches"])) {
    return false;
  }
  if (!validId(selector.id)) return false;
  const segments = decodedPointerSegments(selector.pointer);
  if (!segments) return false;
  const wildcards = segments.filter((segment) => segment === "*").length;
  if (
    (wildcards > 0 && (
      !Number.isSafeInteger(selector.maxMatches)
      || selector.maxMatches < 1
      || selector.maxMatches > 32
    ))
    || (wildcards === 0 && selector.maxMatches !== undefined)
  ) return false;
  const sensitive = segments.some((segment) => {
    if (segment === "*") return false;
    const normalized = segment.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    return SENSITIVE_POINTER_TERMS.some((term) => normalized.includes(
      term.replaceAll(/[^a-z0-9]/gu, ""),
    ));
  });
  if (sensitive) return false;
  const projection = selector.projection;
  if (hasExactKeys(projection, ["kind"]) && projection.kind === "present") return true;
  if (
    hasExactKeys(projection, ["kind", "maxItems"])
    && projection.kind === "count"
    && Number.isSafeInteger(projection.maxItems)
    && projection.maxItems >= 0
    && projection.maxItems <= 4_096
  ) return true;
  if (
    hasExactKeys(projection, ["kind", "maxInputBytes"])
    && projection.kind === "sha256-string"
    && Number.isSafeInteger(projection.maxInputBytes)
    && projection.maxInputBytes >= 1
    && projection.maxInputBytes <= 64 * 1024
  ) return true;
  return false;
}

const PATH_SEGMENT_TEMPLATE = "{segment}";

function validPathTemplate(template) {
  if (
    typeof template !== "string"
    || !template.startsWith("/")
    || template.includes("?")
    || template.includes("#")
    || Buffer.byteLength(template) > MAX_CAPTURE_PATH_BYTES
  ) return false;
  const segments = template.split("/").slice(1);
  const placeholders = segments.filter((segment) => segment === PATH_SEGMENT_TEMPLATE).length;
  return placeholders >= 1
    && placeholders <= 4
    && segments.every((segment) => (
      segment.length > 0
      && (!(segment.includes("{") || segment.includes("}"))
        || segment === PATH_SEGMENT_TEMPLATE)
    ));
}

function pathShapes(match) {
  return match.paths ?? match.pathTemplates ?? [];
}

function pathShapesOverlap(left, right) {
  const leftSegments = left.split("/").slice(1);
  const rightSegments = right.split("/").slice(1);
  return leftSegments.length === rightSegments.length
    && leftSegments.every((segment, index) => (
      segment === PATH_SEGMENT_TEMPLATE
      || rightSegments[index] === PATH_SEGMENT_TEMPLATE
      || segment === rightSegments[index]
    ));
}

function profilesOverlap(left, right) {
  return left.match.method === right.match.method
    && pathShapes(left.match).some((path) => (
      pathShapes(right.match).some((other) => pathShapesOverlap(path, other))
    ))
    && left.match.statusCodes.some((status) => right.match.statusCodes.includes(status));
}

export function assertExchangeFactCapturePolicy(policy) {
  if (policy === null || policy === undefined) return null;
  if (!hasExactKeys(policy, [
    "schemaVersion",
    "captureProfile",
    "policyFingerprint",
    "profiles",
  ])) {
    throw new TypeError("E2B exchange-fact capture is not supported by this profile");
  }
  if (
    policy.schemaVersion !== 1
    || policy.captureProfile !== EXCHANGE_FACT_PROFILE
    || typeof policy.policyFingerprint !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(policy.policyFingerprint)
    || !Array.isArray(policy.profiles)
    || policy.profiles.length < 1
    || policy.profiles.length > 8
  ) {
    throw new TypeError("E2B exchange-fact capture is not supported by this profile");
  }
  let selectorTotal = 0;
  const profileIds = new Set();
  for (const profile of policy.profiles) {
    if (
      !hasExactKeys(profile, ["id", "match", "requestJson", "responseJson"])
      || !validId(profile.id)
      || profileIds.has(profile.id)
      || !(
        hasExactKeys(profile.match, ["method", "paths", "statusCodes"])
        || hasExactKeys(profile.match, ["method", "pathTemplates", "statusCodes"])
      )
      || typeof profile.match.method !== "string"
      || !/^[A-Z]{1,16}$/.test(profile.match.method)
      || !Array.isArray(pathShapes(profile.match))
      || pathShapes(profile.match).length < 1
      || pathShapes(profile.match).length > 32
      || new Set(pathShapes(profile.match)).size !== pathShapes(profile.match).length
      || (profile.match.paths ?? []).some((path) => (
        typeof path !== "string"
        || !path.startsWith("/")
        || path.includes("?")
        || path.includes("#")
        || path.includes("{")
        || path.includes("}")
        || Buffer.byteLength(path) > MAX_CAPTURE_PATH_BYTES
      ))
      || (profile.match.pathTemplates ?? []).some((path) => !validPathTemplate(path))
      || !Array.isArray(profile.match.statusCodes)
      || profile.match.statusCodes.length < 1
      || new Set(profile.match.statusCodes).size !== profile.match.statusCodes.length
      || profile.match.statusCodes.some((status) => (
        !Number.isSafeInteger(status) || status < 100 || status > 599
      ))
      || !Array.isArray(profile.requestJson)
      || !Array.isArray(profile.responseJson)
    ) {
      throw new TypeError("E2B exchange-fact capture is not supported by this profile");
    }
    profileIds.add(profile.id);
    const selectors = [...profile.requestJson, ...profile.responseJson];
    if (
      selectors.length < 1
      || selectors.length > 24
      || new Set(profile.requestJson.map(({ id }) => id)).size !== profile.requestJson.length
      || new Set(profile.responseJson.map(({ id }) => id)).size !== profile.responseJson.length
      || selectors.some((selector) => !validSelector(selector))
    ) {
      throw new TypeError("E2B exchange-fact capture is not supported by this profile");
    }
    selectorTotal += selectors.length;
  }
  if (
    selectorTotal > 64
    || policy.profiles.some((profile, index) => (
      policy.profiles.slice(index + 1).some((other) => profilesOverlap(profile, other))
    ))
  ) {
    throw new TypeError("E2B exchange-fact capture is not supported by this profile");
  }
  return policy;
}

export function capturePolicy(capture) {
  if (capture?.mode === "none") {
    if (capture.exchangeFacts !== null && capture.exchangeFacts !== undefined) {
      throw new TypeError("E2B exchange-fact capture requires egress capture");
    }
    if ((capture.blockedRequests?.length ?? 0) > 0) {
      throw new TypeError("E2B request blocking requires egress capture");
    }
    return {
      hosts: [],
      selectedResponseHeaders: {},
      exchangeFacts: null,
      blockedRequests: [],
    };
  }
  if (
    !["http-egress-metadata-v1", "network-egress-metadata-v1"].includes(capture?.mode)
  ) {
    throw new TypeError("E2B Guardian requires network egress metadata capture");
  }
  const protocols = [...(capture.protocols ?? ["http", "https"])];
  if (protocols.some((protocol) => !["http", "https", "wss"].includes(protocol))) {
    throw new TypeError("E2B Guardian does not support a requested capture protocol");
  }
  const hosts = capture.routes.map(({ host }) => host);
  const selectedResponseHeaders = Object.fromEntries(capture.routes.map(({
    host,
    selectedFields,
  }) => [host, [...selectedFields]]));
  const blockedRequests = capture.blockedRequests ?? [];
  if (
    !Array.isArray(blockedRequests)
    || blockedRequests.length > 128
    || blockedRequests.some((rule) => (
      !rule
      || typeof rule !== "object"
      || Array.isArray(rule)
      || Object.keys(rule).length !== 3
      || Object.keys(rule).some((key) => !["id", "method", "path"].includes(key))
      || typeof rule.id !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id)
      || typeof rule.method !== "string"
      || !/^[A-Z]{1,16}$/.test(rule.method)
      || typeof rule.path !== "string"
      || !rule.path.startsWith("/")
      || rule.path.includes("?")
      || rule.path.includes("#")
      || Buffer.byteLength(rule.path) > 4_096
    ))
    || new Set(blockedRequests.map(({ id }) => id)).size !== blockedRequests.length
    || new Set(blockedRequests.map(({ method, path }) => `${method}\n${path}`)).size
      !== blockedRequests.length
  ) {
    throw new TypeError("E2B request-blocking policy is invalid");
  }
  return {
    hosts,
    selectedResponseHeaders,
    exchangeFacts: assertExchangeFactCapturePolicy(capture.exchangeFacts),
    blockedRequests,
  };
}

export async function waitForPort(sandbox, port, label, signal = undefined) {
  const result = await sandbox.commands.run(`python3 - <<'PY'
import socket, time
for _ in range(120):
    try:
        with socket.create_connection(("127.0.0.1", ${port}), timeout=1):
            print("READY")
            break
    except OSError:
        time.sleep(0.25)
else:
    raise SystemExit("not ready")
PY`, { timeoutMs: 45_000, signal });
  if (!result.stdout.includes("READY")) throw new Error(`${label} did not start`);
}

export async function stopProcess(sandbox, handle, label) {
  if (!handle) return;
  await handle.kill().catch(() => {});
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const processes = await sandbox.commands.list();
    if (!processes.some(({ pid }) => String(pid) === String(handle.pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} remained active`);
}

async function installNodeRuntime(sandbox, packageText, lockText, signal) {
  await sandbox.commands.run(`mkdir -p ${NODE_ROOT}`, { timeoutMs: 10_000, signal });
  await sandbox.files.write(`${NODE_ROOT}/package.json`, packageText, { signal });
  await sandbox.files.write(`${NODE_ROOT}/package-lock.json`, lockText, { signal });
  await sandbox.files.write(BRIDGE_PATH, BRIDGE, { signal });
  await sandbox.commands.run(
    `npm --prefix ${NODE_ROOT} ci --ignore-scripts --no-audit --no-fund`,
    { timeoutMs: 120_000, signal },
  );
}

async function installProxyRuntime(sandbox, signal) {
  await sandbox.commands.run(`mkdir -p ${CAPTURE_ROOT}`, { timeoutMs: 10_000, signal });
  await sandbox.files.write(PROXY_PATH, GENERIC_PROXY, { signal });
  await sandbox.files.write(
    `${CAPTURE_ROOT}/guardian-requirements.lock`,
    REQUIREMENTS,
    { signal },
  );
  // The locked mitmproxy release requires Python 3.12, while E2B's base
  // image currently exposes Python 3.11. Fetch and verify a pinned uv binary
  // before using it to install the pinned interpreter and hashed proxy lock.
  await sandbox.commands.run(`test "$(uname -m)" = x86_64 && \
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
--retry 6 --retry-all-errors --retry-max-time 120 --connect-timeout 20 \
--output ${UV_ARCHIVE_PATH} \
https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_LINUX_ARCHIVE} && \
printf '%s  %s\\n' ${UV_LINUX_SHA256} ${UV_ARCHIVE_PATH} \
| sha256sum --check --strict - && \
tar -xzf ${UV_ARCHIVE_PATH} -C ${CAPTURE_ROOT} && \
install -m 0755 ${CAPTURE_ROOT}/uv-x86_64-unknown-linux-gnu/uv ${UV_PATH} && \
${UV_PATH} --version | grep -F 'uv ${UV_VERSION}' && \
${UV_PATH} python install '${MITMPROXY_PYTHON}' >/dev/null && \
${UV_PATH} venv --clear --python '${MITMPROXY_PYTHON}' ${CAPTURE_ROOT}/venv >/dev/null && \
${UV_PATH} pip install --python ${CAPTURE_ROOT}/venv/bin/python \
--require-hashes --no-deps --no-build \
-r ${CAPTURE_ROOT}/guardian-requirements.lock >/dev/null && \
${CAPTURE_ROOT}/venv/bin/mitmdump --version | head -1`, {
    timeoutMs: 360_000,
    signal,
  });
  await installNodeRuntime(sandbox, GUARDIAN_NODE_PACKAGE, GUARDIAN_NODE_LOCK, signal);
}

async function generateCa(sandbox, signal) {
  const processHandle = await sandbox.commands.run(
    `exec ${CAPTURE_ROOT}/venv/bin/mitmdump -q --listen-host 127.0.0.1 --listen-port ${PROXY_PORT} --set upstream_cert=false --set confdir=/home/user/.mitmproxy`,
    { background: true, timeoutMs: PROCESS_TIMEOUT_MS, signal },
  );
  let certificate;
  try {
    await waitForPort(sandbox, PROXY_PORT, "Guardian CA bootstrap", signal);
    let lastError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        certificate = await sandbox.files.read(
          "/home/user/.mitmproxy/mitmproxy-ca-cert.pem",
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    if (certificate === undefined) throw lastError ?? new Error("Guardian CA is unavailable");
  } finally {
    await stopProcess(sandbox, processHandle, "Guardian CA bootstrap");
  }
  if (!certificate.includes("BEGIN CERTIFICATE") || certificate.includes("PRIVATE KEY")) {
    throw new Error("Guardian returned invalid public CA material");
  }
  return certificate;
}

export async function installWorkloadTrust(workload, certificate, hosts, signal, firewallSuffix = "", firewallVerdict = "REJECT", { systemTrust = false } = {}) {
  if (!certificate.includes("BEGIN CERTIFICATE") || certificate.includes("PRIVATE KEY")) {
    throw new Error("Refusing invalid Guardian CA material");
  }
  await workload.commands.run(`mkdir -p ${CAPTURE_ROOT} ${PYTHON_ROOT}`, {
    timeoutMs: 10_000,
    signal,
  });
  await workload.files.write(CA_PATH, certificate, { signal });
  await workload.files.write(`${PYTHON_ROOT}/sitecustomize.py`, PYTHON_BOOTSTRAP, { signal });
  await workload.files.write(NODE_BOOTSTRAP_PATH, NODE_BOOTSTRAP, { signal });
  await workload.commands.run(`python3 - <<'PY'
import os, ssl
source = ${JSON.stringify(CA_PATH)}
target = ${JSON.stringify(CA_BUNDLE_PATH)}
candidates = [ssl.get_default_verify_paths().cafile, "/etc/ssl/certs/ca-certificates.crt"]
base = next((path for path in candidates if path and os.path.isfile(path)), None)
with open(target, "wb") as output:
    if base:
        with open(base, "rb") as handle:
            output.write(handle.read())
        output.write(b"\\n")
    with open(source, "rb") as handle:
        output.write(handle.read())
    output.write(b"\\n")
PY`, { timeoutMs: 30_000, signal });
  if (systemTrust) {
    // An all-host Guardian intercepts clients that ignore the bundle
    // variables (git, Rust TLS stacks), so also trust it system-wide.
    await workload.commands.run(
      `install -d -m 0755 /usr/local/share/ca-certificates && install -m 0644 ${CA_PATH} /usr/local/share/ca-certificates/hurdle-guardian.crt && update-ca-certificates >/dev/null`,
      { timeoutMs: 30_000, signal, user: "root" },
    );
  }
  await installNodeRuntime(workload, AGENT_NODE_PACKAGE, AGENT_NODE_LOCK, signal);
  await workload.commands.run(`python3 - <<'PY'
# seal workload trust permissions: public trust material and bootstraps must be
# readable, but never writable, by the later isolated Agent identity.
import os, stat
root = ${JSON.stringify(CAPTURE_ROOT)}
for current, directory_names, file_names in os.walk(root):
    directory = current
    os.chown(directory, 0, 0)
    os.chmod(directory, 0o755)
    for name in [*directory_names, *file_names]:
        path = os.path.join(current, name)
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            os.lchown(path, 0, 0)
        elif stat.S_ISDIR(info.st_mode):
            os.chown(path, 0, 0)
            os.chmod(path, 0o755)
        elif stat.S_ISREG(info.st_mode):
            os.chown(path, 0, 0)
            executable = bool(info.st_mode & 0o111)
            os.chmod(path, 0o555 if executable else 0o444)
        else:
            raise SystemExit("invalid workload trust entry")
PY`, {
    timeoutMs: 30_000,
    signal,
    user: "root",
  });
  await workload.commands.run(`python3 - <<'PY'
import ipaddress, json, os, socket, subprocess

hosts = json.loads(os.environ["TAE_CAPTURE_HOSTS"])
addresses = set()
for host in hosts:
    host_addresses = set()
    try:
        answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise SystemExit(f"capture host resolution failed: {host}") from error
    for family, _, _, _, address in answers:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        parsed = ipaddress.ip_address(address[0])
        if not parsed.is_global:
            raise SystemExit(f"capture host resolved outside public address space: {host}")
        host_addresses.add(parsed)
    if not host_addresses:
        raise SystemExit(f"capture host resolved no public addresses: {host}")
    addresses.update(host_addresses)

if len(addresses) > 128:
    raise SystemExit("capture host resolution exceeded address bound")

for address in sorted(addresses, key=lambda value: (value.version, int(value))):
    binary = ("/usr/sbin/iptables" if address.version == 4 else "/usr/sbin/ip6tables") + ${JSON.stringify(firewallSuffix)}
    if not os.path.isfile(binary):
        raise SystemExit(f"capture route firewall is unavailable for IPv{address.version}")
    destination = f"{address}/{32 if address.version == 4 else 128}"
    rule = [binary, "--wait", "5", "OUTPUT", "-d", destination, "-j", ${JSON.stringify(firewallVerdict)}]
    checked = subprocess.run(
        [binary, "--wait", "5", "-C", *rule[3:]],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if checked.returncode != 0:
        subprocess.run(
            [binary, "--wait", "5", "-I", *rule[3:]],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
PY`, {
    timeoutMs: 30_000,
    signal,
    user: "root",
    envs: { TAE_CAPTURE_HOSTS: JSON.stringify(hosts) },
  });
}

export function workloadProxyEnvironment(hosts) {
  return {
    HTTPS_PROXY: `http://127.0.0.1:${RELAY_PORT}`,
    HTTP_PROXY: `http://127.0.0.1:${RELAY_PORT}`,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    SSL_CERT_FILE: CA_BUNDLE_PATH,
    REQUESTS_CA_BUNDLE: CA_BUNDLE_PATH,
    CURL_CA_BUNDLE: CA_BUNDLE_PATH,
    NODE_EXTRA_CA_CERTS: CA_BUNDLE_PATH,
    NODE_OPTIONS: `--require=${NODE_BOOTSTRAP_PATH}`,
    PYTHONPATH: PYTHON_ROOT,
    TAE_EGRESS_CA_BUNDLE: CA_BUNDLE_PATH,
    TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(hosts),
    TAE_EGRESS_PROXY: `http://127.0.0.1:${RELAY_PORT}`,
  };
}

// Waits for every captured flow to finish after a seal request. `request`
// sends one control action to the Guardian and returns its parsed state.
export async function drainSealedGuardian(request, { policyFingerprint }) {
  let state = await request("seal");
  const deadline = Date.now() + 120_000;
  while (true) {
    if (!Number.isSafeInteger(state.activeFlows) || state.activeFlows < 0) {
      throw new Error("Guardian returned an invalid active flow count");
    }
    if (state.activeFlows === 0) break;
    if (Date.now() >= deadline) throw new Error("Guardian drain timed out");
    await new Promise((resolve) => setTimeout(resolve, 200));
    state = await request("status");
  }
  if (
    !state.sealed
    || state.truncated
    || !state.journalDigest
    || state.maxRows !== MAX_CAPTURE_ROWS
    || state.maxJournalBytes !== MAX_CAPTURE_BYTES
    || state.maxPathBytes !== MAX_CAPTURE_PATH_BYTES
    || state.policyFingerprint !== policyFingerprint
    || !Number.isSafeInteger(state.journalBytes)
    || state.journalBytes < 0
    || state.journalBytes > MAX_CAPTURE_BYTES
  ) {
    throw new Error("Guardian capture did not seal cleanly");
  }
  return state;
}

export function sealedJournalCollection(state, journal, producer) {
  const journalBytes = Buffer.from(journal);
  if (
    journalBytes.byteLength !== state.journalBytes
    || sha256(journalBytes) !== state.journalDigest
  ) {
    throw new Error("Guardian journal digest mismatch");
  }
  const text = journalBytes.toString("utf8");
  const requests = text.trim()
    ? text.trim().split("\n").map((line) => JSON.parse(line))
    : [];
  if (
    requests.length !== state.rowCount
    || requests.some(({ sequence }, index) => sequence !== index)
  ) {
    throw new Error("Guardian journal sequence mismatch");
  }
  return {
    status: "captured",
    requests,
    provenance: {
      producer,
      authority: "environment",
      lifecyclePhase: "execution",
      capturedAt: new Date().toISOString(),
      trust: "environment-observed",
    },
  };
}

async function controlState(sandbox, token, action) {
  const result = await sandbox.commands.run(`python3 - <<'PY'
import http.client, json, os, socket
host = ${JSON.stringify(CONTROL_HOST)}
path = ${JSON.stringify(`${CONTROL_PREFIX}/`)} + os.environ["TAE_CONTROL_ACTION"]
request = (f"GET http://{host}{path} HTTP/1.1\\r\\nHost: {host}\\r\\nX-Tae-Egress-Control: {os.environ['TAE_CONTROL_TOKEN']}\\r\\nConnection: close\\r\\n\\r\\n").encode("ascii")
with socket.create_connection(("127.0.0.1", ${PROXY_PORT}), timeout=5) as connection:
    connection.sendall(request)
    response = http.client.HTTPResponse(connection)
    response.begin()
    body = response.read()
    if response.status != 200:
        raise SystemExit(f"control failed: {response.status}")
print(body.decode("utf-8"))
PY`, {
    timeoutMs: 15_000,
    envs: { TAE_CONTROL_TOKEN: token, TAE_CONTROL_ACTION: action },
  });
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

// Both providers use the same proxy, credential substitutions, policy bounds,
// public trust material, draining and digest/sequence-verified sealing.
export function createExternalGuardianController({
  producer = "e2b-guardian",
  requiresTrafficAccessToken = true,
  firewallSuffix = "",
  firewallVerdict = "REJECT",
  bridgeEnvironment = () => ({}),
  workloadBridgeMode = "client",
} = {}) {
  return Object.freeze({
    async prepare({
      sandbox,
      capture,
      credentialBindings,
      credentialValues,
      surrogates,
      profile,
      signal,
    }) {
      if (profile !== "external-guardian-http-metadata-v1") {
        throw new TypeError("unsupported external Guardian capture profile");
      }
      const {
        hosts,
        selectedResponseHeaders,
        exchangeFacts,
        blockedRequests,
      } = capturePolicy(capture);
      const substitutions = credentialBindings
        .filter(({ delivery }) => delivery.kind === "captured-http-header")
        .map(({ environmentName, delivery }) => ({
          surrogate: surrogates[environmentName],
          value: credentialValues[environmentName],
          hosts: delivery.hosts,
          headerNames: delivery.headerNames,
        }));
      await installProxyRuntime(sandbox, signal);
      const caCertificate = await generateCa(sandbox, signal);
      const bridgeToken = randomBytes(32).toString("base64url");
      const controlToken = randomBytes(32).toString("base64url");
      await sandbox.updateNetwork({
        allowOut: hosts,
        denyOut: ["0.0.0.0/0"],
      }, { signal });
      const proxyProcess = await sandbox.commands.run(
        `exec ${CAPTURE_ROOT}/venv/bin/mitmdump -q -s ${PROXY_PATH} --listen-host 127.0.0.1 --listen-port ${PROXY_PORT} --set upstream_cert=false --set confdir=/home/user/.mitmproxy`,
        {
          background: true,
          timeoutMs: PROCESS_TIMEOUT_MS,
          signal,
          envs: {
            TAE_EGRESS_LOG: LOG_PATH,
            TAE_EGRESS_CONTROL_TOKEN: controlToken,
            TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(hosts),
            TAE_EGRESS_SELECTED_RESPONSE_HEADERS: JSON.stringify(
              selectedResponseHeaders,
            ),
            TAE_EGRESS_EXCHANGE_FACTS: JSON.stringify(exchangeFacts),
            TAE_EGRESS_BLOCKED_REQUESTS: JSON.stringify(blockedRequests),
            TAE_EGRESS_SUBSTITUTIONS: JSON.stringify(substitutions),
            TAE_EGRESS_MAX_ROWS: String(MAX_CAPTURE_ROWS),
            TAE_EGRESS_MAX_BYTES: String(MAX_CAPTURE_BYTES),
          },
        },
      );
      await waitForPort(sandbox, PROXY_PORT, "Guardian proxy", signal);
      const bridgeProcess = await sandbox.commands.run(
        `exec node ${BRIDGE_PATH} server`,
        {
          background: true,
          timeoutMs: PROCESS_TIMEOUT_MS,
          signal,
          envs: {
            EGRESS_BRIDGE_CELL_TOKEN: bridgeToken,
            EGRESS_BRIDGE_LISTEN_PORT: String(BRIDGE_PORT),
            EGRESS_BRIDGE_TARGET_PORT: String(PROXY_PORT),
          },
        },
      );
      await waitForPort(sandbox, BRIDGE_PORT, "Guardian bridge", signal);
      return {
        bridgeProcess,
        bridgeToken,
        caCertificate,
        controlToken,
        guardianHost: sandbox.getHost(BRIDGE_PORT),
        hosts,
        policyFingerprint: exchangeFacts?.policyFingerprint ?? null,
        proxyProcess,
        relayProcess: null,
        workload: null,
        workloadEnvironment: {},
      };
    },
    async attach({ workload, sandbox, session, signal }) {
      const trafficAccessToken = sandbox?.trafficAccessToken;
      if (requiresTrafficAccessToken && (typeof trafficAccessToken !== "string" || !trafficAccessToken.trim())) {
        throw new Error(
          "Guardian requires restricted public traffic and a traffic access token",
        );
      }
      await installWorkloadTrust(
        workload,
        session.caCertificate,
        session.hosts,
        signal,
        firewallSuffix,
        firewallVerdict,
      );
      session.workload = workload;
      session.relayProcess = await workload.commands.run(
        `exec node ${BRIDGE_PATH} ${workloadBridgeMode}`,
        {
          background: true,
          timeoutMs: PROCESS_TIMEOUT_MS,
          signal,
          envs: {
            EGRESS_BRIDGE_URL: `wss://${session.guardianHost}/proxy`,
            ...(requiresTrafficAccessToken
              ? { EGRESS_BRIDGE_TRAFFIC_TOKEN: trafficAccessToken }
              : { EGRESS_BRIDGE_TRAFFIC_HEADER: "none" }),
            EGRESS_BRIDGE_CELL_TOKEN: session.bridgeToken,
            EGRESS_BRIDGE_LISTEN_PORT: String(RELAY_PORT),
            EGRESS_BRIDGE_SELECTIVE_PROXY: "1",
            TAE_EGRESS_CAPTURE_HOSTS: JSON.stringify(session.hosts),
            ...bridgeEnvironment(session),
          },
        },
      );
      await waitForPort(workload, RELAY_PORT, "workload relay", signal);
      session.workloadEnvironment = workloadProxyEnvironment(session.hosts);
    },
    async seal({ sandbox, session }) {
      const state = await drainSealedGuardian(
        (action) => controlState(sandbox, session.controlToken, action),
        { policyFingerprint: session.policyFingerprint },
      );
      await stopProcess(sandbox, session.proxyProcess, "Guardian proxy");
      await stopProcess(session.workload, session.relayProcess, "workload relay");
      await stopProcess(sandbox, session.bridgeProcess, "Guardian bridge");
      const journalInfo = await sandbox.files.getInfo(LOG_PATH);
      if (journalInfo.size !== state.journalBytes || journalInfo.size > MAX_CAPTURE_BYTES) {
        throw new Error("Guardian journal exceeded its sealed byte bound");
      }
      return sealedJournalCollection(state, await sandbox.files.read(LOG_PATH), producer);
    },
  });
}

export function createE2BGuardianController() {
  return createExternalGuardianController();
}
