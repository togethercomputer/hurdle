Call Together's API and report what happened:

1. GET /v1/models and confirm the model in fixtures/request.json is listed. The
   response body is a bare JSON array of model objects, not an object with a
   `data` field; match the fixture's `model` against each entry's `id`.
2. POST /v1/chat/completions with fixtures/request.json unchanged. Save the real
   response as completion.json at the workspace root.
3. In your final reply, include the generated text and reported token usage.

Use https://api.together.ai and TOGETHER_API_KEY as the Bearer credential;
never print or save the key. Make one call per endpoint, with no extra API
calls. Use a 30-second request timeout and avoid redirects. Read the JSON error
body of any HTTP error. The only retry allowed: if a request times out or
returns HTTP 5xx, send that same request once more. Stop and explain if you get
any HTTP 4xx, any other failure, a failed retry, or a model list without the
fixture's model.
Set your own User-Agent header: Together rejects Python urllib's default one.

The model list can still include retired models. If the completion returns
HTTP 400 with error code `model_not_available`, stop and reply that the model is
retired from Together serverless and fixtures/request.json needs a serverless
model from https://docs.together.ai/docs/serverless/models.
