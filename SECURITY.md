# Security policy

Hurdle is a preview. Security fixes target the latest commit on
`main`; older commits and preview tags are not maintained release lines.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability or exposed secret.
Use this repository's private Security Advisory flow:

<https://github.com/Nutlope/hurdle/security/advisories/new>

Include the affected commit, reproduction steps, impact and any suggested
mitigation. Avoid including real credentials or unnecessary sensitive data.
If the advisory flow is unavailable, contact the repository owner through an
established private channel before sharing details.

If a credential may have been exposed, revoke or rotate it immediately.
Removing it from Git history is not sufficient.

## Execution boundary

Native Local runs execute Agent code on the host with network access. They are
not a security sandbox. The filesystem Result Store and loopback Viewer are the
default preview path; E2B and Postgres remain opt-in beta backends. See the
[authoring guide](docs/authoring.md) for credential and evidence boundaries.

Sandbox runs do not keep every credential out of the Agent's VM. E2B keeps the
Agent's Anthropic or OpenAI API key, and a Task's captured API credential, in the
Guardian. A Codex ChatGPT access token, an uncaptured Task credential, and any
Agent credential on Together sandbox are readable inside the Agent's VM.
[Where credentials live](docs/sandbox-setup.md#where-credentials-live) lists
each case.
