# Releasing

Releases are published by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
when a `v*` tag is pushed. **No npm credential is stored in this repository.**
The workflow authenticates to npm with a short-lived OpenID Connect token that
GitHub mints for that one run — npm calls this a *trusted publisher*.

That is the whole reason this file exists: the registry side of it is
configured on npmjs.com, not in the repository, so nothing in the tree tells
you it is there or warns you when you break it.

## What the registry expects

Each `@charrette/*` package has a trusted publisher configured at
`https://www.npmjs.com/package/<name>/access`, under **Trusted publisher**:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `ryabinski-labs` |
| Repository | `charrette` |
| Workflow filename | `release.yml` |
| Environment | *(blank)* |

The workflow *filename* is part of the trust decision. Renaming
`release.yml`, moving the repository, or renaming the org breaks publishing
until the registry side is changed to match — and it fails at publish time,
which is the worst moment to discover it.

## The first publish of any new package

npm has no equivalent of PyPI's pending publishers: a package's settings page
does not exist until the package does, so a trusted publisher cannot be
configured for a name that has never been published
([npm/cli#8544](https://github.com/npm/cli/issues/8544)). So each *new*
package costs one token-authenticated publish:

1. `npm login`, then from the repository root, `pnpm publish -r --access public`.
2. Configure the trusted publisher for each newly created package, per the
   table above.
3. Revoke the token used in step 1 — and verify the revocation by trying to
   use it, not by reading the tokens page.

Every release after that runs through the workflow with no token at all.

## Cutting a release

1. Move the entries under `## [Unreleased]` in `CHANGELOG.md` into a new
   version heading.
2. Set the same version on every publishable package. They release in
   lockstep; the workflow refuses to publish if any of them disagrees with the
   tag, because a release nobody can install under the version they were told
   about is worse than no release.
3. Merge that through `main` like anything else — the branch is protected and
   a release is not an exception.
4. Tag the merged commit and push the tag:
   ```sh
   git tag -a v0.1.0 -m 'v0.1.0' && git push origin v0.1.0
   ```
5. Watch the run. It builds, runs the full suite at 100% coverage, checks the
   tag against the manifests, and publishes with provenance.

`workflow_dispatch` re-runs a tag that half-published. It cannot overwrite:
npm refuses a version that already exists, so the packages that landed are
skipped and the ones that did not are retried.

## What ships in a tarball

Every package publishes `dist` minus its compiled tests. The tests are still
*built* — `pnpm build` is what typechecks them, and dropping them from the
compile would quietly stop that — they just do not belong in what other people
install. They were more than half the bytes before this was set.

Check it rather than assume it:

```sh
cd packages/core && pnpm pack --pack-destination /tmp && tar tzf /tmp/charrette-core-*.tgz
```

## PyPI

`charrette` and `charette` on PyPI are **name reservations**, not Python
packages: version 0.0.0, no code, pointing at this repository. Nothing is
published to them again, and no API token exists on the account — the one used
to place them was revoked immediately and the revocation confirmed by a
rejected upload.

If a Python component ever does ship, use a PyPI trusted publisher rather than
a token. Unlike npm, PyPI supports a *pending* publisher, so it can be
configured before the first release exists.
