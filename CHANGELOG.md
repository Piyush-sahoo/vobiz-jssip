# Changelog

All notable changes to `vobiz-jssip`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.2] - 2026-11-09

### Fixed

- Regular re-INVITEs (`hold()`, `unhold()`, `renegotiate()`, session-timer refreshes) are sent
  immediately. Before, they waited for new ICE candidates that never arrive on a connected call, so
  hold was never sent, its callback never fired, and the session could get stuck.
- `renegotiate()` without an ICE restart no longer resets the WebSocket. Resetting it sent the
  INVITE on a closed socket, ended the session and left the far leg up.
- No new hold/resume/renegotiate starts while a network-change re-INVITE is pending, avoiding two
  INVITEs at once (491).

### Added

- `isNetworkChange` option on `_sendReinvite()` and `renegotiate()`. Without it, an explicit
  `rtcOfferConstraints.iceRestart` is treated as a network change, so existing reconnect callers
  keep their behaviour.
- Unit tests (`npm test`) run against both bundles; live call tests in `test/e2e`.
- CI, release workflow with npm trusted publishing and provenance, CodeQL, dependency review,
  npm audit, OpenSSF Scorecard, Dependabot.

## [1.0.1] - 2026-02-13

### Changed

- Default registrar host points at `registrar.vobiz.ai`.

## [1.0.0] - 2026-02-13

- First release: JsSIP-based SIP library for the Vobiz browser SDK.

[Unreleased]: https://github.com/vobiz-ai/vobiz-jssip/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/vobiz-ai/vobiz-jssip/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/vobiz-ai/vobiz-jssip/releases/tag/v1.0.1
