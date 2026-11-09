# Contributing to vobiz-jssip

Thanks for helping. This repo is small but unusual, so please read this before opening a PR.

## How the repo is laid out

```
dist/vobiz-jssip.js       readable bundle (reference copy)
dist/vobiz-jssip.min.js   package "main" - what the browser SDK actually bundles
index.d.ts                typings
test/unit/                Node unit tests, no network (npm test)
test/e2e/                 live call tests against the Vobiz platform (billed calls)
```

There is **no source tree**: the library is maintained as a patched JsSIP bundle. Every behaviour
change must be made in **both** `dist/vobiz-jssip.js` and `dist/vobiz-jssip.min.js`. The unit tests
run each case against both files, so a change made in only one of them fails CI.

Mark fork-specific changes in `dist/vobiz-jssip.js` with a short comment that says what and why.
Do not name other vendors or competitors in code, comments, commit messages or PR text.

## Workflow

1. Open an issue first for anything bigger than a small fix.
2. Branch from `vobiz-jssip` (the default branch): `fix/…`, `feat/…`, `chore/…`, `docs/…`, `test/…`.
3. Make the change in both bundles and add a unit test in `test/unit/` that fails without it.
4. Run the checks:

   ```bash
   node --check dist/vobiz-jssip.js && node --check dist/vobiz-jssip.min.js
   npm test
   ```

5. For anything that touches calls, hold, re-INVITE, ICE or reconnects, run the live tests in
   [`test/e2e`](test/e2e/README.md) and paste the summary in the PR. At least `webrtc-to-pstn` and
   `webrtc-to-webrtc`.
6. Add a line to `CHANGELOG.md` under **Unreleased**.
7. Open the PR. CI (tests on Node 20/22/24, package contents check) and the Security workflow
   (CodeQL, dependency review, npm audit) must pass, and a code owner must approve.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) style, imperative mood:

```
fix: send regular re-INVITEs immediately
feat: add isNetworkChange option to renegotiate()
test: cover hold during a pending network re-INVITE
```

Explain the *why* in the body. Include how you tested it.

## Releasing (maintainers)

Releases are published by GitHub Actions with npm trusted publishing; nobody publishes from a laptop.

1. In a PR: bump `version` in `package.json` and move the **Unreleased** entries in `CHANGELOG.md`
   under the new version with today's date. Merge it.
2. Create a GitHub release with tag `vX.Y.Z` (matching `package.json`) on the default branch, using the
   changelog entry as the notes.
3. The `Publish to npm` workflow runs in the `npm` environment, checks that the tag matches the
   version, runs the tests and publishes with a provenance attestation.
4. Update `vobiz-webrtc-sdk` to the new version and release the SDK.

To check a release without publishing, run the workflow manually with **dry_run** on.

## Code of conduct

This project follows the [Vobiz code of conduct](https://github.com/vobiz-ai/.github/blob/main/CODE_OF_CONDUCT.md).
