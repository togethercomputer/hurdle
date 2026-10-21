import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureCompatibilityDiagnostics,
  createCaptureRequest,
  normalizeEgressCollections,
} from "../lib/egress-evidence.mjs";
import {
  exchangeFactProfileDiagnostics,
  normalizeExchangeFactProfiles,
  normalizeExchangeFacts,
} from "../lib/exchange-facts.mjs";
import { createRunEngineWithWriter } from "../lib/run-engine.mjs";
import { resolveTestRunPlan } from "./helpers/run-plan-starter.mjs";

const observedAt = "2026-08-24T10:00:00.000Z";
const conformance = JSON.parse(readFileSync(
  new URL("./fixtures/exchange-facts-conformance/policy-v1.json", import.meta.url),
  "utf8",
));

function exchangeFactProfiles() {
  return [{
    id: "generic-json-exchange",
    match: {
      method: "POST",
      paths: ["/v1/exchanges"],
      statusCodes: [200],
    },
    requestJson: [{
      id: "item-identifiers",
      pointer: "/messages/*/item_id",
      maxMatches: 8,
      projection: { kind: "sha256-string", maxInputBytes: 256 },
    }],
    responseJson: [
      {
        id: "item-count",
        pointer: "/choices/0/items",
        projection: { kind: "count", maxItems: 8 },
      },
      {
        id: "items-present",
        pointer: "/choices/0/items",
        projection: { kind: "present" },
      },
    ],
  }];
}

function definitionWithProfiles(profiles = exchangeFactProfiles()) {
  return {
    schemaVersion: 1,
    target: {
      id: "example-target",
      displayName: "Example Target",
      egress: {
        relevantHosts: ["api.example.com"],
        selectedFields: [],
        protocols: ["https"],
        exchangeFactProfiles: profiles,
      },
    },
    credentialRequirements: {},
    conditions: { default: { displayName: "Default" } },
    tasks: {
      "inspect-exchange": {
        prompt: "Inspect the synthetic exchange.",
        fixtures: [],
        credentialRequirements: [],
        evaluation: { deterministicEvaluator: "evaluators/check.mjs" },
      },
    },
  };
}

function writeDefinition(root, definition) {
  mkdirSync(join(root, "evaluators"), { recursive: true });
  writeFileSync(
    join(root, "evaluators", "check.mjs"),
    "export function evaluate() { return { checks: [], targetMetrics: {} }; }\n",
  );
  writeFileSync(join(root, "run-plan.json"), `${JSON.stringify(definition, null, 2)}\n`);
}

async function resolveDefinition(t, definition) {
  const root = mkdtempSync(join(tmpdir(), "tae-exchange-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policies = [
    [definition.target.egress, "/target/egress/exchangeFactProfiles"],
    ...Object.values(definition.tasks).map((task) => [
      task.egress,
      "/tasks/egress/exchangeFactProfiles",
    ]),
  ].filter(([egress]) => egress?.exchangeFactProfiles);
  const diagnostics = policies.flatMap(([egress, pointer]) => (
    exchangeFactProfileDiagnostics(egress.exchangeFactProfiles, {
      pointer,
      relevantHosts: egress.relevantHosts,
    })
  ));
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  for (const [egress] of policies) {
    egress.exchangeFactProfiles = normalizeExchangeFactProfiles(egress.exchangeFactProfiles);
  }
  writeDefinition(root, definition);
  return {
    ok: true,
    value: await resolveTestRunPlan({ sourceRoot: root }),
    diagnostics: [],
  };
}

test("a RunPlan resolves a bounded product-neutral exchange-fact policy", async (t) => {
  const resolved = await resolveDefinition(t, definitionWithProfiles());

  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const capture = createCaptureRequest(resolved.value.definition.target);
  assert.equal(capture.mode, "network-egress-metadata-v1");
  assert.deepEqual(capture.routes, [{ host: "api.example.com", selectedFields: [] }]);
  assert.equal(capture.exchangeFacts.schemaVersion, 1);
  assert.equal(
    capture.exchangeFacts.captureProfile,
    "bounded-json-exchange-facts-v1",
  );
  assert.match(capture.exchangeFacts.policyFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    capture.exchangeFacts.policyFingerprint,
    conformance.expectedPolicyFingerprint,
  );
  assert.deepEqual(capture.exchangeFacts.profiles, exchangeFactProfiles());
  assert.equal(JSON.stringify(capture).includes("together"), false);
});

test("exchange-fact profiles support bounded whole-segment path templates", async (t) => {
  const profiles = exchangeFactProfiles();
  delete profiles[0].match.paths;
  profiles[0].match.pathTemplates = [
    "/v2/projects/{segment}/endpoints/{segment}/deployments",
  ];
  const resolved = await resolveDefinition(t, definitionWithProfiles(profiles));

  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const capture = createCaptureRequest(resolved.value.definition.target);
  assert.deepEqual(capture.exchangeFacts.profiles[0].match, {
    method: "POST",
    pathTemplates: ["/v2/projects/{segment}/endpoints/{segment}/deployments"],
    statusCodes: [200],
  });
  const normalized = normalizeExchangeFacts({
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint: capture.exchangeFacts.policyFingerprint,
    profileId: "generic-json-exchange",
    request: {
      "item-identifiers": { state: "absent" },
    },
    response: {
      "item-count": { state: "absent" },
      "items-present": { state: "absent" },
    },
  }, capture.exchangeFacts, {
    kind: "http-request",
    method: "POST",
    path: "/v2/projects/project-1/endpoints/ep-1/deployments",
    statusCode: 200,
  });
  assert.equal(normalized.profileId, "generic-json-exchange");

  const collection = normalizeEgressCollections({
    collections: [{
      status: "captured",
      requests: [{
        kind: "http-request",
        sequence: 0,
        observedAt,
        method: "POST",
        scheme: "https",
        host: "api.example.com",
        path: "/v2/projects/project-1/endpoints/ep-1/deployments",
        statusCode: 200,
        durationMs: 1,
        selectedFields: {},
        exchangeFacts: normalized,
      }],
      provenance: {
        producer: "controlled-environment",
        authority: "environment",
        lifecyclePhase: "execution",
        capturedAt: observedAt,
        trust: "environment-observed",
      },
    }],
    selectedFieldNames: [],
    exchangeFactProfiles: resolved.value.definition.target.egress.exchangeFactProfiles,
    redactText: String,
  });
  assert.equal(collection[0].requests[0].exchangeFacts.profileId, "generic-json-exchange");

  const overlapping = structuredClone(profiles[0]);
  overlapping.id = "overlapping-template";
  overlapping.match.pathTemplates = [
    "/v2/projects/project-1/endpoints/{segment}/deployments",
  ];
  const rejected = await resolveDefinition(t, definitionWithProfiles([profiles[0], overlapping]));
  assert.equal(rejected.ok, false);
  assert.ok(rejected.diagnostics.some(({ code }) => (
    code === "egress.exchange-fact-match-overlap"
  )), JSON.stringify(rejected.diagnostics));
});

test("RunPlan resolution rejects ambiguous or retention-unsafe fact policies", async (t) => {
  const scenarios = [
    {
      name: "unsafe content pointer",
      mutate(profiles) {
        profiles[0].requestJson[0].pointer = "/messages/*/content";
      },
      code: "egress.exchange-fact-pointer-sensitive",
    },
    {
      name: "partial-segment path template",
      mutate(profiles) {
        delete profiles[0].match.paths;
        profiles[0].match.pathTemplates = ["/v2/projects/project-{segment}/endpoints"];
      },
      code: "egress.exchange-fact-match-invalid",
    },
    {
      name: "invalid RFC 6901 escape",
      mutate(profiles) {
        profiles[0].requestJson[0].pointer = "/messages/*/bad~2key";
      },
      code: "egress.exchange-fact-pointer-invalid",
    },
    {
      name: "too many pointer segments",
      mutate(profiles) {
        profiles[0].requestJson[0].pointer = `/${Array.from({ length: 17 }, () => "key").join("/")}`;
        delete profiles[0].requestJson[0].maxMatches;
      },
      code: "egress.exchange-fact-pointer-invalid",
    },
    {
      name: "too many pointer wildcards",
      mutate(profiles) {
        profiles[0].requestJson[0].pointer = "/*/*/*/id";
      },
      code: "egress.exchange-fact-pointer-invalid",
    },
    {
      name: "pointer exceeds UTF-8 bound",
      mutate(profiles) {
        profiles[0].requestJson[0].pointer = `/${"é".repeat(128)}`;
        delete profiles[0].requestJson[0].maxMatches;
      },
      code: "egress.exchange-fact-pointer-invalid",
    },
    {
      name: "wildcard without a match bound",
      mutate(profiles) {
        delete profiles[0].requestJson[0].maxMatches;
      },
      code: "egress.exchange-fact-pointer-invalid",
    },
    {
      name: "match bound without a wildcard",
      mutate(profiles) {
        profiles[0].responseJson[0].maxMatches = 2;
      },
      code: "egress.exchange-fact-pointer-invalid",
    },
    {
      name: "duplicate selector ID",
      mutate(profiles) {
        profiles[0].responseJson[1].id = profiles[0].responseJson[0].id;
      },
      code: "egress.exchange-fact-selector-duplicate",
    },
    {
      name: "clear scalar projection",
      mutate(profiles) {
        profiles[0].responseJson[0].projection = {
          kind: "scalar",
          type: "string",
        };
      },
      code: "egress.exchange-fact-projection-invalid",
    },
    {
      name: "canonical JSON projection",
      mutate(profiles) {
        profiles[0].requestJson[0].projection = {
          kind: "sha256-canonical-json-string",
          maxInputBytes: 256,
        };
      },
      code: "egress.exchange-fact-projection-invalid",
    },
    {
      name: "duplicate profile ID",
      mutate(profiles) {
        const duplicate = structuredClone(profiles[0]);
        duplicate.match.paths = ["/v1/other-exchanges"];
        profiles.push(duplicate);
      },
      code: "egress.exchange-fact-profile-duplicate",
    },
    {
      name: "overlapping exact matches",
      mutate(profiles) {
        profiles.push({
          ...structuredClone(profiles[0]),
          id: "overlapping-exchange",
        });
      },
      code: "egress.exchange-fact-match-overlap",
    },
    {
      name: "match path includes a query",
      mutate(profiles) {
        profiles[0].match.paths = ["/v1/exchanges?debug=true"];
      },
      code: "egress.exchange-fact-match-invalid",
    },
    {
      name: "too many selectors in one profile",
      mutate(profiles) {
        profiles[0].responseJson = Array.from({ length: 24 }, (_, index) => ({
          id: `response-${index}`,
          pointer: `/response/${index}`,
          projection: { kind: "present" },
        }));
      },
      code: "egress.exchange-fact-selector-limit",
    },
    {
      name: "too many selectors across profiles",
      mutate(profiles) {
        profiles.splice(0, profiles.length, ...Array.from({ length: 3 }, (_, profileIndex) => ({
          id: `generic-exchange-${profileIndex}`,
          match: {
            method: "POST",
            paths: [`/v1/exchanges/${profileIndex}`],
            statusCodes: [200],
          },
          requestJson: [],
          responseJson: Array.from({ length: 22 }, (_, selectorIndex) => ({
            id: `fact-${profileIndex}-${selectorIndex}`,
            pointer: `/facts/${selectorIndex}`,
            projection: { kind: "present" },
          })),
        })));
      },
      code: "egress.exchange-fact-selector-limit",
    },
  ];

  for (const scenario of scenarios) {
    const profiles = exchangeFactProfiles();
    scenario.mutate(profiles);
    const resolved = await resolveDefinition(t, definitionWithProfiles(profiles));
    assert.equal(resolved.ok, false, scenario.name);
    assert.ok(
      resolved.diagnostics.some(({ code }) => code === scenario.code),
      `${scenario.name}: ${JSON.stringify(resolved.diagnostics)}`,
    );
  }
});

test("exchange-fact policies require an effective capture host", async (t) => {
  const definition = definitionWithProfiles();
  definition.target.egress.relevantHosts = [];

  const resolved = await resolveDefinition(t, definition);

  assert.equal(resolved.ok, false);
  assert.ok(resolved.diagnostics.some(({ code }) => (
    code === "egress.exchange-fact-hosts-required"
  )), JSON.stringify(resolved.diagnostics));
});

test("capture compatibility rejects exchange-fact Tasks before allocation", async (t) => {
  const resolved = await resolveDefinition(t, definitionWithProfiles());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const definitions = resolved.value.definition;
  const input = {
    targetDefinition: definitions.target,
    taskDefinitions: definitions.tasks,
    cells: [{ taskId: "inspect-exchange" }],
  };

  assert.deepEqual(captureCompatibilityDiagnostics({
    ...input,
    environment: {
      id: "metadata-only",
      captureCapabilities: { protocols: ["https"], selectedFields: true },
    },
  }), [{
    category: "capability",
    code: "matrix.capture-unsupported",
    message: "Execution Environment 'metadata-only' cannot capture exchange facts required by the selected Targets.",
    environmentId: "metadata-only",
    exchangeFactProfileIds: ["generic-json-exchange"],
    plannedCells: 1,
  }]);

  assert.deepEqual(captureCompatibilityDiagnostics({
    ...input,
    environment: {
      id: "fact-capable",
      captureCapabilities: {
        protocols: ["https"],
        selectedFields: true,
        exchangeFacts: true,
      },
    },
  }), []);

  assert.deepEqual(captureCompatibilityDiagnostics({
    targetDefinition: definitions.target,
    taskDefinitions: {
      ...definitions.tasks,
      "inspect-exchange": {
        ...definitions.tasks["inspect-exchange"],
        executionRequirements: ["environment.trusted-egress-capture"],
      },
    },
    cells: [{ taskId: "inspect-exchange" }],
    environment: {
      id: "capture-limited",
      captureCapabilities: { protocols: [], selectedFields: false },
    },
  }).filter(({ exchangeFactProfileIds }) => exchangeFactProfileIds)
    .map(({ exchangeFactProfileIds }) => exchangeFactProfileIds), [[
      "generic-json-exchange",
    ]]);
});

test("optional capture profiles still compile without rejecting a capture-limited Environment", async (t) => {
  const definition = definitionWithProfiles();
  definition.tasks["inspect-exchange"].egress = {
    ...structuredClone(definition.target.egress),
    captureMode: "optional",
    selectedFields: ["x-request-id"],
  };
  const resolved = await resolveDefinition(t, definition);
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const definitions = resolved.value.definition;
  assert.equal(
    createCaptureRequest({
      egress: definitions.tasks["inspect-exchange"].egress,
    }).exchangeFacts.profiles.length,
    1,
  );
  assert.deepEqual(captureCompatibilityDiagnostics({
    targetDefinition: definitions.target,
    taskDefinitions: definitions.tasks,
    cells: [{ taskId: "inspect-exchange" }],
    environment: {
      id: "capture-limited",
      captureCapabilities: { protocols: [], selectedFields: false },
    },
  }), []);

  const strictDiagnostics = captureCompatibilityDiagnostics({
    targetDefinition: definitions.target,
    taskDefinitions: definitions.tasks,
    conditionDefinitions: {
      strict: {
        executionRequirements: ["environment.trusted-egress-capture"],
      },
    },
    cells: [{ taskId: "inspect-exchange", conditionId: "strict" }],
    environment: {
      id: "capture-limited",
      captureCapabilities: { protocols: [], selectedFields: false },
    },
  });
  assert.deepEqual(strictDiagnostics.map(({ missingProtocols }) => missingProtocols).filter(Boolean), [[
    "https",
  ]]);
  assert.deepEqual(strictDiagnostics.map(({ selectedFields }) => selectedFields).filter(Boolean), [[
    "x-request-id",
  ]]);
  assert.deepEqual(
    strictDiagnostics.map(({ exchangeFactProfileIds }) => exchangeFactProfileIds).filter(Boolean),
    [["generic-json-exchange"]],
  );
});

test("a Condition can restore strict capture admission before allocation", async (t) => {
  const definition = definitionWithProfiles();
  definition.tasks["inspect-exchange"].egress = {
    ...structuredClone(definition.target.egress),
    captureMode: "optional",
  };
  definition.conditions.strict = {
    displayName: "Strict capture",
    executionRequirements: ["environment.trusted-egress-capture"],
  };
  const resolved = await resolveDefinition(t, definition);
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));

  let allocations = 0;
  const unexpectedWrite = async () => {
    assert.fail("capture admission must reject before Result Store writes");
  };
  const engine = createRunEngineWithWriter({
    writer: {
      createQueued: unexpectedWrite,
      transition: unexpectedWrite,
      putEvidence: unexpectedWrite,
    },
    agentAdapter: {
      id: "test-agent",
      capabilities: [],
      createLaunchPlan() {
        assert.fail("capture admission must reject before launch planning");
      },
    },
    executionEnvironment: {
      id: "broken-trusted-capture",
      capabilities: ["environment.trusted-egress-capture"],
      captureCapabilities: { protocols: [], selectedFields: false, exchangeFacts: false },
      async execute() {
        allocations += 1;
        assert.fail("capture admission must reject before allocation");
      },
    },
  });

  const result = await engine.run({
    runPlan: resolved.value,
    conditionId: "strict",
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.summary.attempts, 0);
  assert.equal(allocations, 0);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [
    "matrix.capture-unsupported",
    "matrix.capture-unsupported",
  ]);
  assert.deepEqual(result.diagnostics.map(({ missingProtocols }) => missingProtocols).filter(Boolean), [[
    "https",
  ]]);
  assert.deepEqual(
    result.diagnostics.map(({ exchangeFactProfileIds }) => exchangeFactProfileIds).filter(Boolean),
    [["generic-json-exchange"]],
  );
});

test("egress normalization accepts only closed facts from the compiled policy", async (t) => {
  const resolved = await resolveDefinition(t, definitionWithProfiles());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const profiles = resolved.value.definition.target.egress.exchangeFactProfiles;
  const policy = createCaptureRequest(resolved.value.definition.target).exchangeFacts;
  const digest = `sha256:${"a".repeat(64)}`;
  const exchangeFacts = {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint: policy.policyFingerprint,
    profileId: "generic-json-exchange",
    request: {
      "item-identifiers": {
        state: "present",
        matches: [{ pointer: "/messages/0/item_id", value: digest }],
      },
    },
    response: {
      "item-count": {
        state: "present",
        matches: [{ pointer: "/choices/0/items", value: 2 }],
      },
      "items-present": {
        state: "present",
        matches: [{ pointer: "/choices/0/items", value: true }],
      },
    },
  };
  const normalized = normalizeEgressCollections({
    collections: [{
      status: "captured",
      requests: [{
        kind: "http-request",
        sequence: 0,
        observedAt,
        method: "POST",
        scheme: "https",
        host: "api.example.com",
        path: "/v1/exchanges",
        statusCode: 200,
        durationMs: 1,
        selectedFields: {},
        exchangeFacts,
      }],
      provenance: {
        producer: "controlled-environment",
        authority: "environment",
        lifecyclePhase: "execution",
        capturedAt: observedAt,
        trust: "environment-observed",
      },
    }],
    selectedFieldNames: [],
    exchangeFactProfiles: profiles,
    redactText: String,
  });

  assert.deepEqual(normalized[0].requests[0].exchangeFacts, exchangeFacts);
  assert.equal(Object.isFrozen(normalized[0].requests[0].exchangeFacts), true);
  assert.doesNotMatch(JSON.stringify(normalized), /requestBody|responseBody/);
});

test("egress normalization fails closed on partial or untrusted exchange facts", async (t) => {
  const resolved = await resolveDefinition(t, definitionWithProfiles());
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
  const target = resolved.value.definition.target;
  const policy = createCaptureRequest(target).exchangeFacts;
  const digest = `sha256:${"b".repeat(64)}`;
  const baseFacts = {
    schemaVersion: 1,
    captureProfile: "bounded-json-exchange-facts-v1",
    policyFingerprint: policy.policyFingerprint,
    profileId: "generic-json-exchange",
    request: {
      "item-identifiers": {
        state: "present",
        matches: [{ pointer: "/messages/0/item_id", value: digest }],
      },
    },
    response: {
      "item-count": {
        state: "present",
        matches: [{ pointer: "/choices/0/items", value: 1 }],
      },
      "items-present": {
        state: "present",
        matches: [{ pointer: "/choices/0/items", value: true }],
      },
    },
  };
  const baseEvent = {
    kind: "http-request",
    sequence: 0,
    observedAt,
    method: "POST",
    scheme: "https",
    host: "api.example.com",
    path: "/v1/exchanges",
    statusCode: 200,
    durationMs: 1,
    selectedFields: {},
    exchangeFacts: baseFacts,
  };
  const baseProvenance = {
    producer: "controlled-environment",
    authority: "environment",
    lifecyclePhase: "execution",
    capturedAt: observedAt,
    trust: "environment-observed",
  };
  const scenarios = [
    {
      name: "clear string",
      mutate(event) {
        event.exchangeFacts.request["item-identifiers"].matches[0].value = "raw-id";
      },
    },
    {
      name: "wrong policy fingerprint",
      mutate(event) {
        event.exchangeFacts.policyFingerprint = `sha256:${"c".repeat(64)}`;
      },
    },
    {
      name: "missing selector result",
      mutate(event) {
        delete event.exchangeFacts.response["items-present"];
      },
    },
    {
      name: "object wildcard",
      mutate(event) {
        event.exchangeFacts.request["item-identifiers"].matches[0].pointer =
          "/messages/not-an-index/item_id";
      },
    },
    {
      name: "raw body field",
      mutate(event) {
        event.exchangeFacts.responseBody = "must-not-persist";
      },
    },
    {
      name: "matched exchange missing facts",
      mutate(event) {
        delete event.exchangeFacts;
      },
    },
  ];

  for (const scenario of scenarios) {
    const event = structuredClone(baseEvent);
    scenario.mutate(event);
    assert.throws(() => normalizeEgressCollections({
      collections: [{
        status: "captured",
        requests: [event],
        provenance: baseProvenance,
      }],
      selectedFieldNames: [],
      exchangeFactProfiles: target.egress.exchangeFactProfiles,
      redactText: String,
    }), /invalid (?:egress request|exchange facts)/, scenario.name);
  }

  assert.throws(() => normalizeEgressCollections({
    collections: [{
      status: "captured",
      requests: [baseEvent],
      provenance: {
        ...baseProvenance,
        authority: "controller",
        trust: "controller-observed",
      },
    }],
    selectedFieldNames: [],
    exchangeFactProfiles: target.egress.exchangeFactProfiles,
    redactText: String,
  }), /invalid exchange facts/);

  // An all-host Guardian may observe the same method and path on a host the
  // Target does not own; it computes facts only for relevant hosts.
  const elsewhere = { ...structuredClone(baseEvent), host: "api.other.example" };
  delete elsewhere.exchangeFacts;
  const collection = (event) => ({
    collections: [{ status: "captured", requests: [event], provenance: baseProvenance }],
    selectedFieldNames: [],
    exchangeFactProfiles: target.egress.exchangeFactProfiles,
    redactText: String,
  });
  assert.throws(() => normalizeEgressCollections(collection(elsewhere)), /invalid exchange facts/);
  const [normalized] = normalizeEgressCollections({ ...collection(elsewhere), relevantHosts: ["api.example.com"] });
  assert.equal(normalized.requests[0].exchangeFacts, undefined);
  const unrelevant = { ...structuredClone(baseEvent) };
  delete unrelevant.exchangeFacts;
  assert.throws(() => normalizeEgressCollections({ ...collection(unrelevant), relevantHosts: ["API.EXAMPLE.COM"] }), /invalid exchange facts/);
});
