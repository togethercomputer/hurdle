import assert from "node:assert/strict";
import test from "node:test";

import { suiteKeyRoutes, suiteKeyRows } from "../lib/terminal-output.mjs";

const HOSTS = ["api.together.ai", "api.together.xyz"];

// One advisory Task (environment delivery) and one with required request
// checks (the Guardian always carries its key).
const definition = {
  target: { egress: { relevantHosts: HOSTS } },
  credentialRequirements: { TOGETHER_API_KEY: { delivery: { kind: "environment" } } },
  tasks: {
    advisory: { credentialRequirements: ["TOGETHER_API_KEY"], egress: { relevantHosts: HOSTS } },
    required: {
      credentialRequirements: ["TOGETHER_API_KEY"],
      credentialDeliveryOverrides: {
        TOGETHER_API_KEY: { kind: "captured-http-header", hosts: HOSTS, headerNames: ["authorization"] },
      },
      egress: { relevantHosts: HOSTS },
    },
    artifactOnly: { credentialRequirements: [] },
  },
};

const route = (taskIds, environment) => suiteKeyRoutes(definition, taskIds, environment);

test("a Suite key goes only to its API hosts on the Together socket", () => {
  for (const environment of [{ kind: "together" }, { kind: "together", settings: {} }]) {
    assert.deepEqual(route(["advisory", "required"], environment), [
      { name: "TOGETHER_API_KEY", hosts: HOSTS, agentVisible: false },
    ]);
  }
  assert.deepEqual(suiteKeyRows(route(["advisory"], { kind: "together" })), [
    ["Keys", "TOGETHER_API_KEY → api.together.ai, api.together.xyz"],
  ]);
});

test("the Agent holds an advisory Task's key locally", () => {
  for (const environment of [{ kind: "local" }]) {
    assert.equal(route(["advisory"], environment)[0].agentVisible, true);
    assert.equal(route(["required"], environment)[0].agentVisible, false);
  }
  assert.deepEqual(suiteKeyRows(route(["advisory", "required"], { kind: "local" })), [
    ["Keys", "TOGETHER_API_KEY → the Agent's environment"],
  ]);
});

test("only selected Tasks' keys are listed, one row per key", () => {
  assert.deepEqual(route(["artifactOnly"], { kind: "together" }), []);
  assert.deepEqual(suiteKeyRows([]), []);
  assert.deepEqual(suiteKeyRows([
    { name: "A_KEY", hosts: ["a.example.com"], agentVisible: false },
    { name: "B_KEY", hosts: ["b.example.com"], agentVisible: false },
  ]), [["Keys", "A_KEY → a.example.com"], ["", "B_KEY → b.example.com"]]);
});
