import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { asset } from "./execution-environments/guardian.mjs";

// The controller-host Guardian runs a hash-locked mitmproxy. Setup installs
// it once per lock into the user's cache.
const run = promisify(execFile);
const UV_VERSION = "0.11.31";
const UV_ARCHIVES = Object.freeze({
  "darwin-arm64": ["uv-aarch64-apple-darwin", "b2b93e82a6786f9c7cb89fd4ca0e859a147b292ae8f6f95784f9742f0efec39e"],
  "darwin-x64": ["uv-x86_64-apple-darwin", "33ee6bd62b57fcd77a499deb54e4432dc1e1a2f3d34930ba987ad8b43f9c7bc7"],
  "linux-arm64": ["uv-aarch64-unknown-linux-gnu", "d74f23949fd07be4970f293d06ca99d87cd2a78a341c3d7b7fc0df7bc2d8a145"],
  "linux-x64": ["uv-x86_64-unknown-linux-gnu", "8cc1cd82d434ec565376f98bd938d4b715b5791a80ff2d3aa78821cf85091b4b"],
});
const MITMPROXY_PYTHON = "3.12.12";
const REQUIREMENTS_PATH = asset("guardian-requirements.lock");
const READY_MARKER = "ready.json";

function defaultCacheRoot() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "hurdle");
}

function runtimeKey() {
  return createHash("sha256")
    .update(`${UV_VERSION}\n${MITMPROXY_PYTHON}\n`)
    .update(readFileSync(REQUIREMENTS_PATH))
    .digest("hex")
    .slice(0, 16);
}

export function hostGuardianRuntimePaths({ cacheRoot = defaultCacheRoot() } = {}) {
  const root = join(cacheRoot, "guardian", runtimeKey());
  return Object.freeze({
    root,
    mitmdump: join(root, "venv", "bin", "mitmdump"),
    marker: join(root, READY_MARKER),
  });
}

export function hostGuardianRuntimeError() {
  return Object.assign(
    new Error("The controller-host Guardian is not installed. Run setup to install it."),
    { code: "environment.host-guardian-missing" },
  );
}

// Returns the installed runtime, or null. A missing marker means an
// interrupted install; ensureHostGuardianRuntime() rebuilds it.
export function findHostGuardianRuntime(options = {}) {
  const paths = hostGuardianRuntimePaths(options);
  return existsSync(paths.marker) && existsSync(paths.mitmdump) ? paths : null;
}

export async function ensureHostGuardianRuntime({
  cacheRoot = defaultCacheRoot(),
  platform = `${process.platform}-${process.arch}`,
  fetchImpl = fetch,
} = {}) {
  const installed = findHostGuardianRuntime({ cacheRoot });
  if (installed) return installed;
  const archive = UV_ARCHIVES[platform];
  if (!archive) {
    throw Object.assign(
      new Error(`The controller-host Guardian does not support ${platform}.`),
      { code: "environment.host-guardian-platform" },
    );
  }
  const paths = hostGuardianRuntimePaths({ cacheRoot });
  await rm(paths.root, { recursive: true, force: true });
  await mkdir(paths.root, { recursive: true });
  const [name, digest] = archive;
  const response = await fetchImpl(
    `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}.tar.gz`,
  );
  if (!response.ok) throw new Error("uv download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("uv download did not match its pinned digest");
  }
  const archivePath = join(paths.root, `${name}.tar.gz`);
  await writeFile(archivePath, bytes);
  await run("tar", ["-xzf", archivePath, "-C", paths.root]);
  const uv = join(paths.root, name, "uv");
  // Keep the interpreter and caches inside the runtime directory so the
  // install is self-contained and removable as a unit.
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
    UV_CACHE_DIR: join(paths.root, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: join(paths.root, "python"),
    UV_NO_CONFIG: "1",
  };
  const options = { env, timeout: 360_000, maxBuffer: 8 * 1024 * 1024 };
  const { stdout: version } = await run(uv, ["--version"], options);
  if (!version.includes(`uv ${UV_VERSION}`)) throw new Error("uv version mismatch");
  // --no-bin: without it uv also links python3.12 into ~/.local/bin, outside
  // the runtime directory.
  await run(uv, ["python", "install", "--no-bin", MITMPROXY_PYTHON], options);
  await run(uv, ["venv", "--clear", "--python", MITMPROXY_PYTHON, join(paths.root, "venv")], options);
  await run(uv, [
    "pip", "install", "--python", join(paths.root, "venv", "bin", "python"),
    "--require-hashes", "--no-deps", "--no-build", "-r", REQUIREMENTS_PATH,
  ], options);
  const { stdout: mitmproxy } = await run(paths.mitmdump, ["--version"], options);
  const mitmproxyVersion = /Mitmproxy: (\S+)/.exec(mitmproxy)?.[1];
  if (!mitmproxyVersion) throw new Error("mitmdump did not report a version");
  await rm(join(paths.root, "uv-cache"), { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await writeFile(paths.marker, `${JSON.stringify({ uv: UV_VERSION, python: MITMPROXY_PYTHON, mitmproxy: mitmproxyVersion })}\n`);
  return paths;
}

export async function describeHostGuardianRuntime(options = {}) {
  const installed = findHostGuardianRuntime(options);
  if (!installed) return null;
  try { return JSON.parse(await readFile(installed.marker, "utf8")); } catch { return null; }
}
