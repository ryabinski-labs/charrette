# Contributing

Thanks for looking. This file is the short version; if something here turns out
to be wrong or missing, that is itself worth an issue.

## Before a large change

Open an issue first. A big pull request that takes the design somewhere the
maintainers were not going is a bad outcome for everyone, and it is cheaper to
find that out in an issue than in a review.

Small changes — a bug fix, a doc correction, a test for something untested —
need no preamble. Just send them.

## Setting up

```sh
git clone https://github.com/ryabinski-labs/charrette.git
cd charrette
pnpm install
pnpm build        # this is also the typecheck — see below
pnpm test
```

You need Node ≥ 22.13 and pnpm ≥ 11. The pnpm version comes from
`packageManager` in `package.json`; let Corepack or `pnpm/action-setup` read it
rather than pinning your own, because a different major writes a different
lockfile.

Running the CLI against a repository you want built:

```sh
pnpm link-cli     # symlinks `charrette` into ~/.local/bin
cd ~/code/some-app
charrette run
```

## The two things that trip people up

**`pnpm build` is the typecheck.** `pnpm typecheck` is `build --noEmit`, and the
packages resolve each other through their `dist/*.d.ts`. Nothing but a build
writes those, so on a clean checkout `pnpm typecheck` fails on every
cross-package import. Build first, always. This is why CI runs `pnpm build`
rather than `pnpm typecheck`.

**Coverage is a hard gate at 100%.** `vitest.config.ts` sets 100% for lines,
functions, branches and statements, and it fails the job *after* the suite
passes. `pnpm test` does not check coverage; `pnpm test:coverage` does, and that
is what CI runs. A green `pnpm test` proves nothing about whether your new
branch is covered.

```sh
pnpm test:coverage
open coverage/lcov-report/index.html   # which lines and branches went uncovered
```

An uncovered branch is usually one of two things: a guard that cannot actually
be reached, or a path nobody tested. Work out which before writing a test — the
first should be deleted, not covered.

## Tests

Tests live beside the code they test, as `*.test.ts`. The suite is vitest.

The house style is that a test says *why* the behavior matters, not just what it
asserts. Most non-obvious tests here carry a comment explaining the failure they
exist to prevent, usually a real one. Match that. A test named "works correctly"
tells the next person nothing.

## Commits and pull requests

- Branch off `main`; never push to `main` directly.
- One logical change per pull request.
- Explain *why* in the description. The diff already says what.
- Green CI is required. Maintainers merge; see [MAINTAINERS.md](./MAINTAINERS.md).

## Licensing of contributions

By contributing you agree your contribution is licensed under the
[MIT License](./LICENSE), the same as the rest of the project. There is no CLA.

## Code of conduct

[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) applies everywhere the project
happens — issues, pull requests, discussions.
