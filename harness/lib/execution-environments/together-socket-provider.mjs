import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { sha256 } from "../run-model.mjs";
import { togetherRunUrl } from "../together-api-url.mjs";
import {
  ARTIFACT_ROOT,
  validateArtifactDeclarations,
} from "./linux-sandbox-operations.mjs";
import { TASK_ROOT } from "./sandbox-server.mjs";
import {
  MAX_FRAME_BYTES,
  muxOver,
  readAll,
  readLines,
  writeLine,
} from "./sandbox-socket-protocol.mjs";

// Together's Hurdle API hands the controller one WebSocket to a fresh sandbox
// and nothing else: no sandbox id, token or exec API. Everything crosses that
// socket: task inputs are written, task steps run inside the sandbox
// (sandbox-task.mjs), sealed results are read back, and the Agent's egress
// flows ride it to the Guardian. Closing it terminates the sandbox.

const STEP_TIMEOUT_MS = 10 * 60_000;
// Sealed artifacts are bounded in the sandbox; this is the transport's backstop.
const MAX_READ_BYTES = 256 * 1024 * 1024;
// Sealing and process cleanup after the Agent's own deadline.
const AGENT_GRACE_MS = 2 * 60_000;
// Together answers the upgrade once the sandbox has booted. A request it never
// answers would otherwise hold the run at "Starting sandbox" indefinitely,
// before the cell's own lifetime starts counting.
export const CONNECT_TIMEOUT_MS = 3 * 60_000;

function abortError() {
  return Object.assign(new Error("Together socket operation cancelled"), { name: "AbortError" });
}

// The header carries the PEM body: header values cannot hold its line breaks.
export function certificateHeader(certificate) {
  if (!certificate?.includes("BEGIN CERTIFICATE") || certificate.includes("PRIVATE KEY"))
    throw new Error("Refusing invalid Guardian CA material");
  return certificate
    .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

function responseError(response) {
  return new Promise((resolve) => {
    const parts = [];
    response.on("data", (chunk) => parts.push(chunk));
    response.on("error", () => {});
    response.on("end", () => {
      let code = null;
      try { code = JSON.parse(Buffer.concat(parts).toString("utf8")).code ?? null; } catch { /* not JSON */ }
      resolve(Object.assign(
        new Error(`Together sandbox connection was refused (${response.statusCode}${code ? ` ${code}` : ""})`),
        { status: response.statusCode, code },
      ));
    });
  });
}

function connect(url, apiKey, caCertificate, signal, timeoutMs) {
  const WebSocket = createRequire(import.meta.url)("ws");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Sandbox-CA": certificateHeader(caCertificate),
      },
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
    });
    let timer = null;
    const onAbort = () => { clearTimeout(timer); socket.terminate(); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (callback) => (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    timer = setTimeout(settle(() => {
      socket.terminate();
      reject(Object.assign(
        new Error(`Together did not open a sandbox within ${Math.round(timeoutMs / 1000)}s`),
        { code: "sandbox_connection_timeout" },
      ));
    }), timeoutMs);
    socket.once("open", settle(() => resolve(socket)));
    socket.once("unexpected-response", (_request, response) => {
      responseError(response).then(settle(reject));
    });
    socket.once("error", settle(reject));
  });
}

// Text output arrives in arbitrary chunks; a decoder keeps a split character
// whole across them.
function textSink(callback) {
  const decoder = new TextDecoder("utf-8");
  return {
    write: (chunk) => { const text = decoder.decode(chunk, { stream: true }); if (text) callback?.(text); },
    end: () => { const text = decoder.decode(); if (text) callback?.(text); },
  };
}

function createSocketResource(socket) {
  const pending = new Map();
  const flows = new Set();
  let nextId = 1;
  let openUpstream = null;
  let failure = null;
  let closed = false;

  // Every stream the server opens is one of the Agent's egress connections.
  const session = muxOver(socket, {
    client: true,
    onStream: (stream) => {
      let tcp;
      try { tcp = openUpstream?.(); } catch { tcp = null; }
      if (!tcp) return stream.destroy();
      flows.add(tcp);
      const teardown = () => { flows.delete(tcp); tcp.destroy(); stream.destroy(); };
      tcp.on("error", teardown);
      stream.on("error", teardown);
      tcp.once("close", teardown);
      stream.pipe(tcp);
      tcp.pipe(stream);
    },
  });
  const control = session.open();
  control.on("error", () => {});
  readLines(control, (message) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.op === "done") request.resolve(message.value);
    else request.reject(new Error(message.message ?? "Together sandbox operation failed"));
  }, () => socket.terminate());

  socket.once("close", () => {
    closed = true;
    failure ||= new Error("Together sandbox connection closed");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    for (const tcp of [...flows]) tcp.destroy();
    session.close();
  });
  socket.on("error", (error) => { failure ||= error; });

  // Each operation either completes or ends the sandbox: a step that cannot be
  // waited for is not left running in it. `streams` names the streams the op
  // uses, opened here before the op is sent so their SYNs precede it.
  function request(message, streams = {}, { signal, timeoutMs = STEP_TIMEOUT_MS } = {}) {
    if (closed) return Promise.reject(failure);
    if (signal?.aborted) return Promise.reject(abortError());
    const id = nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => { resource.close(); reject(abortError()); };
      const done = (callback) => (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      pending.set(id, { resolve: done(resolve), reject: done(reject) });
      timer = setTimeout(() => {
        resource.close();
        reject(Object.assign(new Error("Together sandbox operation timed out"), { name: "TimeoutError" }));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      const named = Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, stream.id]));
      writeLine(control, { ...message, ...named, id });
    });
  }

  const resource = {
    sandboxId: randomUUID(),
    async write(path, bytes, options) {
      const stream = session.open();
      stream.on("error", () => {});
      stream.end(Buffer.from(bytes));
      await request({ op: "write", path }, { stream }, options);
    },
    async read(path, options) {
      const stream = session.open();
      const bytes = readAll(stream, MAX_READ_BYTES);
      bytes.catch(() => {});
      await request({ op: "read", path }, { stream }, options);
      return bytes;
    },
    async step(job, { onStdout, onStderr, ...options } = {}) {
      const stdout = session.open();
      const stderr = session.open();
      for (const [stream, callback] of [[stdout, onStdout], [stderr, onStderr]]) {
        const sink = textSink(callback);
        stream.on("data", sink.write);
        stream.once("end", sink.end);
        stream.on("error", () => {});
      }
      return request({ op: "run", job }, { stdout, stderr }, options);
    },
    async attachEgress({ hosts, openUpstream: upstream, signal }) {
      openUpstream = upstream;
      await resource.step({ kind: "setup", hosts }, { signal });
    },
    assertEgressHealthy() {
      if (closed) throw failure;
    },
    get closed() {
      return closed;
    },
    close() {
      if (!closed) socket.terminate();
    },
  };
  return resource;
}

async function upload(resource, root, bytes, name, signal) {
  const path = `${root}/inputs/${name}`;
  await resource.write(path, bytes, { signal });
  return path;
}

export function createTogetherSocketProvider({
  runUrl = togetherRunUrl, taskRoot = TASK_ROOT, artifactRoot = ARTIFACT_ROOT,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
} = {}) {
  return Object.freeze({
    // Agent and Suite credentials reach the sandbox only as surrogates the
    // Guardian swaps on egress, never as environment values.
    sealedOnly: true,
    async acquire({ apiKey, caCertificate, signal }) {
      return createSocketResource(await connect(runUrl(), apiKey, caCertificate, signal, connectTimeoutMs));
    },
    async stage(resource, { fixtures, workspaceFiles, signal }) {
      // Inputs are pinned on this host; the sandbox re-verifies each digest.
      const staged = [];
      for (const [index, fixture] of fixtures.entries()) {
        const bytes = await readFile(fixture.pinnedPath);
        staged.push({ ...fixture, pinnedPath: await upload(resource, taskRoot, bytes, `fixture-${index}`, signal) });
      }
      const files = [];
      for (const [index, file] of workspaceFiles.entries()) {
        const bytes = file.source.kind === "generated"
          ? Buffer.from(file.source.bytes)
          : await readFile(file.source.pinnedPath);
        const pinnedPath = await upload(resource, taskRoot, bytes, `workspace-${index}`, signal);
        files.push({ ...file, source: { kind: "pinned", pinnedPath, sha256: file.source.sha256 } });
      }
      await resource.step({ kind: "stage", fixtures: staged, workspaceFiles: files }, { signal });
    },
    async run(resource, { launchPlan, environment, onStdout, onStderr, signal }) {
      // The sandbox runs the Agent from these fields alone. The rest of the
      // plan, its env above all, holds controller-side values that must never
      // cross the socket; the Agent's environment is `environment`.
      const { command, args, workspaceLayout, timeoutMs, stdin } = launchPlan;
      const stdinBytes = typeof stdin === "string" ? Buffer.from(stdin) : Buffer.from(stdin ?? new Uint8Array());
      return resource.step({
        kind: "agent",
        launchPlan: { command, args, workspaceLayout, timeoutMs, stdinBase64: stdinBytes.toString("base64") },
        environment,
      }, {
        signal,
        onStdout,
        onStderr,
        timeoutMs: (launchPlan.timeoutMs ?? STEP_TIMEOUT_MS) + AGENT_GRACE_MS,
      });
    },
    async collectArtifacts(resource, declarations) {
      validateArtifactDeclarations(declarations);
      const { artifacts } = await resource.step({ kind: "collect", declarations });
      if (!Array.isArray(artifacts) || artifacts.length !== declarations.length)
        throw new Error("Together artifact manifest does not match its declarations");
      const collected = [];
      for (const [index, artifact] of artifacts.entries()) {
        const declaration = declarations[index];
        if (artifact?.path !== declaration.path)
          throw new Error("Together artifact manifest contains an undeclared result");
        if (artifact.status !== "captured") {
          collected.push(artifact);
          continue;
        }
        if (artifact.index !== index) throw new Error("Together artifact manifest escaped its sealed path");
        const { index: _index, ...result } = artifact;
        const bytes = await resource.read(`${artifactRoot}/${index}`);
        if (
          bytes.byteLength > declaration.maxBytes
          || bytes.byteLength !== result.sizeBytes
          || sha256(bytes) !== result.sha256
        ) {
          collected.push({ ...declaration, status: "rejected", reason: "changed_during_transfer", capturedAt: result.capturedAt });
          continue;
        }
        if (declaration.kind === "text") {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            collected.push({ ...declaration, status: "rejected", reason: "invalid_utf8", capturedAt: result.capturedAt });
            continue;
          }
        }
        collected.push({ ...result, bytes });
      }
      return collected;
    },
    async collectWorkspaceArtifactMetadata(resource) {
      return (await resource.step({ kind: "metadata" })).metadata;
    },
    // Together's Hurdle API terminates the sandbox when its connection ends.
    async dispose(resource) {
      resource.close();
    },
    async isDisposed(resource) {
      return resource.closed;
    },
  });
}
