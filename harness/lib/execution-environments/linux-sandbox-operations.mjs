import { readFile } from "node:fs/promises";

import { sha256 } from "../run-model.mjs";

const WORKSPACE_ROOT = "/tmp/tae-e2b";
const WORKSPACE = `${WORKSPACE_ROOT}/workspace`;
const CONTROL_ROOT = "/home/user/.tae-controller";
const AGENT_USER = "tae-agent";
const LAUNCH_PATH = `${CONTROL_ROOT}/launch.json`;
const RUNNER_PATH = `${CONTROL_ROOT}/run.mjs`;
const ARTIFACT_DECLARATIONS = `${CONTROL_ROOT}/artifacts.json`;
const ARTIFACT_MANIFEST = `${CONTROL_ROOT}/artifact-manifest.json`;
export const ARTIFACT_ROOT = `${CONTROL_ROOT}/sealed-artifacts`;
const ARTIFACT_HELPER = `${CONTROL_ROOT}/collect-artifacts.py`;
const WORKSPACE_METADATA_HELPER = `${CONTROL_ROOT}/collect-workspace-metadata.py`;
const WORKSPACE_METADATA_MANIFEST = `${CONTROL_ROOT}/workspace-metadata.json`;
const INPUT_DIRECTORIES = `${CONTROL_ROOT}/input-directories.json`;
const FIXED_WORKSPACE_LAYOUT = Object.freeze({
  schemaVersion: 1,
  workingDirectory: "/home/user/workspace",
  homeDirectory: "/home/user",
  temporaryDirectory: "/tmp",
});

const REMOTE_RUNNER = `
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const plan = JSON.parse(await readFile(process.env.TAE_LAUNCH_PLAN, "utf8"));
const environment = {
  ...plan.env,
  PATH: plan.env.PATH ?? process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  SHELL: plan.env.SHELL ?? process.env.SHELL ?? "/bin/sh",
};
const child = spawn("/usr/bin/setpriv", [
  "--reuid=" + plan.uid,
  "--regid=" + plan.gid,
  "--clear-groups",
  "--no-new-privs",
  "--",
  plan.command,
  ...plan.args,
], {
  cwd: plan.cwd,
  env: environment,
  detached: true,
  stdio: ["pipe", "inherit", "inherit"],
});
let forced = null;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function groupExists() {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
function forward(signal) {
  try { process.kill(-child.pid, signal); } catch {}
  if (signal !== "SIGKILL") {
    forced ||= setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, 1000);
  }
}
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGTERM"));
child.stdin.end(Buffer.from(plan.stdinBase64, "base64"));
child.on("error", () => process.exit(127));
child.on("exit", async (code, signal) => {
  if (forced) clearTimeout(forced);
  if (groupExists()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    await wait(250);
  }
  if (groupExists()) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await wait(250);
  }
  process.exitCode = groupExists()
    ? 125
    : Number.isInteger(code) ? code : signal ? 128 : 1;
});
`;

const REMOTE_ARTIFACT_HELPER = `
import errno
import hashlib
import json
import os
import pwd
import stat

WORKSPACE = ${JSON.stringify(WORKSPACE)}
DECLARATIONS = ${JSON.stringify(ARTIFACT_DECLARATIONS)}
MANIFEST = ${JSON.stringify(ARTIFACT_MANIFEST)}
SEALED_ROOT = ${JSON.stringify(ARTIFACT_ROOT)}
TOTAL_LIMIT = 64 * 1024 * 1024

with open(DECLARATIONS, "r", encoding="utf-8") as handle:
    declarations = json.load(handle)
os.makedirs(SEALED_ROOT, mode=0o700, exist_ok=True)
results = []
captured_total = 0
identity = pwd.getpwnam(${JSON.stringify(AGENT_USER)})
controller_egid = os.getegid()
controller_groups = os.getgroups()

def rejected(declaration, reason):
    return {**declaration, "status": "rejected", "reason": reason}

def enter_agent_identity():
    try:
        os.setgroups([])
        os.setegid(identity.pw_gid)
        os.seteuid(identity.pw_uid)
    except OSError:
        restore_controller_identity()
        raise

def restore_controller_identity():
    os.seteuid(0)
    os.setegid(controller_egid)
    os.setgroups(controller_groups)

for index, declaration in enumerate(declarations):
    relative = declaration["path"]
    if (
        not isinstance(relative, str)
        or os.path.isabs(relative)
        or chr(0) in relative
    ):
        results.append(rejected(declaration, "invalid_path"))
        continue
    parts = relative.split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        results.append(rejected(declaration, "invalid_path"))
        continue
    current = WORKSPACE
    outcome = None
    data = None
    before = None
    after = None
    try:
        enter_agent_identity()
        try:
            for position, part in enumerate(parts):
                current = os.path.join(current, part)
                info = os.lstat(current)
                if stat.S_ISLNK(info.st_mode):
                    outcome = rejected(declaration, "symlink")
                    break
                if position < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
                    outcome = rejected(declaration, "parent_not_directory")
                    break
                if position == len(parts) - 1:
                    if not stat.S_ISREG(info.st_mode):
                        outcome = rejected(declaration, "not_regular_file")
                        break
                    if info.st_nlink != 1:
                        outcome = rejected(declaration, "hard_link")
                        break
            if outcome is None:
                descriptor = os.open(current, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(descriptor, "rb", closefd=True) as source:
                    before = os.fstat(source.fileno())
                    if not stat.S_ISREG(before.st_mode):
                        outcome = rejected(declaration, "not_regular_file")
                    elif before.st_nlink != 1:
                        outcome = rejected(declaration, "hard_link")
                    elif before.st_size > declaration["maxBytes"]:
                        outcome = rejected(declaration, "too_large")
                    else:
                        data = source.read(declaration["maxBytes"] + 1)
                        after = os.fstat(source.fileno())
        except FileNotFoundError:
            outcome = {**declaration, "status": "missing"}
        except OSError as error:
            outcome = rejected(declaration, "symlink" if error.errno == errno.ELOOP else "unreadable")
        finally:
            restore_controller_identity()
    except OSError:
        outcome = rejected(declaration, "unreadable")
    if outcome is not None:
        results.append(outcome)
        continue
    try:
        if len(data) > declaration["maxBytes"]:
            results.append(rejected(declaration, "too_large"))
            continue
        if (before.st_dev, before.st_ino, before.st_size) != (after.st_dev, after.st_ino, after.st_size):
            results.append(rejected(declaration, "changed_during_read"))
            continue
        captured_total += len(data)
        if captured_total > TOTAL_LIMIT:
            results.append(rejected(declaration, "total_limit_exceeded"))
            continue
        text_encoding = None
        if declaration["kind"] == "text":
            try:
                data.decode("utf-8", errors="strict")
                text_encoding = "utf8"
            except UnicodeDecodeError:
                results.append(rejected(declaration, "invalid_utf8"))
                continue
        sealed_path = os.path.join(SEALED_ROOT, str(index))
        with open(sealed_path, "xb") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        result = {
            **declaration,
            "status": "captured",
            "sealedPath": sealed_path,
            "sizeBytes": len(data),
            "sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
        }
        if text_encoding is not None:
            result["textEncoding"] = text_encoding
        results.append(result)
    except OSError as error:
        results.append(rejected(declaration, "symlink" if error.errno == errno.ELOOP else "unreadable"))

with open(MANIFEST, "x", encoding="utf-8") as handle:
    json.dump(results, handle, separators=(",", ":"))
    handle.flush()
    os.fsync(handle.fileno())
`;

const REMOTE_WORKSPACE_METADATA_HELPER = `
import json
import os
import re
import stat

WORKSPACE = ${JSON.stringify(WORKSPACE)}
MANIFEST = ${JSON.stringify(WORKSPACE_METADATA_MANIFEST)}
CONTROLLER_OWNED = re.compile(r"^(?:session(?:-[^/]+)?\\.jsonl|output\\.(?:json|txt)|audit\\.json|audit-error\\.json|deep-audit\\.json|result\\.json|retry-trail\\.json|lifecycle-continuation\\.json|sandbox-info\\.json|together_requests\\.jsonl|deterministic-checks\\.json|suggestions\\.md|claude-agent-sdk-(?:events|stream)-[^/]+\\.jsonl)$", re.I)
AGENT_RECEIPT = re.compile(r"^[\\w.-]+-receipt\\.json$", re.I)

results = []
for name in sorted(os.listdir(WORKSPACE)):
    if name.startswith(".") or name == "node_modules":
        continue
    if CONTROLLER_OWNED.match(name) or AGENT_RECEIPT.match(name):
        continue
    path = os.path.join(WORKSPACE, name)
    try:
        info = os.lstat(path)
    except OSError:
        continue
    if not stat.S_ISREG(info.st_mode):
        continue
    results.append({"path": name, "bytes": info.st_size, "source": "controller_capture"})
    if len(results) >= 200:
        break

descriptor = os.open(MANIFEST, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    json.dump(results, handle, separators=(",", ":"))
`;

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function pinnedBytes(source) {
  if (source.kind === "generated") return Buffer.from(source.bytes);
  return readFile(source.pinnedPath);
}

function selectedWorkspaceLayout(layout) {
  if (layout === undefined) {
    return {
      workingDirectory: WORKSPACE,
      homeDirectory: `${WORKSPACE}/.home`,
      temporaryDirectory: `${WORKSPACE}/.tmp`,
      pathPrefix: null,
    };
  }
  if (JSON.stringify(layout) !== JSON.stringify(FIXED_WORKSPACE_LAYOUT)) {
    throw new TypeError("Remote Linux fixed workspace layout is unsupported");
  }
  return {
    ...FIXED_WORKSPACE_LAYOUT,
    pathPrefix: `${FIXED_WORKSPACE_LAYOUT.homeDirectory}/.local/bin`,
  };
}

async function prepareWorkspaceLayout(workload, layout, signal) {
  const selected = selectedWorkspaceLayout(layout);
  if (layout === undefined) return selected;
  await workload.commands.run(`set -eu
python3 - <<'PY'
import os, pwd, stat
parent = ${JSON.stringify(FIXED_WORKSPACE_LAYOUT.homeDirectory)}
target = ${JSON.stringify(FIXED_WORKSPACE_LAYOUT.workingDirectory)}
identity = pwd.getpwnam(${JSON.stringify(AGENT_USER)})
info = os.stat(parent, follow_symlinks=False)
if not stat.S_ISDIR(info.st_mode):
    raise SystemExit("fixed workspace parent is not a directory")
if info.st_uid == identity.pw_uid:
    writable = bool(info.st_mode & stat.S_IWUSR)
elif info.st_gid == identity.pw_gid:
    writable = bool(info.st_mode & stat.S_IWGRP)
else:
    writable = bool(info.st_mode & stat.S_IWOTH)
if writable:
    raise SystemExit("fixed workspace parent directory is writable by the Agent")
if os.path.lexists(target) and os.path.islink(target):
    raise SystemExit("fixed workspace target cannot be a symlink")
if not os.path.exists(target):
    os.mkdir(target, 0o700)
if not os.path.ismount(target):
    if not stat.S_ISDIR(os.lstat(target).st_mode) or os.listdir(target):
        raise SystemExit("fixed workspace target is not an empty directory")
    os.chown(target, 0, 0)
    os.chmod(target, 0o700)
PY
if ! /usr/bin/mountpoint -q ${FIXED_WORKSPACE_LAYOUT.workingDirectory}; then
  /usr/bin/mount --bind ${WORKSPACE} ${FIXED_WORKSPACE_LAYOUT.workingDirectory}
  /usr/bin/mount --make-private ${FIXED_WORKSPACE_LAYOUT.workingDirectory}
fi
python3 - <<'PY'
import os
source = os.stat(${JSON.stringify(WORKSPACE)})
target = os.stat(${JSON.stringify(FIXED_WORKSPACE_LAYOUT.workingDirectory)})
if (source.st_dev, source.st_ino) != (target.st_dev, target.st_ino):
    raise SystemExit("fixed workspace bind mount identity mismatch")
PY`, {
    timeoutMs: 30_000,
    signal,
    user: "root",
  });
  return selected;
}

export function validateArtifactDeclarations(declarations) {
  if (!Array.isArray(declarations) || declarations.length > 32) {
    throw new TypeError("Remote Linux Output Artifact declarations must be a bounded array");
  }
  for (const declaration of declarations) {
    const parts = typeof declaration?.path === "string"
      ? declaration.path.split("/")
      : [];
    if (
      parts.length === 0
      || declaration.path.startsWith("/")
      || parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
    ) {
      throw new TypeError("Remote Linux Output Artifact path must stay inside the workspace");
    }
  }
}

async function stageInputs(sandbox, { fixtures, workspaceFiles, signal }) {
  const writes = [];
  const expected = [];
  for (const fixture of fixtures) {
    const bytes = await readFile(fixture.pinnedPath);
    if (Number.isSafeInteger(fixture.maxBytes) && bytes.byteLength > fixture.maxBytes) {
      throw new Error(
        `Pinned fixture '${fixture.source}' exceeds its ${fixture.maxBytes}-byte limit`,
      );
    }
    if (sha256(bytes) !== fixture.sha256) throw new Error("Pinned fixture changed");
    writes.push({ path: `${WORKSPACE}/${fixture.workspacePath}`, data: arrayBuffer(bytes) });
    expected.push({ path: fixture.workspacePath, sha256: fixture.sha256 });
  }
  for (const file of workspaceFiles) {
    const bytes = await pinnedBytes(file.source);
    if (sha256(bytes) !== file.source.sha256) throw new Error("Pinned workspace input changed");
    writes.push({ path: `${WORKSPACE}/${file.path}`, data: arrayBuffer(bytes) });
    expected.push({ path: file.path, sha256: file.source.sha256 });
  }
  await sandbox.commands.run(`set -eu
test -x /usr/bin/setpriv
if ! id -u ${AGENT_USER} >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin ${AGENT_USER}
fi
agent_group="$(id -gn ${AGENT_USER})"
install -d -o root -g root -m 0700 ${CONTROL_ROOT}
install -d -o root -g root -m 0711 ${WORKSPACE_ROOT}
install -d -o ${AGENT_USER} -g "$agent_group" -m 0700 ${WORKSPACE} ${WORKSPACE}/.home ${WORKSPACE}/.tmp`, {
    timeoutMs: 30_000,
    signal,
    user: "root",
  });
  const directories = [...new Set(expected.map(({ path }) => (
    path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
  )).filter(Boolean))];
  await sandbox.files.write(INPUT_DIRECTORIES, JSON.stringify(directories), {
    signal,
    user: "root",
  });
  await sandbox.commands.run(`python3 - <<'PY'
import json, os, pwd
root = ${JSON.stringify(WORKSPACE)}
identity = pwd.getpwnam(${JSON.stringify(AGENT_USER)})
with open(${JSON.stringify(INPUT_DIRECTORIES)}, "r", encoding="utf-8") as handle:
    directories = json.load(handle)
for relative in directories:
    parts = relative.split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise SystemExit("invalid input directory")
    path = os.path.join(root, *parts)
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chown(path, identity.pw_uid, identity.pw_gid)
PY`, { timeoutMs: 30_000, signal, user: "root" });
  if (writes.length > 0) {
    await sandbox.files.write(writes, { signal, user: AGENT_USER });
  }
  await sandbox.files.write(
    `${CONTROL_ROOT}/expected.json`,
    JSON.stringify(expected),
    { signal, user: "root" },
  );
  await sandbox.commands.run(`python3 - <<'PY'
# Seal staged input ownership after the SDK write; SDK backends may create
# files as the controller even when an isolated user is requested.
import json, os, pwd, stat
root = ${JSON.stringify(WORKSPACE)}
identity = pwd.getpwnam(${JSON.stringify(AGENT_USER)})
with open(${JSON.stringify(`${CONTROL_ROOT}/expected.json`)}, "r", encoding="utf-8") as handle:
    expected = json.load(handle)
root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    for entry in expected:
        parts = entry["path"].split("/")
        parent_fd = os.dup(root_fd)
        try:
            for part in parts[:-1]:
                next_fd = os.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=parent_fd,
                )
                os.close(parent_fd)
                parent_fd = next_fd
            descriptor = os.open(
                parts[-1],
                os.O_RDONLY | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
            try:
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode):
                    raise SystemExit("invalid staged input ownership target")
                os.fchown(descriptor, identity.pw_uid, identity.pw_gid)
                os.fchmod(descriptor, 0o600)
            finally:
                os.close(descriptor)
        finally:
            os.close(parent_fd)
finally:
    os.close(root_fd)
PY`, { timeoutMs: 30_000, signal, user: "root" });
  await sandbox.commands.run(`python3 - <<'PY'
import hashlib, json, os
root = ${JSON.stringify(WORKSPACE)}
with open(${JSON.stringify(`${CONTROL_ROOT}/expected.json`)}, "r", encoding="utf-8") as handle:
    expected = json.load(handle)
for entry in expected:
    path = os.path.join(root, *entry["path"].split("/"))
    with open(path, "rb") as handle:
        actual = "sha256:" + hashlib.sha256(handle.read()).hexdigest()
    if actual != entry["sha256"]:
        raise SystemExit("staged input hash mismatch")
PY`, { timeoutMs: 30_000, signal, user: "root" });
}

function markerPayload(stdout, marker) {
  const line = String(stdout ?? "")
    .split("\n")
    .find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error("Remote Linux process census did not return controller evidence");
  return JSON.parse(line.slice(marker.length));
}

// Kernel threads (PF_KTHREAD) appear with disk writeback, ignore signals and
// never run Agent code; counting them made busy runs falsely non-quiescent.
// Zombies hold no code either and cannot be signalled away: a sandbox whose
// PID 1 does not reap orphans (Together's Pint) keeps one for every child a
// killed Agent left behind, which would make every timed-out run non-quiescent.
const PROCESS_START_TIME_PY = `def start_time(pid):
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="ascii") as handle:
            suffix = handle.read().rsplit(")", 1)[1].split()
        if suffix[0] == "Z" or int(suffix[6]) & 0x00200000:
            return None
        return suffix[19]
    except (FileNotFoundError, PermissionError, IndexError, ValueError):
        return None`;

export async function snapshotSandboxProcesses(workload, signal) {
  const marker = "TAE_PROCESS_CENSUS_SNAPSHOT=";
  const result = await workload.commands.run(`/usr/bin/python3 - <<'PY'
import json, os

${PROCESS_START_TIME_PY}

pids = {
    int(name): start_time(int(name)) for name in os.listdir("/proc")
    if name.isdigit() and int(name) > 1
}
pids = {pid: started for pid, started in pids.items() if started is not None}
current = os.getpid()
while current > 1:
    pids.pop(current, None)
    try:
        with open(f"/proc/{current}/status", "r", encoding="ascii") as handle:
            current = next(
                int(line.split(":", 1)[1].strip())
                for line in handle if line.startswith("PPid:")
            )
    except (FileNotFoundError, PermissionError, StopIteration, ValueError):
        break
identities = [[pid, pids[pid]] for pid in sorted(pids)]
print(${JSON.stringify(marker)} + json.dumps(identities, separators=(",", ":")))
PY`, { timeoutMs: 10_000, signal, user: "root" });
  const values = markerPayload(result.stdout, marker);
  if (
    !Array.isArray(values)
    || values.some((identity) => (
      !Array.isArray(identity)
      || identity.length !== 2
      || !Number.isSafeInteger(identity[0])
      || identity[0] <= 1
      || typeof identity[1] !== "string"
      || !/^\d+$/.test(identity[1])
    ))
  ) {
    throw new Error("Remote Linux process census returned invalid controller evidence");
  }
  return values;
}

async function terminateUntrackedProcesses(workload, baseline) {
  const marker = "TAE_PROCESS_CENSUS_CLEANUP=";
  const result = await workload.commands.run(`/usr/bin/python3 - <<'PY'
import json, os, signal, time
baseline = {int(pid): started for pid, started in ${JSON.stringify(baseline)}}

${PROCESS_START_TIME_PY}

def census():
    identities = {
        int(name): start_time(int(name)) for name in os.listdir("/proc")
        if name.isdigit() and int(name) > 1
    }
    return {
        pid: started for pid, started in identities.items()
        if started is not None
    }

def parent(pid):
    try:
        with open(f"/proc/{pid}/status", "r", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("PPid:"):
                    return int(line.split(":", 1)[1].strip())
    except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
        pass
    return 0

protected = set()
current = os.getpid()
while current > 1:
    protected.add(current)
    current = parent(current)

def candidates():
    return sorted(
        pid for pid, started in census().items()
        if pid not in protected and baseline.get(pid) != started
    )

for _ in range(3):
    untracked = candidates()
    if not untracked:
        break
    for pid in untracked:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    time.sleep(0.25)
    for pid in candidates():
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    time.sleep(0.25)

remaining = candidates()
print(${JSON.stringify(marker)} + json.dumps({"remaining": remaining}, separators=(",", ":")))
PY`, { timeoutMs: 10_000, user: "root" });
  const evidence = markerPayload(result.stdout, marker);
  return Array.isArray(evidence?.remaining) && evidence.remaining.length === 0;
}

// Shared controller-owned staging, process census, and artifact sealing.
// These paths retain the original sandbox layout for image compatibility.
export function createLinuxSandboxOperations() {
  return Object.freeze({
    async stage(workload, input) {
      await stageInputs(workload, input);
    },
    async run(workload, { launchPlan, environment, onStdout, onStderr, signal }) {
      const workspaceLayout = await prepareWorkspaceLayout(
        workload,
        launchPlan.workspaceLayout,
        signal,
      );
      await workload.files.write(RUNNER_PATH, REMOTE_RUNNER, {
        signal,
        user: "root",
      });
      const identity = await workload.commands.run(
        `id -u ${AGENT_USER} && id -g ${AGENT_USER}`,
        { timeoutMs: 10_000, signal, user: "root" },
      );
      const [uid, gid] = String(identity.stdout ?? "")
        .trim()
        .split("\n")
        .map(Number);
      if (![uid, gid].every((value) => Number.isSafeInteger(value) && value > 0)) {
        throw new Error("Remote Linux agent principal is unavailable");
      }
      const stdinBytes = typeof launchPlan.stdin === "string"
        ? Buffer.from(launchPlan.stdin)
        : Buffer.from(launchPlan.stdin ?? new Uint8Array());
      await workload.files.write(
        LAUNCH_PATH,
        JSON.stringify({
          command: launchPlan.command,
          args: launchPlan.args ?? [],
          cwd: workspaceLayout.workingDirectory,
          env: {
            ...environment,
            HOME: workspaceLayout.homeDirectory,
            TMPDIR: workspaceLayout.temporaryDirectory,
            PWD: workspaceLayout.workingDirectory,
            ...(workspaceLayout.pathPrefix
              ? {
                  PATH: `${workspaceLayout.pathPrefix}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
                }
              : {}),
          },
          stdinBase64: stdinBytes.toString("base64"),
          uid,
          gid,
        }),
        { signal, user: "root" },
      );
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      const baseline = await snapshotSandboxProcesses(workload, signal);
      let facts;
      try {
        const result = await workload.commands.run(`node ${RUNNER_PATH}`, {
          cwd: WORKSPACE,
          envs: { TAE_LAUNCH_PLAN: LAUNCH_PATH },
          onStdout,
          onStderr,
          timeoutMs: launchPlan.timeoutMs,
          signal,
          user: "root",
        });
        facts = {
          exitCode: result.exitCode,
          signal: null,
          timedOut: false,
          spawnError: null,
          quiescent: true,
          startedAt,
        };
      } catch (error) {
        if (Number.isInteger(error?.exitCode)) {
          const quiescent = error.exitCode !== 125;
          facts = {
            exitCode: quiescent ? error.exitCode : null,
            signal: null,
            timedOut: false,
            spawnError: null,
            quiescent,
            startedAt,
          };
        } else {
          const timedOut = error?.name === "TimeoutError";
          facts = {
            exitCode: null,
            signal: null,
            timedOut,
            spawnError: timedOut ? null : "remote-process-unavailable",
            quiescent: false,
            startedAt,
          };
        }
      }
      let workloadQuiescent = false;
      try {
        workloadQuiescent = await terminateUntrackedProcesses(workload, baseline);
      } catch { /* fail closed below */ }
      return {
        ...facts,
        quiescent: workloadQuiescent,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
    },
    async collectArtifacts(workload, declarations) {
      validateArtifactDeclarations(declarations);
      await workload.files.write(
        ARTIFACT_DECLARATIONS,
        JSON.stringify(declarations),
        { user: "root" },
      );
      await workload.files.write(ARTIFACT_HELPER, REMOTE_ARTIFACT_HELPER, {
        user: "root",
      });
      const helperDigest = sha256(Buffer.from(REMOTE_ARTIFACT_HELPER));
      await workload.commands.run(`/usr/bin/python3 - <<'PY'
import hashlib, os
path = ${JSON.stringify(ARTIFACT_HELPER)}
expected = ${JSON.stringify(helperDigest)}
descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
with os.fdopen(descriptor, "rb", closefd=True) as handle:
    source = handle.read()
actual = "sha256:" + hashlib.sha256(source).hexdigest()
if actual != expected:
    raise SystemExit("artifact helper hash mismatch")
exec(compile(source, path, "exec"), {"__name__": "__main__", "__file__": path})
PY`, {
        timeoutMs: 120_000,
        user: "root",
      });
      const manifest = JSON.parse(await workload.files.read(
        ARTIFACT_MANIFEST,
        { user: "root" },
      ));
      if (!Array.isArray(manifest) || manifest.length !== declarations.length) {
        throw new Error("Remote Linux artifact manifest does not match its declarations");
      }
      const capturedAt = new Date().toISOString();
      const artifacts = [];
      const rejectionReasons = new Set([
        "changed_during_read",
        "hard_link",
        "invalid_path",
        "invalid_utf8",
        "not_regular_file",
        "parent_not_directory",
        "symlink",
        "too_large",
        "total_limit_exceeded",
        "unreadable",
      ]);
      for (const [index, result] of manifest.entries()) {
        const declaration = declarations[index];
        if (
          !result
          || typeof result !== "object"
          || result.path !== declaration.path
          || result.kind !== declaration.kind
          || result.maxBytes !== declaration.maxBytes
          || result.required !== declaration.required
          || !["captured", "missing", "rejected"].includes(result.status)
        ) {
          throw new Error("Remote Linux artifact manifest contains an undeclared result");
        }
        if (result.status !== "captured") {
          if (
            (result.status === "missing" && result.reason !== undefined)
            || (
              result.status === "rejected"
              && !rejectionReasons.has(result.reason)
            )
          ) {
            throw new Error("Remote Linux artifact manifest contains an invalid rejection");
          }
          artifacts.push({
            ...declaration,
            status: result.status,
            ...(result.status === "rejected" ? { reason: result.reason } : {}),
            capturedAt,
          });
          continue;
        }
        const sealedPath = `${ARTIFACT_ROOT}/${index}`;
        if (result.sealedPath !== sealedPath) {
          throw new Error("Remote Linux artifact manifest escaped its sealed path");
        }
        const bytes = Buffer.from(await workload.files.read(sealedPath, {
          format: "bytes",
          user: "root",
        }));
        if (
          bytes.byteLength > declaration.maxBytes
          || bytes.byteLength !== result.sizeBytes
          || sha256(bytes) !== result.sha256
        ) {
          artifacts.push({
            ...declaration,
            status: "rejected",
            reason: "changed_during_transfer",
            capturedAt,
          });
          continue;
        }
        if (
          declaration.kind === "text"
          && result.textEncoding !== "utf8"
        ) {
          throw new Error("Remote Linux text artifact is not valid UTF-8");
        }
        if (declaration.kind === "text") {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            artifacts.push({
              ...declaration,
              status: "rejected",
              reason: "invalid_utf8",
              capturedAt,
            });
            continue;
          }
        }
        artifacts.push({
          ...declaration,
          status: "captured",
          bytes,
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
          ...(declaration.kind === "text" ? { textEncoding: "utf8" } : {}),
          capturedAt,
        });
      }
      return artifacts;
    },
    async collectWorkspaceArtifactMetadata(workload) {
      await workload.files.write(
        WORKSPACE_METADATA_HELPER,
        REMOTE_WORKSPACE_METADATA_HELPER,
        { user: "root" },
      );
      const helperDigest = sha256(Buffer.from(REMOTE_WORKSPACE_METADATA_HELPER));
      await workload.commands.run(`/usr/bin/python3 - <<'PY'
import hashlib, os
path = ${JSON.stringify(WORKSPACE_METADATA_HELPER)}
expected = ${JSON.stringify(helperDigest)}
descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
with os.fdopen(descriptor, "rb", closefd=True) as handle:
    source = handle.read()
actual = "sha256:" + hashlib.sha256(source).hexdigest()
if actual != expected:
    raise SystemExit("workspace metadata helper hash mismatch")
exec(compile(source, path, "exec"), {"__name__": "__main__", "__file__": path})
PY`, {
        timeoutMs: 120_000,
        user: "root",
      });
      return JSON.parse(await workload.files.read(
        WORKSPACE_METADATA_MANIFEST,
        { user: "root" },
      ));
    },
  });
}
