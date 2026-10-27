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
not a security sandbox, and a Local Agent can read every key in `.env.local`. The filesystem Result Store and loopback Viewer are the
default preview path; Postgres remains an opt-in beta backend. See the
[authoring guide](docs/authoring.md) for credential and evidence boundaries.

Sandbox runs keep the Agent's own model credential and the Suite's API
credential in the Guardian, a process on your machine; the Agent's VM holds
only stand-ins. The sandbox has no network of its own and reaches the Guardian
over one socket; see [the Together Hurdle socket](docs/together-socket.md).
[Where credentials live](docs/sandbox-setup.md#where-credentials-live) lists
each case.
