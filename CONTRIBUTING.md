# Contributing

Thanks for helping improve Hurdle — Together Agent Evals.

## Set up the repository

Use Node.js 22.18 or newer, then install the locked development dependencies:

```sh
npm run setup:ci
```

Native Local execution runs evaluated Agent code on your host and is not a
security sandbox. Only run Suites and task inputs you trust. Do not commit API
keys, local Runtime files, Result Stores or generated Agent workspaces.

## Make a change

Create an issue for substantive work, then branch from the latest `main`:

```sh
git switch main
git pull --ff-only
git switch -c codex/<issue>-<short-name>
```

Keep changes focused. Public evaluation authoring should use Suite modules and
Task folders; do not add a second configuration surface.

Do not weaken Run Trust, evidence custody and redaction, cancellation, cleanup,
or disposal safeguards to make an evaluation pass.

## Verify the change

Run the bill-free checks and Viewer build:

```sh
npm test
npm run build
```

These commands must not call paid Agent, Judge or Together services. If a
live evaluation is genuinely needed, describe its scope and spending bound in
the pull request before running it.

Open a pull request against `main` and include the user-visible effect, test
evidence and any security or compatibility tradeoffs. Keep `main` releasable;
accepted pull requests are squash-merged.

Security reports should follow [SECURITY.md](SECURITY.md), not a public issue.

## Publish the npm package

The root `README.md` is the single README for GitHub and npm; do not maintain a
separate npm copy. Use absolute public URLs for its images and repository links.
The packed-install test verifies that the package includes this exact README.

npm refreshes the package-page README only when a new version is published, so
README fixes also require a patch release. See
[npm's README guidance](https://docs.npmjs.com/about-package-readme-files/).
After the bill-free checks and build pass, add the release's notes to
`CHANGELOG.md`, bump the root package version and publish the verified archive
from the repository root:

```sh
npm version patch --no-git-tag-version
npm pack
npm publish ./hurdle-<version>.tgz
```

Replace `<version>` with the version in `package.json`. Commit both
`package.json` and `package-lock.json` with the README change. Verify the public
package page, image, and fresh `npx hurdle@latest` installation after publishing.
