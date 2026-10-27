#!/usr/bin/env node

import { resolve } from "node:path";
import { SETUP_AGENT_PACKAGES } from "../lib/managed-images.mjs";
import {
  TOGETHER_SERVER_COMMAND,
  writeTogetherImageContext,
} from "../lib/together-sandbox-setup.mjs";

// Writes the build context for Together's Hurdle image: every Agent CLI plus
// the in-sandbox bridge that Together's Hurdle API starts.
const [directory] = process.argv.slice(2);
if (!directory) {
  process.stderr.write("Usage: npm run together:image-context -- <directory>\n");
  process.exitCode = 2;
} else {
  const context = resolve(directory);
  await writeTogetherImageContext(context, Object.keys(SETUP_AGENT_PACKAGES));
  process.stdout.write(`Build context: ${context}\n`);
  process.stdout.write(`Server command: ${TOGETHER_SERVER_COMMAND}\n`);
}
