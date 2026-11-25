import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLinuxSandboxOperations,
  snapshotSandboxProcesses,
  validateArtifactDeclarations,
} from "../lib/execution-environments/linux-sandbox-operations.mjs";

const PF_KTHREAD = 0x00200000;
const linuxProc = existsSync("/proc/2/stat") && existsSync("/usr/bin/python3");

function isKernelThread(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[6]) & PF_KTHREAD) !== 0;
  } catch {
    return false;
  }
}

// The census script runs inside sandboxes; this host's /proc stands in for one.
test("the sandbox process census ignores kernel threads", { skip: !linuxProc && "requires Linux /proc and /usr/bin/python3" }, async (t) => {
  assert.ok(isKernelThread(2), "kthreadd must be a kernel thread for this test to be meaningful");
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => sleeper.kill());
  const workload = {
    commands: {
      async run(script) {
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
      },
    },
  };

  const pids = (await snapshotSandboxProcesses(workload)).map(([pid]) => pid);

  // Kernel workers come and go with disk writeback and cannot be signalled;
  // counting them made busy sandbox runs fail their quiescence check.
  assert.deepEqual(pids.filter(isKernelThread), []);
  assert.ok(pids.includes(sleeper.pid), "user processes must still be counted");
});

const AGENT_UID = 1001;

// A fake workload that answers the controller's process census and principal
// lookups, recording the runner source and launch plan the controller writes.
function censusWorkload({ baseline = [], remaining = [], onRunner = async () => ({ exitCode: 0 }) } = {}) {
  const written = {};
  const cleanupCommands = [];
  return {
    written,
    cleanupCommands,
    files: {
      async write(path, data, options) {
        assert.equal(options.user, "root");
        written[path] = data;
      },
    },
    commands: {
      async run(command, options = {}) {
        assert.equal(options.user, "root");
        if (command.startsWith("id -u")) {
          return { exitCode: 0, stdout: `${AGENT_UID}\n${AGENT_UID}\n` };
        }
        if (command.includes("TAE_PROCESS_CENSUS_SNAPSHOT")) {
          return { exitCode: 0, stdout: `TAE_PROCESS_CENSUS_SNAPSHOT=${JSON.stringify(baseline)}\n` };
        }
        if (command.includes("TAE_PROCESS_CENSUS_CLEANUP")) {
          cleanupCommands.push(command);
          return {
            exitCode: 0,
            stdout: `TAE_PROCESS_CENSUS_CLEANUP=${JSON.stringify({ remaining })}\n`,
          };
        }
        if (command.includes("/run.mjs")) return onRunner(command, options);
        return { exitCode: 0 };
      },
    },
  };
}

function writtenEnding(workload, suffix) {
  const entry = Object.entries(workload.written).find(([path]) => path.endsWith(suffix));
  assert.ok(entry, `expected the controller to write ${suffix}`);
  return entry[1];
}

const agentLaunch = (overrides = {}) => ({
  launchPlan: { command: "agent", args: [], env: {}, stdin: "", timeoutMs: 1_000, ...overrides },
  environment: {},
  onStdout() {},
  onStderr() {},
});

test("artifact collection refuses an absolute or escaping path before any sandbox work", async () => {
  let calls = 0;
  const workload = {
    commands: { async run() { calls += 1; } },
    files: {
      async write() { calls += 1; },
      async read() { calls += 1; },
    },
  };
  const declaration = (path) => ({ path, kind: "text", maxBytes: 1024, required: true });

  for (const path of ["/etc/passwd", "../outside.txt", "outputs/../../outside.txt", "outputs//a.txt", "./a.txt", "a\0b"]) {
    assert.throws(
      () => validateArtifactDeclarations([declaration(path)]),
      /must stay inside the workspace/,
      JSON.stringify(path),
    );
    await assert.rejects(
      createLinuxSandboxOperations().collectArtifacts(workload, [declaration(path)]),
      /must stay inside the workspace/,
      JSON.stringify(path),
    );
  }
  assert.equal(calls, 0);
  assert.doesNotThrow(() => validateArtifactDeclarations([declaration("outputs/allowed.txt")]));
});

test("artifact collection refuses a manifest that escaped its sealed path", async () => {
  const declaration = {
    path: "outputs/allowed.txt",
    kind: "text",
    maxBytes: 1024,
    required: true,
  };
  let helperSource = "";
  let helperCommand = "";
  const reads = [];
  const workload = {
    commands: {
      async run(command, options) {
        helperCommand = command;
        assert.equal(options.user, "root");
        return { exitCode: 0 };
      },
    },
    files: {
      async write(path, data, options) {
        assert.equal(options.user, "root");
        if (path.endsWith("collect-artifacts.py")) helperSource = data;
      },
      async read(path, options) {
        reads.push(path);
        assert.equal(options.user, "root");
        if (path.endsWith("artifact-manifest.json")) {
          return JSON.stringify([{
            ...declaration,
            status: "captured",
            // A workload-controlled path outside the sealed root.
            sealedPath: "/tmp/tae-e2b/workspace/undeclared/private.txt",
            sizeBytes: 6,
            sha256: `sha256:${"0".repeat(64)}`,
            textEncoding: "utf8",
          }]);
        }
        return Buffer.from("secret");
      },
    },
  };

  await assert.rejects(
    createLinuxSandboxOperations().collectArtifacts(workload, [declaration]),
    /escaped its sealed path/,
  );
  // Only the manifest was read: the escaped path was never followed.
  assert.equal(reads.length, 1);
  assert.match(reads[0], /artifact-manifest\.json$/);
  // The helper reads as the Agent and seals as root, and runs only if its
  // digest matches the source the controller wrote.
  assert.match(helperSource, /os\.seteuid\(identity\.pw_uid\)/);
  assert.match(helperSource, /os\.seteuid\(0\)/);
  assert.match(helperSource, /descriptor = os\.open/);
  assert.match(helperCommand, /artifact helper hash mismatch/);
});

const python3 = spawnSync("python3", ["--version"]).status === 0;

// Runs a census script the controller sent against a fake /proc table:
// { pid: { start, ppid } }. Signals to a pid in `killable` end that process;
// other processes survive. Returns the script's stdout plus the signals sent.
const FAKE_PROC_PRELUDE = String.raw`
import builtins, io, json, os, sys, time
_TABLE = json.loads(sys.argv[1])
_KILLABLE = set(json.loads(sys.argv[2]))
_SELF = "4242"
_SIGNALS = []
_real_open = builtins.open
def _entry(pid):
    return {"start": "1", "ppid": 1} if pid == _SELF else _TABLE.get(pid)
def _open(path, *args, **kwargs):
    if isinstance(path, str) and path.startswith("/proc/"):
        _, _, pid, name = path.split("/")
        entry = _entry(pid)
        if entry is None:
            raise FileNotFoundError(path)
        if name == "stat":
            fields = ["S", str(entry["ppid"])] + ["0"] * 17 + [entry["start"]]
            return io.StringIO(pid + " (fake) " + " ".join(fields) + "\n")
        if name == "status":
            return io.StringIO("PPid:\t" + str(entry["ppid"]) + "\n")
    return _real_open(path, *args, **kwargs)
builtins.open = _open
_real_listdir = os.listdir
os.listdir = lambda path=".": list(_TABLE) + [_SELF] if path == "/proc" else _real_listdir(path)
os.getpid = lambda: int(_SELF)
def _kill(pid, sig):
    _SIGNALS.append([pid, int(sig)])
    if pid in _KILLABLE:
        _TABLE.pop(str(pid), None)
os.kill = _kill
time.sleep = lambda seconds: None
import atexit
atexit.register(lambda: print("TEST_SIGNALS=" + json.dumps(_SIGNALS)))
`;

function runCensusScript(command, table, killable = []) {
  const script = /<<'PY'\n([\s\S]*)\nPY$/.exec(command)?.[1];
  assert.ok(script, "the census runs an inline Python script");
  const result = spawnSync("python3", ["-", JSON.stringify(table), JSON.stringify(killable)], {
    input: `${FAKE_PROC_PRELUDE}\n${script}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const signals = JSON.parse(/^TEST_SIGNALS=(.*)$/m.exec(result.stdout)[1]);
  return { stdout: result.stdout, signals };
}

// The real snapshot and cleanup scripts run under Python; only /proc, kill
// and sleep are faked.
function pythonCensusWorkload({ before, after, killable }) {
  const workload = censusWorkload();
  const sent = [];
  const run = workload.commands.run;
  workload.commands.run = async (command, options = {}) => {
    if (command.includes("TAE_PROCESS_CENSUS_SNAPSHOT")) {
      return { exitCode: 0, stdout: runCensusScript(command, before).stdout };
    }
    if (command.includes("TAE_PROCESS_CENSUS_CLEANUP")) {
      const { stdout, signals } = runCensusScript(command, after, killable);
      sent.push(...signals);
      return { exitCode: 0, stdout };
    }
    return run(command, options);
  };
  return { workload, sent };
}

test("process facts fail closed when a baseline PID is reused", { skip: !python3 && "python3 is unavailable" }, async () => {
  const SIGTERM = 15;
  const SIGKILL = 9;
  // Before the Agent: PID 2 and PID 10 exist. During the run PID 10 exits and
  // the Agent's child takes PID 10 (a new start time); PID 12 is new too.
  // Neither of PID 10's processes can be stopped; PID 12 exits on a signal.
  const before = { 2: { start: "100", ppid: 1 }, 10: { start: "200", ppid: 1 } };
  const reused = pythonCensusWorkload({
    before,
    after: { 2: { start: "100", ppid: 1 }, 10: { start: "999", ppid: 1 }, 12: { start: "500", ppid: 1 } },
    killable: [12],
  });

  const facts = await createLinuxSandboxOperations().run(reused.workload, agentLaunch());

  // The reused PID is not the baseline process: it is signalled, survives,
  // and the run is not quiescent. The unchanged baseline process is untouched.
  // Three rounds of SIGTERM, then SIGKILL.
  assert.deepEqual(reused.sent.filter(([pid]) => pid === 10).map(([, signal]) => signal), [SIGTERM, SIGKILL, SIGTERM, SIGKILL, SIGTERM, SIGKILL]);
  assert.deepEqual(reused.sent.filter(([pid]) => pid === 12), [[12, SIGTERM]]);
  assert.equal(reused.sent.some(([pid]) => pid === 2), false);
  assert.equal(facts.exitCode, 0);
  assert.equal(facts.quiescent, false);
  assert.equal(facts.spawnError, null);

  // Control: when PID 10 still names the baseline process, it is left alone
  // and the run is quiescent once PID 12 exits.
  const unchanged = pythonCensusWorkload({
    before,
    after: { 2: { start: "100", ppid: 1 }, 10: { start: "200", ppid: 1 }, 12: { start: "500", ppid: 1 } },
    killable: [12],
  });
  const settled = await createLinuxSandboxOperations().run(unchanged.workload, agentLaunch());
  assert.deepEqual(unchanged.sent, [[12, SIGTERM]]);
  assert.equal(settled.quiescent, true);
});

test("the Agent runner drops privileges with --clear-groups and --no-new-privs", async () => {
  const workload = censusWorkload();
  await createLinuxSandboxOperations().run(workload, agentLaunch({
    command: "agent",
    args: ["--print"],
    stdin: "prompt",
  }));

  const runner = writtenEnding(workload, "/run.mjs");
  const launch = JSON.parse(writtenEnding(workload, "/launch.json"));
  assert.match(runner, /spawn\("\/usr\/bin\/setpriv", \[/);
  assert.match(runner, /"--reuid=" \+ plan\.uid,\s+"--regid=" \+ plan\.gid,\s+"--clear-groups",\s+"--no-new-privs",\s+"--",\s+plan\.command,\s+\.\.\.plan\.args,/);
  assert.match(runner, /PATH: plan\.env\.PATH \?\? process\.env\.PATH/);
  assert.match(runner, /SHELL: plan\.env\.SHELL \?\? process\.env\.SHELL/);
  assert.equal(launch.uid, AGENT_UID);
  assert.equal(launch.gid, AGENT_UID);
  assert.equal(launch.command, "agent");
  assert.deepEqual(launch.args, ["--print"]);
  assert.equal(Buffer.from(launch.stdinBase64, "base64").toString(), "prompt");
});

// Runs the runner the controller wrote, with setpriv swapped for a recorder,
// so the privilege-dropping argv is checked on any OS without root.
test("the Agent runner passes the plan's principal and command to setpriv", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hurdle-runner-setpriv-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workload = censusWorkload();
  await createLinuxSandboxOperations().run(workload, agentLaunch({
    command: "agent",
    args: ["--print", "two words"],
    stdin: "prompt bytes",
  }));
  const runner = writtenEnding(workload, "/run.mjs");
  const launch = JSON.parse(writtenEnding(workload, "/launch.json"));
  const setpriv = join(root, "setpriv");
  writeFileSync(setpriv, [
    "#!/bin/sh",
    'for arg in "$@"; do printf "%s\\n" "$arg"; done > "$SETPRIV_ARGV"',
    'cat > "$SETPRIV_STDIN"',
    "exit 7",
    "",
  ].join("\n"));
  chmodSync(setpriv, 0o755);
  const runnerPath = join(root, "run.mjs");
  assert.ok(runner.includes('"/usr/bin/setpriv"'));
  writeFileSync(runnerPath, runner.replace('"/usr/bin/setpriv"', JSON.stringify(setpriv)));
  const launchPath = join(root, "launch.json");
  writeFileSync(launchPath, JSON.stringify({
    ...launch,
    cwd: root,
    env: {
      ...launch.env,
      SETPRIV_ARGV: join(root, "argv.txt"),
      SETPRIV_STDIN: join(root, "stdin.txt"),
    },
  }));

  const result = spawnSync(process.execPath, [runnerPath], {
    env: { PATH: process.env.PATH, TAE_LAUNCH_PLAN: launchPath },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(readFileSync(join(root, "argv.txt"), "utf8").split("\n").slice(0, -1), [
    `--reuid=${AGENT_UID}`,
    `--regid=${AGENT_UID}`,
    "--clear-groups",
    "--no-new-privs",
    "--",
    "agent",
    "--print",
    "two words",
  ]);
  assert.equal(readFileSync(join(root, "stdin.txt"), "utf8"), "prompt bytes");
});
