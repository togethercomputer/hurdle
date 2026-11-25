import assert from "node:assert/strict";
import test from "node:test";

import {
  closeExecutionCredentialLease,
  createExecutionEnvelope,
} from "../lib/execution-envelope.mjs";
import {
  createTogetherExecutionEnvironment,
  validateSandboxEnvelope,
} from "../lib/execution-environments/together.mjs";

// Unsupported capture requests are refused before the Guardian starts or a
// sandbox is allocated, so a run that cannot be evidenced costs nothing.
function unallocatedEnvironment() {
  const calls = [];
  const refuse = (name) => async () => {
    calls.push(name);
    throw new Error(`must not ${name}`);
  };
  const environment = createTogetherExecutionEnvironment({
    apiKey: "tgp_v1_fake_sandbox_key",
    provider: {
      acquire: refuse("acquire"),
      stage: refuse("stage"),
      run: refuse("run"),
      collectArtifacts: refuse("collect"),
      dispose: refuse("dispose"),
      isDisposed: refuse("confirm"),
    },
    guardian: {
      prepare: refuse("prepare"),
      attach: refuse("attach"),
      seal: refuse("seal"),
    },
  });
  return { environment, calls };
}

function captureEnvelope(capture) {
  return {
    capture,
    workspaceArtifactMetadata: false,
    credentialBindings: [],
    launchPlan: { command: "agent", env: {} },
  };
}

test("Together rejects selected-field capture before any sandbox is allocated", async () => {
  const { environment, calls } = unallocatedEnvironment();
  const envelope = createExecutionEnvelope({
    executionId: "selected_fields_preflight",
    settings: environment.normalizeSettings({}),
    launchPlan: {
      command: "agent",
      args: [],
      env: {},
      stdin: "",
      timeoutMs: 1_000,
      workspaceFiles: [],
    },
    fixtures: [],
    outputArtifacts: [],
    target: {
      egress: {
        relevantHosts: ["api.example.com"],
        // A body field, not a response header name.
        selectedFields: ["response.id"],
      },
    },
    credentialDefinitions: [],
    credentialValues: {},
  });

  try {
    await assert.rejects(
      environment.execute(envelope),
      /Together selected-field capture is not supported/,
    );
  } finally {
    closeExecutionCredentialLease(envelope);
  }
  assert.deepEqual(calls, []);

  const route = (selectedFields) => captureEnvelope({
    mode: "network-egress-metadata-v1",
    protocols: ["https"],
    routes: [{ host: "api.example.com", selectedFields }],
  });
  for (const selectedFields of [
    ["response.id"],
    ["X-Request-Id"],
    [""],
    [42],
    "x-request-id",
    Array.from({ length: 33 }, (_, index) => `x-field-${index}`),
  ]) {
    assert.throws(
      () => validateSandboxEnvelope(route(selectedFields)),
      /Together selected-field capture is not supported/,
      JSON.stringify(selectedFields),
    );
  }
  assert.throws(
    () => validateSandboxEnvelope(captureEnvelope({
      mode: "network-egress-metadata-v1",
      routes: [{ host: "", selectedFields: [] }],
    })),
    /Together selected-field capture is not supported/,
  );
  // Response header names are the supported selected fields.
  assert.doesNotThrow(() => validateSandboxEnvelope(route(["x-request-id"])));
});

test("Together rejects malformed exchange-fact capture before any sandbox is allocated", async () => {
  const { environment, calls } = unallocatedEnvironment();
  const capture = (exchangeFacts) => ({
    mode: "network-egress-metadata-v1",
    protocols: ["https"],
    routes: [],
    exchangeFacts,
  });

  await assert.rejects(
    environment.execute(captureEnvelope(capture({ schemaVersion: 1, profiles: [] }))),
    /exchange-fact capture is not supported/,
  );
  assert.deepEqual(calls, []);

  for (const exchangeFacts of [
    { schemaVersion: 1, profiles: [] },
    {
      schemaVersion: 1,
      captureProfile: "exchange-facts-v1",
      policyFingerprint: "not-a-digest",
      profiles: [],
    },
    "exchange-facts",
    [],
  ]) {
    assert.throws(
      () => validateSandboxEnvelope(captureEnvelope(capture(exchangeFacts))),
      /exchange-fact capture is not supported/,
      JSON.stringify(exchangeFacts),
    );
  }
  // Without exchange facts the same capture request is accepted.
  assert.doesNotThrow(() => validateSandboxEnvelope(captureEnvelope(capture(undefined))));
});
