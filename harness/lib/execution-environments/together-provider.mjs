import {
  createBoundedControllerCapture,
  DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
} from "../controller-transcript.mjs";
import { createLinuxSandboxOperations } from "./linux-sandbox-operations.mjs";
import {
  TOGETHER_WORKLOAD_BRIDGE_PORT,
  togetherApplicationHost,
} from "./together-guardian.mjs";

function timeoutError() {
  return Object.assign(new Error("Together command timed out"), {
    name: "TimeoutError",
  });
}
function abortError() {
  return Object.assign(new Error("Together command cancelled"), {
    name: "AbortError",
  });
}
function requireActive(signal) {
  if (signal?.aborted) throw abortError();
}

// The SDK facade has no per-call timeout option. Bound transport waits here;
// allocation is deliberately not raced, so every returned handle is disposed.
async function bounded(promise, milliseconds = 30_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runTogetherCommand(
  sandbox,
  command,
  {
    cwd,
    envs = {},
    user = "root",
    timeoutMs = 30_000,
    signal,
    onStdout,
    onStderr,
    maxOutputBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
    readOutputEvents,
  } = {},
) {
  requireActive(signal);
  if (typeof readOutputEvents !== "function")
    throw new TypeError("Together commands require a typed output reader");
  const stdout = createBoundedControllerCapture(maxOutputBytes);
  const stderr = createBoundedControllerCapture(maxOutputBytes);
  let exec;
  let timer;
  let onAbort;
  const transport = new AbortController();
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError();
      transport.abort(error);
      reject(error);
    }, timeoutMs);
    onAbort = () => {
      const error = abortError();
      transport.abort(error);
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  interrupted.catch(() => {});
  // Receive the ID even if cancellation arrives while the create request is in
  // flight. Do not retry a non-idempotent exec allocation.
  try {
    exec = await bounded(
      sandbox.execs.create({
        command: "sh",
        args: ["-c", command],
        cwd,
        env: envs,
        user,
        autostart: true,
        pty: false,
      }),
    );
    requireActive(signal);
    const consume = async () => {
      let previousSequence = -1;
      while (!transport.signal.aborted) {
        const events = await readOutputEvents(
          exec.id,
          previousSequence,
          transport.signal,
        );
        if (!Array.isArray(events))
          throw new Error("Together output is not an event array");
        for (const event of events) {
          if (transport.signal.aborted) throw transport.signal.reason;
          if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
            throw new Error("Invalid Together output sequence");
          if (!["stdout", "stderr"].includes(event.type))
            throw new Error("Invalid Together output channel");
          const terminal =
            Number.isInteger(event.exitCode) && event.exitCode >= 0;
          if (event.sequence > previousSequence) {
            if (
              previousSequence >= 0 &&
              event.sequence !== previousSequence + 1
            )
              throw new Error("Together command output sequence has a gap");
            previousSequence = event.sequence;
            const target = event.type === "stderr" ? stderr : stdout;
            if (!target.append(event.output))
              throw new Error(
                "Together command output exceeded its byte bound",
              );
            (event.type === "stderr" ? onStderr : onStdout)?.(event.output);
          }
          // Completion metadata can share the last output chunk's sequence.
          // Deduplicating output must never discard the terminal exit code.
          if (terminal) {
            const result = {
              exitCode: event.exitCode,
              stdout: stdout.snapshot().text,
              stderr: stderr.snapshot().text,
            };
            if (result.exitCode !== 0)
              throw Object.assign(
                new Error("Together command exited unsuccessfully"),
                result,
              );
            return result;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw transport.signal.reason;
    };
    return await Promise.race([consume(), interrupted]);
  } finally {
    transport.abort();
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    // A read timing out is not proof that its process stopped.
    // The Linux controller additionally kills and verifies all new processes.
    if (exec) await bounded(sandbox.execs.delete(exec.id)).catch(() => {});
    // Observe a cancellation that arrived during exec creation.
    interrupted.catch(() => {});
  }
}

export function createTogetherResource(sandbox, sdk, outputClient) {
  const readOutputEvents = !outputClient
    ? undefined
    : async (id, lastSequence, signal) => {
        const response = await outputClient.get({
          url: `/api/v1/execs/${encodeURIComponent(id)}/io`,
          query: lastSequence >= 0 ? { lastSequence } : undefined,
          signal,
        });
        if (response.error !== undefined)
          throw new Error("Together output request failed");
        return response.data;
      };
  const commands = {
    async run(command, options = {}) {
      if (options.background) {
        requireActive(options.signal);
        let exec = await bounded(sandbox.execs.create({
          command: "sh", args: ["-c", command], cwd: options.cwd,
          env: options.envs ?? {}, user: options.user ?? "root",
          autostart: true, pty: false,
        }));
        const execId = exec.id;
        try {
          requireActive(options.signal);
          // Allocation may return before the process receives its PID.
          // Retain the exec ID while waiting so cancellation always disposes it.
          for (let attempt = 0; (!Number.isSafeInteger(exec.pid) || exec.pid < 1) && attempt < 50; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
            requireActive(options.signal);
            exec = await bounded(sandbox.execs.get(execId));
          }
          if (!Number.isSafeInteger(exec.pid) || exec.pid < 1) {
            throw new Error("Together background process has no PID");
          }
          return { pid: exec.pid, kill: () => bounded(sandbox.execs.delete(execId)) };
        } catch (error) {
          await bounded(sandbox.execs.delete(execId)).catch(() => {});
          throw error;
        }
      }
      return runTogetherCommand(sandbox, command, {
        ...options,
        ...(readOutputEvents ? { readOutputEvents } : {}),
      });
    },
    async list() {
      // Inspect actual processes, not just the SDK's retained exec records.
      const result = await commands.run(`python3 - <<'PY'
import json, os
pids = []
for name in os.listdir('/proc'):
    if not name.isdecimal(): continue
    try:
        with open('/proc/' + name + '/stat') as handle:
            state = handle.read().rsplit(')', 1)[1].split()[0]
        if state != 'Z': pids.append({'pid': int(name)})
    except (FileNotFoundError, PermissionError, ProcessLookupError): pass
if len(pids) > 4096: raise SystemExit('process bound exceeded')
print(json.dumps(pids))
PY`, { user: "root", timeoutMs: 10_000 });
      return JSON.parse(result.stdout.trim());
    },
  };
  const resource = {
    sandboxId: sandbox.id,
    commands,
    getHost: (port) => togetherApplicationHost(sandbox.vmInfo.agent.url, port),
    // Admits the controller relay through the bridge port's inbound allowlist.
    get agentToken() { return sandbox.vmInfo?.agent?.token ?? null; },
    files: {
      getInfo: (path) => bounded(sandbox.files.stat(path)),
      async write(pathOrWrites, data, options = {}) {
        const writes = Array.isArray(pathOrWrites)
          ? pathOrWrites
          : [{ path: pathOrWrites, data }];
        const selected = Array.isArray(pathOrWrites) ? (data ?? {}) : options;
        for (const entry of writes) {
          requireActive(selected.signal);
          await bounded(
            sandbox.files.create(
              entry.path,
              typeof entry.data === "string"
                ? entry.data
                : new Blob([entry.data]),
            ),
          );
        }
      },
      async read(path, options = {}) {
        requireActive(options.signal);
        if (options.format !== "bytes")
          return bounded(sandbox.files.read(path));
        // The SDK read method is text-only. Transfer sealed binary artifacts as
        // base64 without decoding their arbitrary bytes as UTF-8.
        const script = `import base64, os\np=${JSON.stringify(path)}\nwith open(p, 'rb') as f:\n data=f.read(64*1024*1024+1)\n if len(data)>64*1024*1024: raise SystemExit('artifact transfer limit')\n print(base64.b64encode(data).decode('ascii'))`;
        const result = await commands.run(`python3 - <<'PY'\n${script}\nPY`, {
          user: "root",
          timeoutMs: 120_000,
          signal: options.signal,
          maxOutputBytes: 90 * 1024 * 1024,
        });
        return Buffer.from(result.stdout.trim(), "base64");
      },
    },
    async kill() {
      await bounded(sdk.sandboxes.terminate(sandbox.id, { snapshot: null }));
    },
    async isRunning() {
      return (
        (await bounded(sdk.sandboxes.get(sandbox.id))).status !== "terminated"
      );
    },
  };
  return resource;
}

export function createTogetherProvider({
  loadSdk = () => import("together-sandbox"),
} = {}) {
  const operations = createLinuxSandboxOperations();
  const provider = Object.freeze({
    async acquire({
      snapshotAlias,
      cpuCount,
      memoryMiB,
      maxLifetimeMs,
      apiKey,
      signal,
    }) {
      requireActive(signal);
      const { TogetherSandbox, createApiClient, createSandboxClient } = await loadSdk();
      const sdk = new TogetherSandbox({
        apiKey,
        baseUrl: "https://api.bartender.codesandbox.io",
        retry: { maxAttempts: 1 },
      });
      // No inherited TOGETHER_BASE_URL override; only the documented service.
      const client = createApiClient({
        baseUrl: "https://api.bartender.codesandbox.io/v1",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      // Retain the allocation ID before the SDK connects and waits for readiness.
      // Never retry or abort this mutation while its response is still pending.
      const response = await client.post({ url: "/sandboxes", headers: { "Content-Type": "application/json" }, body: {
        snapshot_alias: snapshotAlias,
        cpu: cpuCount,
        memory_bytes: memoryMiB * 1024 * 1024,
        ttl: Math.ceil(maxLifetimeMs / 1000),
        tags: { "hurdle-role": "execution" },
        // Only the controller relay may reach the bridge port; the sandbox
        // token is checked by Together ingress before the per-cell token.
        // TODO(egress): add a deny-all outbound rule once Together supports it.
        experimental: { network_policy: { inbound_allowlist: [
          { ports: [String(TOGETHER_WORKLOAD_BRIDGE_PORT)], requires_token: true },
        ] } },
      } });
      if (response.error !== undefined || typeof response.data?.id !== "string" || !response.data.id) {
        throw new Error("Together sandbox allocation failed");
      }
      const allocated = {
        sandboxId: response.data.id,
        kill: () => bounded(sdk.sandboxes.terminate(response.data.id, { snapshot: null })),
        isRunning: async () => (await bounded(sdk.sandboxes.get(response.data.id))).status !== "terminated",
      };
      try {
        requireActive(signal);
        const sandbox = await sdk.sandboxes.connect(allocated.sandboxId);
        requireActive(signal);
        // Preserve stdout/stderr metadata and permit AbortSignal on output reads.
        const outputClient = createSandboxClient({
          baseUrl: sandbox.vmInfo.agent.url,
          headers: { Authorization: `Bearer ${sandbox.vmInfo.agent.token}` },
        });
        return createTogetherResource(sandbox, sdk, outputClient);
      } catch (error) {
        await provider.dispose(allocated);
        let disposed = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            if (await provider.isDisposed(allocated)) { disposed = true; break; }
          } catch { /* retry bounded confirmation */ }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!disposed) throw new Error("Together sandbox allocation failed and termination could not be confirmed");
        throw error;
      }
    },
    async validate(resource, { signal }) {
      await resource.commands.run(
        `set -eu
install -d -o root -g root -m 0755 /home/user
node --version
python3 --version
test -x /usr/bin/setpriv
test -x /usr/bin/mount
test -x /usr/bin/mountpoint
command -v useradd >/dev/null`,
        { signal, user: "root" },
      );
    },
    ...operations,
    async dispose(resource) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await resource.kill();
          return;
        } catch (error) {
          if (error.status === 404) return;
          if (attempt >= 2) throw error;
        }
      }
    },
    async isDisposed(resource) {
      try {
        return !(await resource.isRunning());
      } catch (error) {
        if (error.status === 404) return true;
        throw error;
      }
    },
  });
  return provider;
}
