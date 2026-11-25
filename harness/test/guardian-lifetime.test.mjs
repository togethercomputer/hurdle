import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sweepStaleGuardianDirectories } from "../lib/execution-environments/together-guardian.mjs";

const guardianPath = new URL("../verify/proxy/generic_guardian.py", import.meta.url).pathname;

// Loads the real addon with a stubbed mitmproxy module, then idles. Only the
// addon's own lifetime guards can end it early.
const IDLE = String.raw`
import os, runpy, sys, time, types
mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object, Response=object)
sys.modules["mitmproxy"] = mitmproxy
runpy.run_path(os.environ["GUARDIAN_PATH"])
print("loaded", flush=True)
time.sleep(30)
`;

async function startGuardian(t, env) {
  const directory = await mkdtemp(join(tmpdir(), "hurdle-guardian-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn("python3", ["-c", IDLE], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      GUARDIAN_PATH: guardianPath,
      TAE_EGRESS_LOG: join(directory, "requests.jsonl"),
      TAE_EGRESS_CONTROL_TOKEN: "control-token",
      TAE_EGRESS_CAPTURE_HOSTS: "[]",
      ...env(directory),
    },
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    child.stdout.once("data", (data) => (String(data).includes("loaded") ? resolve() : reject(new Error(String(data)))));
    child.once("exit", (code) => reject(new Error(`exited early with ${code}`)));
  });
  return { child, directory, exited };
}

const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("still running"), ms))]);

test("the Guardian exits and removes its directory once its controller is gone", async (t) => {
  const { child, directory, exited } = await startGuardian(t, (directory) => ({
    TAE_EGRESS_EXIT_WITH_CONTROLLER: "1",
    TAE_EGRESS_CLEANUP_DIR: directory,
  }));
  // A controller that dies, however it dies, closes this pipe.
  child.stdin.end();
  assert.equal(await within(exited, 5_000), 0);
  assert.equal(existsSync(directory), false);
});

test("the Guardian stops at its hard lifetime even while its controller lives", async (t) => {
  const { directory, exited } = await startGuardian(t, () => ({ TAE_EGRESS_MAX_LIFETIME_S: "1" }));
  assert.equal(await within(exited, 5_000), 3);
  assert.equal(existsSync(directory), true, "a live controller cleans up after itself");
});

test("without the guards, the Guardian ignores its stdin", async (t) => {
  const { child, exited } = await startGuardian(t, () => ({}));
  child.stdin.end();
  assert.equal(await within(exited, 1_500), "still running");
});

test("stale Guardian directories are swept and fresh ones kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hurdle-guardian-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const old = new Date(now - 27 * 60 * 60_000);
  for (const name of ["hurdle-guardian-old", "hurdle-guardian-fresh", "unrelated-old"]) await mkdir(join(root, name));
  await utimes(join(root, "hurdle-guardian-old"), old, old);
  await utimes(join(root, "unrelated-old"), old, old);
  await sweepStaleGuardianDirectories(root, { now });
  assert.equal(existsSync(join(root, "hurdle-guardian-old")), false);
  assert.equal(existsSync(join(root, "hurdle-guardian-fresh")), true);
  assert.equal(existsSync(join(root, "unrelated-old")), true);
});
