// The documented Together sandbox service. HURDLE_TOGETHER_API_URL is an explicit,
// Hurdle-specific opt-in for local control planes (such as CodeSandbox devbox); the
// generic TOGETHER_BASE_URL is deliberately never inherited.
export function togetherUsesLocalControlPlane(env = process.env) {
  return Boolean(env.HURDLE_TOGETHER_API_URL?.trim());
}

// Together's Hurdle API: one WebSocket per sandbox, booted from Together's own
// Hurdle image and served from Together's CodeSandbox US region.
// HURDLE_TOGETHER_RUN_URL points it at another control plane.
export const DEFAULT_TOGETHER_RUN_URL = "wss://hurdle.us.codesandbox.io/v1/compute/experimental/run";

export function togetherRunUrl(env = process.env) {
  const url = new URL(env.HURDLE_TOGETHER_RUN_URL?.trim() || DEFAULT_TOGETHER_RUN_URL);
  if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("HURDLE_TOGETHER_RUN_URL must be a ws(s) URL");
  }
  return url.toString();
}
