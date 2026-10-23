// The documented Together sandbox service. HURDLE_TOGETHER_API_URL is an explicit,
// Hurdle-specific opt-in for local control planes (such as CodeSandbox devbox); the
// generic TOGETHER_BASE_URL is deliberately never inherited.
export function togetherUsesLocalControlPlane(env = process.env) {
  return Boolean(env.HURDLE_TOGETHER_API_URL?.trim());
}

// Together's Hurdle API: one WebSocket per sandbox, booted from Together's own
// Hurdle image. The default for a Together Runtime without a snapshot alias;
// HURDLE_TOGETHER_RUN_URL points it at another control plane.
export const DEFAULT_TOGETHER_RUN_URL = "wss://api.together.ai/v1/compute/experimental/run";

export function togetherRunUrl(env = process.env) {
  const url = new URL(env.HURDLE_TOGETHER_RUN_URL?.trim() || DEFAULT_TOGETHER_RUN_URL);
  if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("HURDLE_TOGETHER_RUN_URL must be a ws(s) URL");
  }
  return url.toString();
}

export function togetherApiUrl(env = process.env) {
  const configured = env.HURDLE_TOGETHER_API_URL?.trim();
  if (!configured) return "https://api.bartender.codesandbox.io";
  const url = new URL(configured);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
    || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("HURDLE_TOGETHER_API_URL must be an http(s) origin");
  }
  return url.origin;
}
