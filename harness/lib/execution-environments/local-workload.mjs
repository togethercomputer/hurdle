import { spawn } from "node:child_process";
import { chown, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createBoundedControllerCapture,
  DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
} from "../controller-transcript.mjs";

// The Linux workload contract (files and commands), served by this machine's
// own processes. The server inside a Together Hurdle sandbox runs the staging,
// launch and sealing code against it.

function abortError() {
  return Object.assign(new Error("Local command cancelled"), { name: "AbortError" });
}

async function identity(user) {
  if (!user || user === "root") return null;
  const passwd = await readFile("/etc/passwd", "utf8");
  const entry = passwd.split("\n").map((line) => line.split(":")).find(([name]) => name === user);
  if (!entry) throw new Error(`Local user is unavailable: ${user}`);
  return { uid: Number(entry[2]), gid: Number(entry[3]) };
}

export function createLocalWorkload() {
  const commands = {
    async run(command, {
      cwd, envs = {}, user, timeoutMs = 30_000, signal, onStdout, onStderr,
      maxOutputBytes = DEFAULT_CONTROLLER_CAPTURE_MAX_BYTES,
    } = {}) {
      if (signal?.aborted) throw abortError();
      const principal = await identity(user);
      const stdout = createBoundedControllerCapture(maxOutputBytes);
      const stderr = createBoundedControllerCapture(maxOutputBytes);
      const child = spawn("sh", ["-c", command], {
        cwd,
        env: { ...process.env, ...envs },
        ...(principal ?? {}),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let failure = null;
      const timers = new Set();
      const later = (milliseconds, callback) => {
        const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
        timers.add(timer);
      };
      const signalGroup = (name) => {
        try { process.kill(-child.pid, name); } catch { /* already gone */ }
      };
      // The Agent runner starts the Agent in a process group of its own and
      // forwards SIGTERM to it, so the group is asked first and killed a moment
      // later; a SIGKILL would end the runner before it could forward anything.
      const stop = (error) => {
        failure ||= error;
        signalGroup("SIGTERM");
        later(1_000, () => signalGroup("SIGKILL"));
      };
      const timer = setTimeout(() => stop(Object.assign(
        new Error("Local command timed out"), { name: "TimeoutError" },
      )), timeoutMs);
      const onAbort = () => stop(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      const collect = (capture, callback) => (chunk) => {
        const text = chunk.toString("utf8");
        if (!capture.append(text)) stop(new Error("Local command output exceeded its byte bound"));
        else callback?.(text);
      };
      child.stdout.on("data", collect(stdout, onStdout));
      child.stderr.on("data", collect(stderr, onStderr));
      try {
        const exitCode = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, killed) => resolve(Number.isInteger(code) ? code : killed ? 128 : 1));
          // A process that outlived the group, holding the pipes, must not hold
          // the result: once the shell has exited its output is as complete as
          // it will get.
          child.once("exit", () => later(1_000, () => { child.stdout.destroy(); child.stderr.destroy(); }));
        });
        if (failure) throw failure;
        const result = { exitCode, stdout: stdout.snapshot().text, stderr: stderr.snapshot().text };
        if (exitCode !== 0)
          throw Object.assign(new Error("Local command exited unsuccessfully"), result);
        return result;
      } finally {
        clearTimeout(timer);
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
  const files = {
    async write(pathOrWrites, data, options = {}) {
      const writes = Array.isArray(pathOrWrites) ? pathOrWrites : [{ path: pathOrWrites, data }];
      const selected = Array.isArray(pathOrWrites) ? (data ?? {}) : options;
      const principal = await identity(selected.user);
      for (const entry of writes) {
        if (selected.signal?.aborted) throw abortError();
        await mkdir(dirname(entry.path), { recursive: true });
        const temporary = `${entry.path}.${process.pid}.tmp`;
        await writeFile(temporary, typeof entry.data === "string"
          ? entry.data
          : Buffer.from(entry.data instanceof ArrayBuffer ? new Uint8Array(entry.data) : entry.data));
        if (principal) await chown(temporary, principal.uid, principal.gid);
        await rename(temporary, entry.path);
      }
    },
    async read(path, options = {}) {
      if (options.signal?.aborted) throw abortError();
      return options.format === "bytes" ? readFile(path) : readFile(path, "utf8");
    },
  };
  return { commands, files };
}
