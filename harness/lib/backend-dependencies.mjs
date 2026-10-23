import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);

export function backendDependencyInstallCommand() {
  return existsSync(new URL("../../viewer/package.json", import.meta.url))
    ? "npm run setup:backends from the repository root"
    : "npm install hurdle --include=optional in your evaluation project";
}

export class BackendDependencyError extends Error {
  constructor(backend) {
    super(`${backend} dependencies are not installed. Run ${backendDependencyInstallCommand()}.`);
    this.code = "backend-not-installed";
  }
}

// Check installation only: never allocate a sandbox or connect to a database.
export function assertRuntimeDependencies({ environment }) {
  if (environment?.kind === "together") {
    // The sandbox SDK serves caller-owned snapshots only; the Hurdle socket
    // needs just the WebSocket client.
    const needed = environment.settings?.snapshotAlias ? ["together-sandbox", "ws"] : ["ws"];
    try { for (const name of needed) require.resolve(name); }
    catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
      throw new BackendDependencyError("Together sandbox");
    }
    return;
  }
  if (environment?.kind !== "e2b") return;
  for (const name of ["e2b", "https-proxy-agent", "ws"]) {
    try {
      require.resolve(name);
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
      throw new BackendDependencyError("E2B");
    }
  }
}
