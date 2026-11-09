# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub private vulnerability reporting](https://github.com/vobiz-ai/vobiz-jssip/security/advisories/new),
or email [piyush@vobiz.ai](mailto:piyush@vobiz.ai) with the subject "vobiz-jssip security". We aim to acknowledge reports within 3 working days.

## Supported versions

Only the latest published version of `vobiz-jssip` receives fixes.

## Supply chain

- Releases are published from GitHub Actions with npm trusted publishing (OIDC), so no npm token
  exists in CI. Each version carries an npm provenance attestation linking it to the commit and
  workflow run that built it: `npm audit signatures` verifies it.
- Workflow actions are pinned to commit SHAs and updated by Dependabot.
- CodeQL, dependency review, `npm audit` and OpenSSF Scorecard run in the `Security` workflow.
