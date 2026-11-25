import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

function setupError(code, message) { return Object.assign(new Error(message), { code }); }

export async function regularFileContents(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw setupError("setup.file", "Setup needs regular .env.local, .gitignore, and Runtime files; symbolic links are not supported.");
    return await readFile(path, "utf8");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function atomicWrite(path, text, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { mode, flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

// Keeps the project's credentials and results out of git. Returns true when
// .gitignore changed. Existing entries are kept; init and setup share this.
export async function ignoreProjectFiles(cwd) {
  const ignore = join(cwd, ".gitignore");
  const ignored = await regularFileContents(ignore) ?? "";
  // Append last so an earlier negation cannot accidentally expose credentials.
  const protectedPaths = "/.env.local\n/.hurdle/\n/.tae/";
  if (ignored.trimEnd().split("\n").slice(-3).join("\n") === protectedPaths) return false;
  await atomicWrite(ignore, `${ignored}${ignored.endsWith("\n") || !ignored ? "" : "\n"}${protectedPaths}\n`, 0o644);
  return true;
}

export async function saveCredentials(cwd, values) {
  await ignoreProjectFiles(cwd);
  if (!Object.keys(values).length) return;
  const path = join(cwd, ".env.local");
  const existing = await regularFileContents(path) ?? "";
  const lines = Object.entries(values).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !/^[\x21-\x7e]+$/.test(value)) throw setupError("setup.credential", "Enter a nonblank credential without spaces or line breaks.");
    return `${name}=${JSON.stringify(value)}`;
  });
  // Preserve comments and existing credentials; the env parser uses the last
  // assignment when replacing an empty value entered during earlier setup.
  await atomicWrite(path, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${lines.join("\n")}\n`, 0o600);
}
