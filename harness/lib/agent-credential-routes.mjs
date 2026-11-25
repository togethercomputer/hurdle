// An Agent Adapter declares where its own model credential may be sent. A
// sandbox with a Guardian gives the Agent a stand-in value and lets only the
// Guardian swap in the real value for those hosts and headers, so the real
// credential never enters the Agent's VM. Local execution ignores the routes.

const MAX_ROUTES = 8;
const MAX_HOSTS = 8;
const MAX_HEADER_NAMES = 4;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Only these public, documented key prefixes are copied into a stand-in, so a
// CLI that checks a key's shape still accepts it. No secret bytes are copied.
const PUBLIC_KEY_PREFIXES = Object.freeze([
  /^sk-ant-(?:api|oat|admin)\d{2}-/,
  /^sk-(?:proj|svcacct|admin)-/,
  /^sk-/,
]);

function validHost(value) {
  return typeof value === "string"
    && value.length <= 253
    && value === value.toLowerCase()
    && value.includes(".")
    && value.split(".").every((label) => HOST_LABEL.test(label));
}

function validList(values, maximum, valid) {
  return Array.isArray(values)
    && values.length >= 1
    && values.length <= maximum
    && new Set(values).size === values.length
    && values.every(valid);
}

export function credentialRoutesAreValid(routes, env = {}) {
  if (routes === undefined) return true;
  if (!Array.isArray(routes) || routes.length > MAX_ROUTES) return false;
  const names = new Set();
  for (const route of routes) {
    if (
      !route
      || typeof route !== "object"
      || Array.isArray(route)
      || Object.keys(route).sort().join("\0") !== "environmentName\0headerNames\0hosts"
      || typeof route.environmentName !== "string"
      || !ENVIRONMENT_NAME.test(route.environmentName)
      || names.has(route.environmentName)
      || typeof env?.[route.environmentName] !== "string"
      || !env[route.environmentName].trim()
      || !validList(route.hosts, MAX_HOSTS, validHost)
      || !validList(route.headerNames, MAX_HEADER_NAMES, (name) => (
        typeof name === "string" && HEADER_NAME.test(name)
      ))
    ) return false;
    names.add(route.environmentName);
  }
  return true;
}

export function assertCredentialRoutes(routes, env = {}) {
  if (!credentialRoutesAreValid(routes, env)) {
    throw new TypeError("Agent credential routes are invalid");
  }
  return routes ?? [];
}

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

// Well-known Agent credentials and where each may go. A launch plan that
// carries one without declaring its route still gets a stand-in, so a real
// key never reaches a sandbox just because an Adapter omitted its route.
export const DEFAULT_AGENT_CREDENTIAL_ROUTES = Object.freeze({
  ANTHROPIC_API_KEY: Object.freeze({ hosts: ["api.anthropic.com"], headerNames: ["x-api-key", "authorization"] }),
  CLAUDE_CODE_OAUTH_TOKEN: Object.freeze({ hosts: ["api.anthropic.com"], headerNames: ["authorization"] }),
  CODEX_API_KEY: Object.freeze({ hosts: ["api.openai.com"], headerNames: ["authorization"] }),
});

// A Codex ChatGPT access token acts for the user across all of chatgpt.com, not
// just Codex, so no Agent may be given one, real or stand-in.
export const UNSUPPORTED_AGENT_CREDENTIALS = Object.freeze(["CODEX_ACCESS_TOKEN"]);

function refuseUnsupportedCredentials(env) {
  for (const name of UNSUPPORTED_AGENT_CREDENTIALS) {
    if (typeof env?.[name] === "string" && env[name].trim()) {
      throw new TypeError(`${name} is not supported; use CODEX_API_KEY or OPENAI_API_KEY`);
    }
  }
}

export function agentCredentialStandIn(value, entropy) {
  // A JWT keeps its header and claims, which a CLI may decode before sending,
  // with a fresh signature: the signature, not the claims, grants access.
  const parts = value.split(".");
  if (parts.length === 3 && parts.every((part) => JWT_SEGMENT.test(part))) {
    return `${parts[0]}.${parts[1]}.${entropy()}`;
  }
  const prefix = PUBLIC_KEY_PREFIXES
    .map((pattern) => pattern.exec(value)?.[0])
    .find(Boolean) ?? "";
  return `${prefix}${entropy()}`;
}

// Resolve each declared route to the real value and a fresh stand-in. The real
// value stays with the controller and the Guardian; the Agent sees only the
// stand-in.
export function prepareAgentCredentials(launchPlan, entropy) {
  refuseUnsupportedCredentials(launchPlan?.env);
  const declared = assertCredentialRoutes(launchPlan?.credentialRoutes, launchPlan?.env);
  const declaredNames = new Set(declared.map(({ environmentName }) => environmentName));
  const defaults = Object.entries(DEFAULT_AGENT_CREDENTIAL_ROUTES)
    .filter(([name]) => (
      !declaredNames.has(name)
      && typeof launchPlan?.env?.[name] === "string"
      && launchPlan.env[name].trim()
    ))
    .map(([environmentName, { hosts, headerNames }]) => ({ environmentName, hosts, headerNames }));
  const routes = [...declared, ...defaults];
  return routes.map(({ environmentName, hosts, headerNames }) => {
    const value = launchPlan.env[environmentName];
    const surrogate = agentCredentialStandIn(value, entropy);
    if (surrogate === value || value.includes(surrogate) || surrogate.includes(value)) {
      throw new TypeError("Agent credential stand-in is not distinct from its value");
    }
    return Object.freeze({
      environmentName,
      surrogate,
      value,
      hosts: Object.freeze([...hosts]),
      headerNames: Object.freeze([...headerNames]),
    });
  });
}

// Replace routed credentials in one turn's environment. A later turn must reuse
// the same credentials: the Guardian was configured before the first turn.
export function withAgentCredentialStandIns(launchPlan, agentCredentials) {
  const env = { ...(launchPlan?.env ?? {}) };
  if (Object.values(env).some((value) => typeof value !== "string")) {
    throw new TypeError("Agent environment values must be strings");
  }
  refuseUnsupportedCredentials(env);
  const routes = assertCredentialRoutes(launchPlan?.credentialRoutes, env);
  const prepared = new Map(agentCredentials.map((credential) => [
    credential.environmentName,
    credential,
  ]));
  for (const route of routes) {
    const credential = prepared.get(route.environmentName);
    if (
      !credential
      || route.hosts.join("\0") !== credential.hosts.join("\0")
      || route.headerNames.join("\0") !== credential.headerNames.join("\0")
    ) {
      throw new TypeError("Agent credential routes changed after the Guardian was prepared");
    }
  }
  // A well-known credential that first appears on a later turn has no
  // Guardian swap behind it, so it would reach the workload as a real value.
  for (const name of Object.keys(DEFAULT_AGENT_CREDENTIAL_ROUTES)) {
    if (
      typeof env[name] === "string"
      && env[name].trim()
      && !prepared.has(name)
    ) {
      throw new TypeError("Agent credential appeared after the Guardian was prepared");
    }
  }
  for (const credential of agentCredentials) {
    if (!Object.hasOwn(env, credential.environmentName)) continue;
    if (env[credential.environmentName] !== credential.value) {
      throw new TypeError("Agent credential changed after the Guardian was prepared");
    }
    env[credential.environmentName] = credential.surrogate;
  }
  // Refuse any value that carries a real credential, not only an exact copy:
  // "Bearer <key>" or a key embedded in a URL is just as exposed.
  const realValues = agentCredentials.map(({ value }) => value);
  if (Object.values(env).some((value) => realValues.some((real) => value.includes(real)))) {
    throw new TypeError("A routed Agent credential would reach the Agent's environment");
  }
  return env;
}
