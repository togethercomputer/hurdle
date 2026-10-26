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

test("Codex routes an API key to the OpenAI API and an access token to ChatGPT and OpenAI", () => {
  const route = {
    environmentName: "CODEX_API_KEY",
    hosts: ["api.openai.com"],
    headerNames: ["authorization"],
  };
  assert.deepEqual(codexPlan({ OPENAI_API_KEY: "sk-proj-key" }).credentialRoutes, [route]);
  assert.deepEqual(codexPlan({ CODEX_API_KEY: "sk-proj-key" }).credentialRoutes, [route]);
  const accessToken = codexPlan({ CODEX_ACCESS_TOKEN: "chatgpt-access-token" });
  assert.equal(accessToken.env.CODEX_ACCESS_TOKEN, "chatgpt-access-token");
  assert.deepEqual(accessToken.credentialRoutes, [{
    environmentName: "CODEX_ACCESS_TOKEN",
    hosts: ["chatgpt.com", "api.openai.com"],
    headerNames: ["authorization"],
  }]);
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
    "sk-ant-api03-hurdle_agent_stand_in_entropy",
  );
  assert.equal(
    agentCredentialStandIn("sk-ant-oat01-SECRET", entropy),
    "sk-ant-oat01-hurdle_agent_stand_in_entropy",
  );
  assert.equal(
    agentCredentialStandIn("sk-proj-SECRET-part_two-x", entropy),
    "sk-proj-hurdle_agent_stand_in_entropy",
  );
  assert.equal(agentCredentialStandIn("sk-SECRET-x", entropy), "sk-hurdle_agent_stand_in_entropy");
  assert.equal(agentCredentialStandIn("SECRET-x-y", entropy), "hurdle_agent_stand_in_entropy");
  // A JWT keeps its header and claims but never its signature.
  assert.equal(
    agentCredentialStandIn("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.SIGNATURE-SECRET", entropy),
    "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.hurdle_agent_stand_in_entropy",
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
    surrogate: "sk-ant-api03-hurdle_agent_stand_in_turn",
    value: "sk-ant-api03-real",
    hosts: ["api.anthropic.com"],
    headerNames: ["x-api-key", "authorization"],
  }]);
  assert.deepEqual(withAgentCredentialStandIns(plan, credentials), {
    ANTHROPIC_API_KEY: "sk-ant-api03-hurdle_agent_stand_in_turn",
    LANG: "C.UTF-8",
  });
  // A continuation plan that omits its routes still gets the stand-in.
  assert.equal(
    withAgentCredentialStandIns({ env: plan.env }, credentials).ANTHROPIC_API_KEY,
    "sk-ant-api03-hurdle_agent_stand_in_turn",
  );
  assert.deepEqual(prepareAgentCredentials({ env: plan.env }, () => "none"), []);

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
      env: { ...plan.env, ANTHROPIC_API_KEY: "sk-ant-api03-rotated" },
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
