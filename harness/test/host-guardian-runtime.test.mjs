import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ensureHostGuardianRuntime,
  findHostGuardianRuntime,
  hostGuardianRuntimePaths,
} from "../lib/host-guardian-runtime.mjs";

async function cacheRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "hurdle-guardian-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("host Guardian runtime is found only after a completed install", async (t) => {
  const root = await cacheRoot(t);
  const paths = hostGuardianRuntimePaths({ cacheRoot: root });
  assert.equal(findHostGuardianRuntime({ cacheRoot: root }), null);
  await mkdir(dirname(paths.mitmdump), { recursive: true });
  await writeFile(paths.mitmdump, "");
  assert.equal(findHostGuardianRuntime({ cacheRoot: root }), null, "an interrupted install is not ready");
  await writeFile(paths.marker, "{}\n");
  assert.equal(findHostGuardianRuntime({ cacheRoot: root }).mitmdump, paths.mitmdump);
  assert.equal(await ensureHostGuardianRuntime({
    cacheRoot: root,
    fetchImpl: () => assert.fail("an installed runtime is reused"),
  }).then(({ root: installed }) => installed), paths.root);
});

test("host Guardian install refuses unsupported platforms and unpinned uv downloads", async (t) => {
  const root = await cacheRoot(t);
  await assert.rejects(
    ensureHostGuardianRuntime({ cacheRoot: root, platform: "win32-x64", fetchImpl: () => assert.fail("no download") }),
    (error) => error.code === "environment.host-guardian-platform",
  );
  let requested;
  await assert.rejects(ensureHostGuardianRuntime({
    cacheRoot: root,
    platform: "darwin-arm64",
    fetchImpl: async (url) => { requested = url; return new Response("tampered archive"); },
  }), /pinned digest/);
  assert.match(requested, /astral-sh\/uv\/releases\/download\/0\.11\.31\/uv-aarch64-apple-darwin\.tar\.gz$/);
  assert.equal(findHostGuardianRuntime({ cacheRoot: root }), null);
});
