import { defineSuite } from "hurdle";

export default defineSuite({
  api: {
    authorizationCredential: "TOGETHER_API_KEY",
    hosts: ["api.together.ai", "api.together.xyz"],
  },
  tasks: [
    "./tasks/tool-calling-agent-loop",
  ],
  agents: [{ runner: "claude-code", model: "claude-sonnet-4-6" }],
  conditions: {
    baseline: {},
    mcp: {
      mcpServers: [{
        id: "together-docs",
        transport: { kind: "http", url: "https://docs.together.ai/mcp" },
      }],
    },
    skills: {
      skills: [{ name: "together-ai", sourceDirectory: "skills/together-ai" }],
    },
  },
  verdict: "hybrid",
  judge: { model: "claude-opus-4-8" },
});
