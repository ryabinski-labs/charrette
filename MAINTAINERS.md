# Maintainers

Maintainers can merge to `main` once the required checks pass. Nobody merges
red, and nobody merges without checks — including the people on this list.

| Name | GitHub | Contact | Areas |
|---|---|---|---|
| Yoni Ryabinski | [@ryabinski-labs](https://github.com/ryabinski-labs) | cigan1@gmail.com | all areas, release, security |

## What a maintainer is on the hook for

- Reviewing pull requests, or saying plainly that they cannot get to one.
- Keeping `main` green and releasable.
- Answering security reports at the address in [SECURITY.md](./SECURITY.md).
- Keeping this file and the repository's GitHub permissions in agreement.

## Becoming a maintainer

There is no committee. Land a few non-trivial changes, review a few from other
people, and ask. The current maintainers decide, and the answer arrives in the
issue you asked in rather than privately.

## Merge policy

The default branch is protected. A pull request merges when the required checks
are green; an approving review is not separately required, because the checks —
build, full suite at 100% coverage, and the OSS compliance job — are what the
project actually relies on. Only maintainers can merge.

`CODEOWNERS` marks the areas where a review *is* required on top of that:
security policy, release automation, CI and governance files.
