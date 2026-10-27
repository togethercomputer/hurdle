import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFrameworkCli } from "../bin/hurdle.mjs";
import { resolveV1Suite } from "../lib/v1-authoring.mjs";
import { fileURLToPath } from "node:url";

// Legacy main 0cf8a821793c48597b863735b1fe67149102fc9e task wording plus one
// final newline per prompt file; fixture bytes are unchanged. This guards the
// ported files, not byte-identical legacy Judge inputs or score continuity.
const prompts = {
  "chat-app": "087011650e7562fa3fefbd85092b1ae059e116e700fe2f02d36f8f3ec85f76ea",
  "tool-calling-agent-loop": "a60213cd8a2a18b016a4ffe5f4136b97f686a77bcbc448c28fd8b4d1a3d2a51d",
  "gpu-clusters": "c51271baa59f8c2e9356dda085fed98109cdb18efb3446375a8c8d8561aa1939",
  "vision-bench": "a9f6631a9266cfb9462aad574289f22c5f7f1bf5859ac4fe6e4f2a130c851a98",
  "voice-agent": "8d71071a4892524bbce6d4040c94bac1be98fb649beb73be84669234f553d97c",
  "batch-job": "7d8e7eba6a7810e0f9b64da77e54d3ef808a06cdf62ee7a78444ec0a391d48bc",
  "finetune": "4b6dffb859b1a2580219a8d28930ef752438d2007eb8daa688d17abd99da72bd",
};
const defaultTasks = ["chat-app", "gpu-clusters", "tool-calling-agent-loop"];
const catalogueOnlyTasks = ["batch-job", "finetune", "vision-bench", "voice-agent"];
const fixtures = [
  ["chat-app", "harness/fixtures/sample-audio.wav", "27199da79537461580c481d1f094f4ef85125bc99a8d9169a15372b067574b37"],
  ["voice-agent", "harness/fixtures/voice-agent-sample.wav", "c1c19f624dc5016a6c76ba89ad3327ed2eb9abc262b23b11dec772c2e831d8a5"],
  ["finetune", "harness/fixtures/finetune-sample.jsonl", "2d7cfab80df238b183cc86d9c08e80c27ebacf56522f9b29dc09a677c99f5a4b"],
];
const together = new URL("../../evals/together/", import.meta.url);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Frozen legacy harness/audit-all.mjs:201-261 at 0cf8a821793c48597b863735b1fe67149102fc9e.
// Exact cooked template text from "Be strict" through the final "wrong.";
// excludes the legacy evidence envelope and response-schema instructions.
const legacyRubricHash = "8830a8888d3eeaa05b6bd058e52ba59729587a7d0a82702c7c135173cff3a602";
// Git object ids of skills/together-ai and LICENSE in togethercomputer/skills
// at this commit. The vendored copy is unmodified; refresh all three together.
const upstreamSkills = {
  commit: "f59f28e7e7d5937e50581fcfef87b957e8ee8636",
  skillTree: "4eed8ed5d387d114c797c630a323d01642980c21",
  license: "5f4a6d288be6620fddde90ebf8137a86a968f118",
};
const gitObject = (type, bytes) => createHash("sha1").update(`${type} ${bytes.byteLength}\0`).update(bytes).digest("hex");
function gitTree(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return { mode: "40000", name: entry.name, order: `${entry.name}/`, id: gitTree(path) };
    const mode = statSync(path).mode & 0o111 ? "100755" : "100644";
    return { mode, name: entry.name, order: entry.name, id: gitObject("blob", readFileSync(path)) };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.order), Buffer.from(right.order)));
  return gitObject("tree", Buffer.concat(entries.flatMap(({ mode, name, id }) => [Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")])));
}

test("the Together catalogue preserves all seven ported legacy task prompts and fixture bytes", () => {
  assert.deepEqual(readdirSync(new URL("tasks/", together)).sort(), Object.keys(prompts).sort());
  for (const [task, expected] of Object.entries(prompts)) {
    assert.equal(sha(readFileSync(new URL(`tasks/${task}/prompt.md`, together))), expected, task);
  }
  for (const [task, path, expected] of fixtures) {
    assert.equal(sha(readFileSync(new URL(`tasks/${task}/workspace/${path}`, together))), expected, path);
  }
});

test("Together legacy Suite uses only three Judge tasks and the vendored Together skill", async (t) => {
  const suite = await resolveV1Suite({ suitePath: fileURLToPath(new URL("legacy.suite.mjs", together)) });
  t.after(() => suite.dispose());
  assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
  assert.deepEqual([...suite.defaults.taskIds].sort(), defaultTasks);
  assert.deepEqual(suite.defaults.conditionIds, ["baseline", "mcp", "skills"]);
  assert.equal(suite.defaults.repeat, 1);
  const tasks = Object.values(suite.value.definition.tasks);
  assert.ok(tasks.every(task => typeof task.evaluation.deterministicEvaluator === "string" && task.evaluation.authority.defaultProfileId === "v1-judge"));
  assert.equal(suite.value.definition.authorityProfiles[0].checkPolicy.defaultRule, "advisory");
  assert.equal(suite.value.definition.tasks["chat-app"].fixtures[0].workspacePath, "harness/fixtures/sample-audio.wav");
  const selectedSkills = suite.value.definition.conditions.skills.resources.skills.map(({ name }) => name);
  assert.deepEqual(selectedSkills, readdirSync(new URL("skills/", together), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(new URL("skills/" + entry.name + "/SKILL.md", together))).map(entry => entry.name).sort());
  assert.deepEqual(selectedSkills, ["together-ai"]);
});

test("the vendored Together skill and LICENSE are the pinned upstream files", () => {
  assert.equal(
    gitTree(fileURLToPath(new URL("skills/together-ai/", together))),
    upstreamSkills.skillTree,
    `skills/together-ai must match togethercomputer/skills@${upstreamSkills.commit} exactly; remove local files such as .DS_Store, or refresh it as evals/together/README.md describes`,
  );
  assert.equal(gitObject("blob", readFileSync(new URL("skills/LICENSE", together))), upstreamSkills.license);
});

test("all seven Tasks compile with the exact legacy decision rubric and original staged fixture paths", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tae-legacy-catalogue-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL("tasks/", together), join(root, "tasks"), { recursive: true });
  const suitePath = join(root, "catalogue.suite.mjs");
  writeFileSync(suitePath, `import { defineSuite } from "tae"; export default defineSuite(${JSON.stringify({
    tasks: Object.keys(prompts).map(id => `./tasks/${id}`),
    agents: [{ runner: "claude-code", model: "claude-sonnet-4-6" }],
    conditions: { baseline: { skills: [], mcpServers: [] } },
    repeats: 1, verdict: "judge", judge: { model: "claude-opus-4-8" },
  })});\n`);
  const suite = await resolveV1Suite({ suitePath });
  t.after(() => suite.dispose());
  assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
  assert.deepEqual(suite.defaults.taskIds, Object.keys(prompts));
  for (const [id, task] of Object.entries(suite.value.definition.tasks)) {
    assert.equal(sha(task.prompt), prompts[id], id);
    assert.equal(task.evaluation.authority.defaultProfileId, "v1-judge");
    assert.equal(task.evaluation.authority.bindings.length, 1);
    const rubric = task.evaluation.authority.bindings[0].rubric;
    assert.equal(sha(rubric), legacyRubricHash, `${id} compiled rubric must match frozen legacy bytes`);
    assert.equal(Buffer.byteLength(rubric), 3465, id);
    assert.equal(typeof task.evaluation.deterministicEvaluator, defaultTasks.includes(id) ? "string" : "undefined");
  }
  for (const [task, path, expected] of fixtures) {
    const [fixture] = suite.value.definition.tasks[task].fixtures;
    assert.equal(fixture.workspacePath, path);
    assert.equal(sha(readFileSync(join(suite.value.sourceRoot, fixture.source))), expected);
  }
});

test("shipped Together Suites and task filters cannot enable catalogue-only Tasks", async (t) => {
  for (const file of readdirSync(together).filter(file => file.endsWith(".suite.mjs"))) {
    const suitePath = fileURLToPath(new URL(file, together));
    const suite = await resolveV1Suite({ suitePath });
    t.after(() => suite.dispose());
    assert.equal(suite.ok, true, JSON.stringify(suite.diagnostics));
    assert.ok(suite.defaults.taskIds.every(id => defaultTasks.includes(id)), file);
    let effects = 0;
    const unexpectedEffect = () => { effects += 1; throw new Error("Unselected Task reached execution"); };
    const cli = createFrameworkCli({
      env: {},
      createRunEngine: unexpectedEffect,
      createAgentAdapter: unexpectedEffect,
      createLocalExecutionEnvironment: unexpectedEffect,
      createAnthropicJsonJudge: unexpectedEffect,
      openLocalResultStore: unexpectedEffect,
      openPostgresResultStore: unexpectedEffect,
    }).main;
    for (const task of catalogueOnlyTasks) {
      let output = "";
      const stream = { write(value) { output += value; } };
      const code = await cli(["run", suitePath, "--task", task], { cwd: fileURLToPath(together), stdout: stream, stderr: stream });
      assert.equal(code, 2, output);
      assert.ok(output.includes(`Task '${task}' does not exist`), output);
      assert.ok(output.includes(task));
    }
    assert.equal(effects, 0);
  }
});
