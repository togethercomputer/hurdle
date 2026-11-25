import { readFile } from "node:fs/promises";

import { installWorkloadTrust } from "./guardian.mjs";
import { createLinuxSandboxOperations } from "./linux-sandbox-operations.mjs";
import { createLocalWorkload } from "./local-workload.mjs";
import { blockSandboxAgentPort, verifyGuardianPath } from "./together-workload-egress.mjs";

// One step of a Hurdle task, run by the server inside a Together Hurdle
// sandbox against this sandbox's own processes, so the controller only ever
// writes inputs, runs a step and reads results.
export function createSandboxTask({
  caPath,
  nodeRuntimeRoot = null,
  workload = createLocalWorkload(),
  operations = createLinuxSandboxOperations(),
} = {}) {
  const steps = {
    // Trust the controller's Guardian CA (from X-Sandbox-CA) and seal egress.
    async setup({ hosts }) {
      if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string"))
        throw new TypeError("Sandbox setup requires capture hosts");
      const certificate = await readFile(caPath, "utf8");
      // Together starts the sandbox without internet access, DNS included, so no
      // route bypasses the Guardian and there is none to refuse.
      await installWorkloadTrust(
        workload, certificate, hosts, undefined, "-legacy", "DROP",
        { systemTrust: true, nodeRuntimeRoot, captureRouteFirewall: false },
      );
      await verifyGuardianPath(workload, hosts[0]);
      await blockSandboxAgentPort(workload);
      return {};
    },
    async stage({ fixtures, workspaceFiles }) {
      await operations.stage(workload, { fixtures, workspaceFiles });
      return {};
    },
    async agent({ launchPlan, environment }, { onStdout, onStderr }) {
      const { stdinBase64, ...plan } = launchPlan;
      return operations.run(workload, {
        launchPlan: { ...plan, stdin: Buffer.from(stdinBase64 ?? "", "base64") },
        environment,
        onStdout,
        onStderr,
      });
    },
    // The sealed bytes stay in the sandbox; the controller reads each one.
    async collect({ declarations }) {
      const artifacts = await operations.collectArtifacts(workload, declarations);
      return {
        artifacts: artifacts.map(({ bytes, ...artifact }, index) => (
          artifact.status === "captured" ? { ...artifact, index } : artifact
        )),
      };
    },
    async metadata() {
      return { metadata: await operations.collectWorkspaceArtifactMetadata(workload) };
    },
  };
  return Object.freeze({
    async run(job, callbacks = {}) {
      const step = Object.hasOwn(steps, job?.kind) ? steps[job.kind] : null;
      if (!step) throw new TypeError("Unknown sandbox task step");
      return step(job, callbacks);
    },
  });
}
