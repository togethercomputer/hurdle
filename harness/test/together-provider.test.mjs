import assert from "node:assert/strict";
import test from "node:test";
import {
  createTogetherProvider,
  createTogetherResource,
  runTogetherCommand as runProviderCommand,
} from "../lib/execution-environments/together-provider.mjs";
import { checkTogetherSandboxCredential } from "../lib/credential-preflight.mjs";

function runTogetherCommand(sandbox, command, options = {}) {
  return runProviderCommand(sandbox, command, {
    readOutputEvents: () => sandbox.execs.getOutputEvents(),
    ...options,
  });
}

function sandboxFixture(events = []) {
  const deleted = [];
  return {
    deleted,
    sandbox: {
      id: "vm-id",
      execs: {
        async create(input) {
          assert.equal(input.user, "root");
          assert.equal(input.pty, false);
          return { id: "exec-id" };
        },
        async getOutputEvents() {
          return events;
        },
        async delete(id) {
          deleted.push(id);
        },
      },
    },
  };
}
test("Together preserves stdout/stderr, replay handling, and nonzero exit codes", async () => {
  const f = sandboxFixture([
    { sequence: 0, type: "stdout", output: "hello\n" },
    { sequence: 0, type: "stdout", output: "hello\n" },
    { sequence: 1, type: "stderr", output: "error\n", exitCode: 3 },
  ]);
  const captured = [];
  await assert.rejects(
    runTogetherCommand(f.sandbox, "exit 3", {
      onStdout: (value) => captured.push(value),
    }),
    (error) =>
      error.exitCode === 3 &&
      error.stdout === "hello\n" &&
      error.stderr === "error\n",
  );
  assert.deepEqual(captured, ["hello\n"]);
  assert.deepEqual(f.deleted, ["exec-id"]);
});
test("Together refuses missing exit events, invalid channels, and oversized output", async () => {
  for (const events of [
    [],
    [{ sequence: 0, type: "invalid", output: "", exitCode: 0 }],
    [{ sequence: 0, type: "stdout", output: "large", exitCode: 0 }],
  ]) {
    const f = sandboxFixture(events);
    await assert.rejects(
      runTogetherCommand(f.sandbox, "cmd", {
        maxOutputBytes: 1,
        timeoutMs: 20,
      }),
    );
    assert.deepEqual(f.deleted, ["exec-id"]);
  }
});
test("Together accepts terminal metadata on a replayed sequence without duplicating output", async () => {
  const f = sandboxFixture();
  let polls = 0;
  f.sandbox.execs.getOutputEvents = async () => [
    {
      sequence: 0,
      type: "stdout",
      output: "done\n",
      ...(polls++ ? { exitCode: 0 } : {}),
    },
  ];
  assert.deepEqual(await runTogetherCommand(f.sandbox, "cmd"), {
    exitCode: 0,
    stdout: "done\n",
    stderr: "",
  });
  assert.equal(polls, 2);
});
test("Together aborts a pending output request when the command times out", async () => {
  const f = sandboxFixture();
  let aborted = false;
  await assert.rejects(
    runTogetherCommand(f.sandbox, "cmd", {
      timeoutMs: 20,
      readOutputEvents: (id, sequence, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    }),
    { name: "TimeoutError" },
  );
  assert.equal(aborted, true);
  assert.deepEqual(f.deleted, ["exec-id"]);
});
test("Together cancellation and command timeout delete the remote exec", async () => {
  for (const cancel of [false, true]) {
    const f = sandboxFixture();
    f.sandbox.execs.getOutputEvents = async () => [];
    const controller = new AbortController();
    const pending = runTogetherCommand(f.sandbox, "cmd", {
      timeoutMs: 20,
      signal: controller.signal,
    });
    if (cancel) setImmediate(() => controller.abort());
    await assert.rejects(
      pending,
      (error) => error.name === (cancel ? "AbortError" : "TimeoutError"),
    );
    assert.deepEqual(f.deleted, ["exec-id"]);
  }
});
test("Together receives and deletes a late exec after cancellation", async () => {
  const f = sandboxFixture();
  let release;
  f.sandbox.execs.create = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const controller = new AbortController();
  const pending = runTogetherCommand(f.sandbox, "cmd", {
    signal: controller.signal,
  });
  controller.abort();
  release({ id: "late-exec" });
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(f.deleted, ["late-exec"]);
});
test("Together restricts inbound traffic, sets TTL and capacity, and disables mutation retries", async () => {
  let config, allocation;
  const provider = createTogetherProvider({
    loadSdk: async () => ({
      createApiClient() {
        return { async post({ body }) { allocation = body; return { data: { id: "vm-id" } }; } };
      },
      createSandboxClient() {
        return {};
      },
      TogetherSandbox: class {
        constructor(input) {
          config = input;
          this.sandboxes = {
            connect: async (id) => {
              assert.equal(id, "vm-id");
              return {
                id: "vm-id",
                vmInfo: {
                  agent: {
                    url: "https://agent.example.com",
                    token: "test-agent-token",
                  },
                },
              };
            },
          };
        }
      },
    }),
  });
  const resource = await provider.acquire({
    apiKey: "test-provider",
    snapshotAlias: "test@v1",
    cpuCount: 2,
    memoryMiB: 4096,
    maxLifetimeMs: 180001,
  });
  assert.equal(resource.sandboxId, "vm-id");
  assert.equal(config.retry.maxAttempts, 1);
  assert.equal(config.baseUrl, "https://api.bartender.codesandbox.io");
  assert.deepEqual(allocation, {
    snapshot_alias: "test@v1",
    cpu: 2,
    memory_bytes: 4096 * 1024 * 1024,
    ttl: 181,
    tags: { "hurdle-role": "execution" },
    // Only the bridge port is reachable, and only with the sandbox token.
    experimental: { network_policy: { inbound_allowlist: [{ ports: ["18083"], requires_token: true }] } },
  });
});
test("Together retains and terminates allocations when SDK readiness or setup fails", async t => {
  const sdk = await import("together-sandbox");
  let mode, controller, terminated, confirmations, calls;
  t.mock.method(globalThis, "fetch", async request => {
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (path === "/v1/sandboxes") {
      if (mode === "allocation") return Response.json({ message: "synthetic failure" }, { status: 503 });
      if (mode === "cancel") controller.abort();
      return Response.json({ id: "allocated-vm", status: "starting" });
    }
    if (path.endsWith("/terminate")) {
      assert.deepEqual(await request.json(), { snapshot: null });
      terminated = true;
      return Response.json({ id: "allocated-vm", status: "terminated" });
    }
    if (path.endsWith("/wait")) {
      if (!terminated && mode === "wait") return Response.json({ message: "synthetic readiness failure" }, { status: 503 });
      return Response.json({ id: "allocated-vm", status: terminated ? "terminated" : "running", agent: { url: "https://synthetic.invalid", token: "synthetic" } });
    }
    if (path === "/v1/sandboxes/allocated-vm") {
      if (terminated && confirmations++ === 0 && mode === "wait") return Response.json({}, { status: 503 });
      return Response.json({ id: "allocated-vm", status: terminated ? "terminated" : "starting" });
    }
    assert.fail(`Unexpected SDK request ${path}`);
  });
  for (mode of ["wait", "client", "cancel", "allocation"]) {
    controller = new AbortController(); terminated = false; confirmations = 0; calls = [];
    const provider = createTogetherProvider({ loadSdk: async () => mode === "client"
      ? { ...sdk, createSandboxClient() { throw Error("synthetic client failure"); } } : sdk });
    await assert.rejects(provider.acquire({ apiKey: "synthetic", snapshotAlias: "synthetic@v1", cpuCount: 1,
      memoryMiB: 2048, maxLifetimeMs: 300000, signal: controller.signal }));
    assert.equal(calls.filter(path => path === "/v1/sandboxes").length, 1);
    assert.equal(calls.filter(path => path.endsWith("/terminate")).length, mode === "allocation" ? 0 : 1);
    assert.equal(terminated, mode !== "allocation");
    if (mode !== "allocation") assert.ok(confirmations > 0);
    if (mode === "wait") assert.equal(confirmations, 2);
  }
});
test("Together polls typed output with a sequence cursor and the cancellation signal", async () => {
  const f = sandboxFixture();
  const requests = [];
  const resource = createTogetherResource(
    f.sandbox,
    {},
    {
      get: async (request) => {
        requests.push(request);
        return {
          data: [
            {
              sequence: 0,
              type: "stdout",
              output: "one",
              ...(requests.length > 1 ? { exitCode: 0 } : {}),
            },
          ],
        };
      },
    },
  );
  assert.equal((await resource.commands.run("cmd")).stdout, "one");
  assert.equal(requests[0].url, "/api/v1/execs/exec-id/io");
  assert.equal(requests[0].query, undefined);
  assert.deepEqual(requests[1].query, { lastSequence: 0 });
  assert.ok(requests[0].signal instanceof AbortSignal);
  assert.equal(requests[0].signal.aborted, true);
});

test("Together background exec returns a killable PID and deletes allocations returned after cancellation", async () => {
  for (const cancelled of [false, true]) {
    const f = sandboxFixture();
    const controller = new AbortController();
    f.sandbox.execs.create = async input => {
      assert.equal(input.env.TEST, 'value');
      if (cancelled) controller.abort();
      return { id: 'background-exec', pid: 42 };
    };
    const resource = createTogetherResource(f.sandbox, {});
    const pending = resource.commands.run('exec proxy', { background: true, envs: { TEST: 'value' }, signal: controller.signal });
    if (cancelled) await assert.rejects(pending, { name: 'AbortError' });
    else { const handle = await pending; assert.equal(handle.pid, 42); await handle.kill(); }
    assert.deepEqual(f.deleted, ['background-exec']);
  }
});

test("Together background allocation waits for its PID without losing custody of the exec", async () => {
  const f = sandboxFixture();
  f.sandbox.execs.create = async () => ({ id: 'pending-exec', pid: 0 });
  f.sandbox.execs.get = async id => { assert.equal(id, 'pending-exec'); return { id, pid: 123 }; };
  const resource = createTogetherResource(f.sandbox, {});
  const handle = await resource.commands.run('exec proxy', { background: true });
  assert.equal(handle.pid, 123);
  await handle.kill();
  assert.deepEqual(f.deleted, ['pending-exec']);
});
test("Together transfers binary artifacts without UTF-8 corruption", async () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const f = sandboxFixture([
    {
      sequence: 0,
      type: "stdout",
      output: bytes.toString("base64") + "\n",
      exitCode: 0,
    },
  ]);
  const resource = createTogetherResource(
    f.sandbox,
    {},
    { get: async () => ({ data: await f.sandbox.execs.getOutputEvents() }) },
  );
  assert.deepEqual(
    await resource.files.read("/sealed/0", { format: "bytes" }),
    bytes,
  );
});
test("Together preflight is read-only and omits provider diagnostics", async () => {
  let listed = false;
  const result = await checkTogetherSandboxCredential("key", {
    loadSdk: async () => ({
      TogetherSandbox: class {
        constructor() {
          this.snapshots = {
            list: async () => {
              listed = true;
            },
          };
        }
      },
    }),
  });
  assert.equal(listed, true);
  assert.equal(result.status, "pass");
  const rejected = await checkTogetherSandboxCredential("key", {
    loadSdk: async () => {
      throw Object.assign(new Error("private provider body"), { status: 403 });
    },
  });
  assert.equal(rejected.status, "fail");
  assert.doesNotMatch(JSON.stringify(rejected), /private provider body/);
});
test("Together preflight leaves the key to Bartender's Hurdle API", async () => {
  const env = { HURDLE_TOGETHER_RUN_URL: "wss://hurdle.test/v1/compute/experimental/run" };
  const loadSdk = async () => { throw new Error("the sandbox API is not used"); };
  assert.equal((await checkTogetherSandboxCredential("key", { loadSdk, env })).status, "skip");
  assert.equal((await checkTogetherSandboxCredential("", { loadSdk, env })).status, "fail");
});
