import assert from "node:assert/strict";
import test from "node:test";

import {
  agentCredentialStandIn,
  credentialRoutesAreValid,
  prepareAgentCredentials,
  withAgentCredentialStandIns,
} from "../lib/agent-credential-routes.mjs";
import { createClaudeCodeAdapter } from "../lib/agent-adapters/claude-code.mjs";
import { createCodexAdapter } from "../lib/agent-adapters/codex.mjs";

const anthropicRoute = (environmentName) => ({
  environmentName,
  hosts: ["api.anthropic.com"],
  headerNames: ["x-api-key", "authorization"],
});

function claudePlan(runtimeEnv) {
  return createClaudeCodeAdapter({ runtimeEnv }).createLaunchPlan({ prompt: "p", requestedModel: null });
}

function codexPlan(runtimeEnv) {
  return createCodexAdapter({ runtimeEnv }).createLaunchPlan({
    prompt: "p",
    requestedModel: null,
    settings: {},
  });
}

test("Claude Code routes its selected credential only to the Anthropic API", () => {
  const apiKey = claudePlan({ ANTHROPIC_API_KEY: "sk-ant-api03-key" });
  assert.deepEqual(apiKey.credentialRoutes, [anthropicRoute("ANTHROPIC_API_KEY")]);
  assert.equal(credentialRoutesAreValid(apiKey.credentialRoutes, apiKey.env), true);

  const oauth = claudePlan({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token" });
  assert.deepEqual(oauth.credentialRoutes, [anthropicRoute("CLAUDE_CODE_OAUTH_TOKEN")]);

  // The API key wins when both are set, so only it is present and routed.
  const both = claudePlan({
    ANTHROPIC_API_KEY: "sk-ant-api03-key",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token",
  });
  assert.equal(both.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(both.credentialRoutes, [anthropicRoute("ANTHROPIC_API_KEY")]);
});

test("Codex routes only an API key, to the OpenAI API, and ignores a ChatGPT access token", () => {
  const route = {
    environmentName: "CODEX_API_KEY",
    hosts: ["api.openai.com"],
    headerNames: ["authorization"],
  };
  assert.deepEqual(codexPlan({ OPENAI_API_KEY: "sk-proj-key" }).credentialRoutes, [route]);
  assert.deepEqual(codexPlan({ CODEX_API_KEY: "sk-proj-key" }).credentialRoutes, [route]);
  const accessToken = codexPlan({ CODEX_ACCESS_TOKEN: "chatgpt-access-token" });
  assert.equal(accessToken.env.CODEX_ACCESS_TOKEN, undefined);
  assert.deepEqual(accessToken.credentialRoutes, []);
  const both = codexPlan({ CODEX_ACCESS_TOKEN: "chatgpt-access-token", OPENAI_API_KEY: "sk-proj-key" });
  assert.equal(both.env.CODEX_ACCESS_TOKEN, undefined);
  assert.deepEqual(both.credentialRoutes, [route]);
});

test("no Agent is given a ChatGPT access token, real or stand-in", () => {
  const plan = { env: { CODEX_ACCESS_TOKEN: "eyJh.eyJz.SIG" } };
  assert.throws(() => prepareAgentCredentials(plan, () => "fallback"), /CODEX_ACCESS_TOKEN is not supported/);
  assert.throws(() => withAgentCredentialStandIns(plan, []), /CODEX_ACCESS_TOKEN is not supported/);
  // A blank value is no credential at all.
  assert.deepEqual(prepareAgentCredentials({ env: { CODEX_ACCESS_TOKEN: " " } }, () => "fallback"), []);
});

test("credential routes are closed, scoped to present credentials, and bounded", () => {
  const env = { AGENT_KEY: "agent-secret", BLANK: " " };
  const route = { environmentName: "AGENT_KEY", hosts: ["api.example.com"], headerNames: ["authorization"] };
  assert.equal(credentialRoutesAreValid(undefined, env), true);
  assert.equal(credentialRoutesAreValid([], env), true);
  assert.equal(credentialRoutesAreValid([route], env), true);
  for (const invalid of [
    null,
    {},
    [route, route],
    [{ ...route, environmentName: "MISSING" }],
    [{ ...route, environmentName: "BLANK" }],
    [{ ...route, environmentName: "agent_key" }],
    [{ ...route, hosts: [] }],
    [{ ...route, hosts: ["API.EXAMPLE.COM"] }],
    [{ ...route, hosts: ["localhost"] }],
    [{ ...route, hosts: ["api.example.com."] }],
    [{ ...route, hosts: ["api.example.com", "api.example.com"] }],
    [{ ...route, headerNames: [] }],
    [{ ...route, headerNames: ["Authorization"] }],
    [{ ...route, extra: true }],
    Array.from({ length: 9 }, (_, index) => ({ ...route, environmentName: `KEY_${index}` })),
  ]) {
    assert.equal(credentialRoutesAreValid(invalid, env), false, JSON.stringify(invalid));
  }
});

test("a stand-in copies only a public key prefix, never secret bytes", () => {
  const entropy = () => "entropy";
  assert.equal(
    agentCredentialStandIn("sk-ant-api03-SECRET-part_two", entropy),
    "sk-ant-api03-entropy",
  );
  assert.equal(
    agentCredentialStandIn("sk-ant-oat01-SECRET", entropy),
    "sk-ant-oat01-entropy",
  );
  assert.equal(
    agentCredentialStandIn("sk-proj-SECRET-part_two-x", entropy),
    "sk-proj-entropy",
  );
  assert.equal(agentCredentialStandIn("sk-SECRET-x", entropy), "sk-entropy");
  assert.equal(agentCredentialStandIn("SECRET-x-y", entropy), "entropy");
  // A JWT keeps its header and claims but never its signature.
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: "test-user" })).toString("base64url");
  const dummySignature = Buffer.from("fixture").toString("base64url");
  assert.equal(
    agentCredentialStandIn([header, claims, dummySignature].join("."), entropy),
    [header, claims, entropy()].join("."),
  );
});

test("routed Agent credentials reach the workload only as stand-ins on every turn", () => {
  const plan = {
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-real", LANG: "C.UTF-8" },
    credentialRoutes: [anthropicRoute("ANTHROPIC_API_KEY")],
  };
  const credentials = prepareAgentCredentials(plan, () => "turn");
  assert.deepEqual(credentials, [{
    environmentName: "ANTHROPIC_API_KEY",
    surrogate: "sk-ant-api03-turn",
    value: "sk-ant-api03-real",
    hosts: ["api.anthropic.com"],
    headerNames: ["x-api-key", "authorization"],
  }]);
  assert.deepEqual(withAgentCredentialStandIns(plan, credentials), {
    ANTHROPIC_API_KEY: "sk-ant-api03-turn",
    LANG: "C.UTF-8",
  });
  // A continuation plan that omits its routes still gets the stand-in.
  assert.equal(
    withAgentCredentialStandIns({ env: plan.env }, credentials).ANTHROPIC_API_KEY,
    "sk-ant-api03-turn",
  );
  // Without a declared route, the well-known name still gets a stand-in.
  assert.equal(prepareAgentCredentials({ env: plan.env }, () => "none")[0].surrogate, "sk-ant-api03-none");

  assert.throws(
    () => withAgentCredentialStandIns({
      ...plan,
      env: { ...plan.env, COPY: "sk-ant-api03-real" },
    }, credentials),
    /would reach the Agent's environment/,
  );
  assert.throws(
    () => withAgentCredentialStandIns({
      ...plan,
      env: { ...plan.env, ANTHROPIC_API_KEY: `${plan.env.ANTHROPIC_API_KEY}-rotated` },
    }, credentials),
    /changed after the Guardian was prepared/,
  );
  assert.throws(
    () => withAgentCredentialStandIns({
      ...plan,
      credentialRoutes: [{ ...anthropicRoute("ANTHROPIC_API_KEY"), hosts: ["api.example.com"] }],
    }, credentials),
    /routes changed after the Guardian was prepared/,
  );
  assert.throws(
    () => prepareAgentCredentials(plan, () => "sk-ant-api03-real"),
    /not distinct/,
  );
});

test("well-known Agent credentials get stand-ins even when no route is declared", () => {
  const entropy = () => "fallback";
  const undeclared = prepareAgentCredentials({
    env: {
      ANTHROPIC_API_KEY: "sk-ant-api03-real",
      CODEX_API_KEY: "sk-proj-real",
      ADAPTER_AUTH: "custom-secret",
    },
  }, entropy);
  assert.deepEqual(undeclared.map(({ environmentName, hosts, headerNames, surrogate }) => ({
    environmentName, hosts, headerNames, surrogate,
  })), [
    {
      environmentName: "ANTHROPIC_API_KEY",
      hosts: ["api.anthropic.com"],
      headerNames: ["x-api-key", "authorization"],
      surrogate: "sk-ant-api03-fallback",
    },
    {
      environmentName: "CODEX_API_KEY",
      hosts: ["api.openai.com"],
      headerNames: ["authorization"],
      surrogate: "sk-proj-fallback",
    },
  ]);
  const env = withAgentCredentialStandIns({ env: {
    ANTHROPIC_API_KEY: "sk-ant-api03-real",
    CODEX_API_KEY: "sk-proj-real",
    ADAPTER_AUTH: "custom-secret",
  } }, undeclared);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-api03-fallback");
  assert.equal(env.CODEX_API_KEY, "sk-proj-fallback");
  assert.equal(env.ADAPTER_AUTH, "custom-secret", "only well-known names have a known route");

  // A declared route wins over the default for the same credential.
  const declared = prepareAgentCredentials({
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-real" },
    credentialRoutes: [anthropicRoute("CLAUDE_CODE_OAUTH_TOKEN")],
  }, entropy);
  assert.deepEqual(declared.map(({ headerNames }) => headerNames), [["x-api-key", "authorization"]]);
});

test("the workload never receives a value that carries a real Agent credential", () => {
  const plan = {
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-real-agent-key" },
    credentialRoutes: [anthropicRoute("ANTHROPIC_API_KEY")],
  };
  const credentials = prepareAgentCredentials(plan, () => "stand-in");
  // The exact value, and the value embedded in a longer one, are both refused.
  for (const leaked of ["sk-ant-api03-real-agent-key", "Bearer sk-ant-api03-real-agent-key"]) {
    assert.throws(
      () => withAgentCredentialStandIns({ ...plan, env: { ...plan.env, EXTRA: leaked } }, credentials),
      /would reach the Agent's environment/,
    );
  }
  assert.throws(
    () => withAgentCredentialStandIns({
      ...plan,
      env: { ...plan.env, EXTRA: { token: plan.env.ANTHROPIC_API_KEY } },
    }, credentials),
    /environment values must be strings/,
  );
  // A well-known credential that appears only on a later turn has no swap.
  assert.throws(
    () => withAgentCredentialStandIns({
      ...plan,
      env: { ...plan.env, CODEX_API_KEY: "sk-proj-late-key" },
    }, credentials),
    /appeared after the Guardian was prepared/,
  );
  assert.equal(
    withAgentCredentialStandIns(plan, credentials).ANTHROPIC_API_KEY,
    "sk-ant-api03-stand-in",
  );
});
