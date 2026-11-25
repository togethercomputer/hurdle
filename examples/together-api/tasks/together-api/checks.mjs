import { defineChecks } from "hurdle";

export default defineChecks((run) => {
  run.expect.completed();
  run.expect.request({ id: "model-catalog", method: "GET", path: "/v1/models", status: 200 });
  run.expect.request({ id: "chat-completion", method: "POST", path: "/v1/chat/completions", status: 200 });
  run.expect.artifact({ id: "completion", path: "completion.json", format: "json", maxBytes: 32768 });

  // The prompt allows one retry after a timeout (no recorded status) or a 5xx.
  const calls = run.evidence.requests?.filter(request => request.method === "POST" && request.path === "/v1/chat/completions");
  const retryable = status => status === null || (status >= 500 && status <= 599);
  run.check({
    id: "one-completion",
    passed: calls === undefined ? null : (calls.length === 1 || calls.length === 2)
      && calls.at(-1).status === 200
      && calls.slice(0, -1).every(request => retryable(request.status)),
    summary: "Exactly one successful completion, after at most one retry of a timeout or 5xx; other attempts fail after execution.",
    evidence: calls?.map(request => request.evidence) ?? [],
  });
  const completion = run.artifacts.json("completion.json");
  const reply = completion?.choices?.[0]?.message?.content;
  const tokens = completion?.usage?.total_tokens;
  run.check({
    id: "completion-shape",
    passed: typeof reply === "string" && reply.trim().length > 0
      && Number.isSafeInteger(tokens) && tokens > 0,
    summary: "The saved completion includes a reply and token usage.",
  });
});
