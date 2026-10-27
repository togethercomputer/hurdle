#!/usr/bin/env node

import { join } from "node:path";

import { ARTIFACT_ROOT } from "../lib/execution-environments/linux-sandbox-operations.mjs";
import { createSandboxServer, TASK_ROOT } from "../lib/execution-environments/sandbox-server.mjs";
import { createSandboxTask } from "../lib/execution-environments/sandbox-task.mjs";

// Started by Together's Hurdle API inside every Hurdle sandbox.
// The sandbox lives as long as the one connection it serves.
const caPath = `${TASK_ROOT}/guardian-ca.pem`;
const task = createSandboxTask({
  caPath,
  // The image installs the Agent's Node runtime next to this harness.
  nodeRuntimeRoot: join(import.meta.dirname, "..", ".."),
});
const server = createSandboxServer({
  runTask: (job, callbacks) => task.run(job, callbacks),
  caPath,
  readRoots: [ARTIFACT_ROOT],
  onClosed: () => process.exit(0),
});
const { port, flowPort } = await server.listen();
process.stdout.write(`READY sandbox ${port} ${flowPort}\n`);
