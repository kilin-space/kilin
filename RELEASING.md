# Releasing

Maintainer runbook for publishing `@kilin-space/cli` and deploying the documentation site. None of
this is needed to use Kilin or to contribute a change — see [README.md](README.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) for those.

## Release gate

Run the complete gate from the repository root before any release:

```bash
pnpm verify
```

The gate checks formatting, linting, types, unit and browser behavior, documentation links, and an
exact-allowlisted npm tarball. The package check installs that tarball into an isolated global
prefix, invokes the installed binary directly, validates the bundled schema and agent skills, and
executes a complete fake-runtime workflow without provider credentials or model calls.

Every newly shipped root asset must be added both to the `files` allowlist in
`packages/cli/package.json` and to `PACKAGE_ROOT_FILES` in
`packages/cli/scripts/package-artifact.mjs`. The contents of `dist/` and `agent-skills/` are
derived from disk, and the packed file set is compared for exact equality in both directions, so an
unlisted file fails the check just as a missing one does.

## Real-model qualification

Provider qualification calls live models. It is opt-in and must never be wired into `verify` or CI.
The qualifier requires an explicit model-call acknowledgement and uses each provider CLI's
authenticated default model:

```bash
pnpm --filter @kilin-space/cli qualify:release \
  --allow-model-call \
  --tarball /absolute/path/kilin-space-cli.tgz \
  --evidence /absolute/path/qualification.json
```

It globally installs one retained tarball and runs a zero-call preflight, one three-provider
text-to-JSON-to-approved-artifact workflow, one authored-timeout scenario, and one public
cancellation scenario, each under a disposable project and `KILIN_DATA_DIR`. The sanitized record
excludes prompts, provider streams, credentials, account identity, session IDs, and temporary
paths.

Record the result in [the qualification index](packages/cli/docs/qualification/README.md), which is
the single owner of release-artifact and authenticated-runtime status; other documents link there
instead of copying a mutable result.

Each adapter accepts stable provider releases at or above its tested floor — Codex `0.144.0`,
Claude Code `2.1.215`, and OpenCode `1.18.4` — only when its required capability and authentication
probes also pass.

## Publishing the CLI

The CLI publishes from `packages/cli` through `.github/workflows/publish-cli.yml`. Stable GitHub
Releases must use a `cli-vX.Y.Z` tag matching the package version exactly. The workflow verifies
that the release commit belongs to `main`, tests and packs without OIDC authority, then passes the
digest-verified tarball to a separate environment-protected publishing job. No long-lived registry
token is used. Runs for the same release tag are serialized. A retry skips the publishing job when
npm already contains the same tarball. If the version exists with different package digests, the
workflow fails before it requests publishing authority.

Configuring trusted publishing requires package write access, account-level two-factor
authentication, and npm 11.15.0 or newer:

```bash
npm install --global npm@^11.15.0
npm trust github @kilin-space/cli \
  --file publish-cli.yml \
  --repo kilin-space/kilin \
  --env npm \
  --allow-publish
```

Protect the GitHub `npm` environment with required reviewers and restrict it to protected `cli-v*`
release tags. Enable immutable releases or tag protection as an additional control. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

### Release steps

1. Update the version in `packages/cli/package.json` and record user-visible changes in
   `packages/cli/CHANGELOG.md`.
2. Qualify the release artifact and update the qualification index.
3. Merge the release change to `main`.
4. Create the matching `cli-vX.Y.Z` tag.
5. Publish the matching GitHub Release.

### Local publication fallback

Use this only to recover from an unavailable trusted-publishing workflow. A maintainer account with
npm two-factor authentication must publish the same inspected artifact that would be handed to the
registry by CI:

1. Fetch tags and check out the exact `cli-vX.Y.Z` release tag in detached mode.
2. Confirm `git status --short` is empty and that `packages/cli/package.json` has version `X.Y.Z`.
3. Install with the frozen lockfile and run `pnpm verify`.
4. Pack `packages/cli` into a temporary directory with `npm pack`, inspect its file list, and record
   its SHA-256 digest. The digest must match the Tarball SHA-256 recorded in
   [the qualification index](packages/cli/docs/qualification/README.md); if it does not, qualify
   the local tarball before publishing.
5. Publish that exact `.tgz` file with the required one-time authentication. Do not run
   `npm publish` against the worktree.

```bash
git fetch --tags origin
git switch --detach cli-vX.Y.Z
test -z "$(git status --short)"
test "$(node --print "require('./packages/cli/package.json').version")" = "X.Y.Z"

pnpm install --frozen-lockfile
pnpm verify
test -z "$(git status --short)"

release_directory="$(mktemp -d)"
npm pack ./packages/cli --ignore-scripts --pack-destination "$release_directory"
tar -tzf "$release_directory/kilin-space-cli-X.Y.Z.tgz"
shasum -a 256 "$release_directory/kilin-space-cli-X.Y.Z.tgz"
npm publish "$release_directory/kilin-space-cli-X.Y.Z.tgz" --access public --ignore-scripts
```

## Deploying the documentation site

Create a Vercel project named `kilin-docs` from this repository and set its Root Directory to
`apps/docs`. Production deployments should come only from `main`; pull requests receive preview
deployments.

From the repository root:

```bash
pnpm dlx vercel link --repo
pnpm dlx vercel deploy
pnpm dlx vercel deploy --prod
pnpm dlx vercel domains add docs.kilin.space kilin-docs
pnpm dlx vercel domains inspect docs.kilin.space
```

Use the exact DNS record returned by `vercel domains inspect`, then verify DNS, TLS, canonical
metadata, search, and a representative deep link. Do not configure `output: "export"`, because the
site serves search through `/api/search`.

See the [Vercel monorepo guide](https://vercel.com/docs/monorepos) and
[custom-domain guide](https://vercel.com/docs/domains/set-up-custom-domain).
