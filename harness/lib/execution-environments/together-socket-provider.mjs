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
  chunks,
  decodeData,
  encodeData,
  FRAME_KIND,
  MAX_BUFFERED_BYTES,
  MAX_FRAME_BYTES,
} from "./sandbox-socket-protocol.mjs";

// Bartender's Hurdle API hands the controller one WebSocket to a fresh sandbox
// and nothing else: no sandbox id, token or exec API. Everything crosses that
// socket: task inputs are written, task steps run inside the sandbox
// (sandbox-task.mjs), sealed results are read back, and the Agent's egress
// flows ride it to the Guardian. Closing it terminates the sandbox.

const STEP_TIMEOUT_MS = 10 * 60_000;
// Sealing and process cleanup after the Agent's own deadline.
const AGENT_GRACE_MS = 2 * 60_000;

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

function connect(url, apiKey, caCertificate, signal) {
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
    const onAbort = () => { socket.terminate(); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (callback) => (value) => {
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    socket.once("open", settle(() => resolve(socket)));
    socket.once("unexpected-response", (_request, response) => {
      responseError(response).then(settle(reject));
    });
    socket.once("error", settle(reject));
  });
}

function createSocketResource(socket) {
  const pending = new Map();
  const flows = new Map();
  let nextId = 1;
  let openUpstream = null;
  let failure = null;
  let closed = false;

  const send = (message) => socket.send(JSON.stringify(message));
  const sendData = (kind, channel, payload, callback) =>
    socket.send(encodeData(kind, channel, payload), { binary: true }, callback);

  function closeFlow(id, notify) {
    const tcp = flows.get(id);
    if (!tcp) return;
    flows.delete(id);
    tcp.destroy();
    if (notify && !closed) send({ op: "flow.close", id });
  }

  function openFlow(id) {
    if (!openUpstream) return send({ op: "flow.close", id });
    let tcp;
    try { tcp = openUpstream(); } catch { return send({ op: "flow.close", id }); }
    flows.set(id, tcp);
    tcp.on("data", (chunk) => {
      sendData(FRAME_KIND.flow, id, chunk, () => {
        if (tcp.isPaused() && socket.bufferedAmount <= MAX_BUFFERED_BYTES / 2) tcp.resume();
      });
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) tcp.pause();
    });
    tcp.on("error", () => closeFlow(id, true));
    tcp.on("close", () => closeFlow(id, true));
  }

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const { kind, channel, payload } = decodeData(data);
      if (kind === FRAME_KIND.flow) return flows.get(channel)?.write(payload);
      const request = pending.get(channel);
      if (kind === FRAME_KIND.read) request?.parts.push(Buffer.from(payload));
      else if (kind === FRAME_KIND.stdout) request?.onStdout?.(payload.toString("utf8"));
      else if (kind === FRAME_KIND.stderr) request?.onStderr?.(payload.toString("utf8"));
      return;
    }
    const message = JSON.parse(data.toString("utf8"));
    if (message.op === "flow.open") return openFlow(message.id);
    if (message.op === "flow.close") return closeFlow(message.id, false);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.op === "done") request.resolve({ value: message.value, parts: request.parts });
    else request.reject(new Error(message.message ?? "Together sandbox operation failed"));
  });
  socket.once("close", () => {
    closed = true;
    failure ||= new Error("Together sandbox connection closed");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    for (const id of [...flows.keys()]) closeFlow(id, false);
  });
  socket.on("error", (error) => { failure ||= error; });

  // Each operation either completes or ends the sandbox: a step that cannot be
  // waited for is not left running in it.
  function request(message, { signal, timeoutMs = STEP_TIMEOUT_MS, onStdout, onStderr, body } = {}) {
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
      pending.set(id, { parts: [], onStdout, onStderr, resolve: done(resolve), reject: done(reject) });
      timer = setTimeout(() => {
        resource.close();
        reject(Object.assign(new Error("Together sandbox operation timed out"), { name: "TimeoutError" }));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      send({ ...message, id });
      if (body) {
        for (const chunk of chunks(body)) sendData(FRAME_KIND.write, id, chunk);
        send({ op: "end", id });
      }
    });
  }

  const resource = {
    sandboxId: randomUUID(),
    async write(path, bytes, options) {
      await request({ op: "write", path }, { ...options, body: Buffer.from(bytes) });
    },
    async read(path, options) {
      const { parts } = await request({ op: "read", path }, options);
      return Buffer.concat(parts);
    },
    async step(job, options) {
      return (await request({ op: "run", job }, options)).value;
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
} = {}) {
  return Object.freeze({
    // The sandbox holds no secrets: credentials reach it only as surrogates the
    // Guardian swaps on egress, never as environment values.
    sealedOnly: true,
    async acquire({ apiKey, caCertificate, signal }) {
      return createSocketResource(await connect(runUrl(), apiKey, caCertificate, signal));
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
      const { stdin, ...plan } = launchPlan;
      const stdinBytes = typeof stdin === "string" ? Buffer.from(stdin) : Buffer.from(stdin ?? new Uint8Array());
      return resource.step({
        kind: "agent",
        launchPlan: { ...plan, stdinBase64: stdinBytes.toString("base64") },
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
    // Bartender terminates the sandbox when its connection ends.
    async dispose(resource) {
      resource.close();
    },
    async isDisposed(resource) {
      return resource.closed;
    },
  });
}
