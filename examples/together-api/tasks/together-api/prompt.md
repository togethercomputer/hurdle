Call Together's API and report what happened:

1. GET /v1/models and confirm the model in fixtures/request.json is listed.
2. POST /v1/chat/completions with fixtures/request.json unchanged. Save the real
   response as completion.json at the workspace root.
3. In your final reply, include the generated text and reported token usage.

Use https://api.together.ai and TOGETHER_API_KEY as the Bearer credential;
never print or save the key. Make one call per endpoint, with no extra API calls
or retries. Use a 30-second request timeout, treat any HTTP error as a failure
but read its JSON error body, and avoid redirects. If a request fails or the
model is not listed, stop and explain it.

The model list can still include retired models. If the completion returns
HTTP 400 with error code `model_not_available`, stop and reply that the model is
retired from Together serverless and fixtures/request.json needs a serverless
model from https://docs.together.ai/docs/serverless/models.
