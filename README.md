# vobiz-jssip

[![CI](https://github.com/vobiz-ai/vobiz-jssip/actions/workflows/ci.yml/badge.svg)](https://github.com/vobiz-ai/vobiz-jssip/actions/workflows/ci.yml)
[![Security](https://github.com/vobiz-ai/vobiz-jssip/actions/workflows/security.yml/badge.svg)](https://github.com/vobiz-ai/vobiz-jssip/actions/workflows/security.yml)
[![npm](https://img.shields.io/npm/v/vobiz-jssip)](https://www.npmjs.com/package/vobiz-jssip)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/vobiz-ai/vobiz-jssip/badge)](https://scorecard.dev/viewer/?uri=github.com/vobiz-ai/vobiz-jssip)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The SIP-over-WebSocket library behind the [Vobiz browser SDK](https://www.npmjs.com/package/vobiz-webrtc-sdk)
(`vobiz-webrtc-sdk`). It is a fork of [JsSIP](https://jssip.net/) 3.x (MIT), shipped as a prebuilt bundle.

- npm: [`vobiz-jssip`](https://www.npmjs.com/package/vobiz-jssip)
- Used by: `vobiz-webrtc-sdk` (bundled into `dist/vobiz-webrtc-sdk.js`)
- Registrar: `wss://registrar.vobiz.ai:5063`

## Installation

```bash
npm install vobiz-jssip
```

## Usage

The API is JsSIP's. Most apps should use `vobiz-webrtc-sdk` instead, which handles login, calls,
reconnects and hold for you.

```javascript
const VobizJsSIP = require('vobiz-jssip');

const socket = new VobizJsSIP.WebSocketInterface('wss://registrar.vobiz.ai:5063');

const ua = new VobizJsSIP.UA({
  sockets: [socket],
  uri: 'sip:<endpoint-username>@registrar.vobiz.ai',
  password: '<endpoint-password>',
});

ua.start();
```

### Hold, resume and renegotiation

```javascript
session.hold();                          // re-INVITE with a=sendonly
session.unhold();                        // re-INVITE with a=sendrecv
session.hold({ useUpdate: true });       // SIP UPDATE instead of re-INVITE
session.renegotiate();                   // re-INVITE with a fresh offer, same ICE
session.renegotiate({ rtcOfferConstraints: { iceRestart: true } }); // network recovery
```

`hold()`, `unhold()` and `renegotiate()` return `false` (and send nothing) while another offer is in
progress, including a network-recovery re-INVITE that is still waiting for ICE candidates. Retry
after the `done` callback of the pending one.

## How this fork differs from upstream JsSIP

The repository contains only `dist/` (no source tree). Changes against upstream are marked in
`dist/vobiz-jssip.js`; `dist/vobiz-jssip.min.js` is the package `main` and carries the same changes.

| Area | Behaviour in this fork |
|---|---|
| Network-change re-INVITE | A re-INVITE marked as a network change (`isNetworkChange: true`, or an `iceRestart` offer) is sent by a retry loop: every 1 s, up to 20 tries, once the WebSocket is connected and the new offer contains ICE candidates. |
| Regular re-INVITE | Hold, resume, `renegotiate()` and session-timer refreshes are sent immediately with the candidates already gathered, as in upstream JsSIP. |
| `renegotiate()` | Resets the WebSocket (disconnect + connect) before a network-change re-INVITE, unless `sendReinviteOnly: true`. A regular renegotiation keeps the socket. |
| Re-offer serialization | No new hold/resume/renegotiate is started while a network-change re-INVITE is pending; a session-timer refresh is skipped in that window because the pending re-INVITE refreshes the session. |
| Transport reconnect | `UA.sendReInviteOnTransportConnect` (default `true`): after the WebSocket reconnects, an ICE-restart re-INVITE is sent for the confirmed session. `UA.sendRegisterOnTransportConnect` (default `true`) re-registers. |
| ICE `failed` | The session is not terminated on `iceconnectionstatechange: failed` (upstream ends it with "RTP Timeout"); recovery is left to the reconnect logic. |
| Registrar host | Defaults point at `registrar.vobiz.ai`. |

`_sendReinvite(options)` accepts `isNetworkChange` (boolean). When it is omitted, an explicit
`rtcOfferConstraints.iceRestart` counts as a network change, so existing reconnect callers in the
browser SDK keep their behaviour.

### Known limits

- A rejected hold or resume (any non-2xx) ends the call with `500 Hold Failed`, as in upstream JsSIP.
  RFC 3261 says a failed re-INVITE should leave the session as it was; changing this is a separate fix.
- A `491 Request Pending` is not retried.
- The bundle reports `JsSIP.version` as `1.0.5` (inherited); the npm package version is in `package.json`.

## Testing

```bash
npm test                 # unit tests, no network (Node 18+)
```

`test/unit/reinvite.test.js` runs every re-INVITE case against **both** `dist/vobiz-jssip.js` and
`dist/vobiz-jssip.min.js`, so a change made to one file and not the other fails. It covers:

- a regular re-INVITE is sent at once, ACKed on 200, and calls `succeeded`; an error response calls `failed`
- `hold()`/`unhold()` without `useUpdate` send a re-INVITE and call `done`
- an `iceRestart` re-INVITE waits for the retry loop; `isNetworkChange: false` overrides it
- `renegotiate()` keeps the WebSocket; `renegotiate({ iceRestart })` resets it; `sendReinviteOnly` keeps it
- nothing new is sent while a network-change re-INVITE is pending

Live call tests (real calls through the Vobiz platform) are in [`test/e2e`](test/e2e/README.md).

## Releasing

Releases are published from GitHub Actions with npm trusted publishing and provenance: create a
GitHub release `vX.Y.Z` matching `package.json` and the `Publish to npm` workflow does the rest. Full
steps are in [CONTRIBUTING.md](CONTRIBUTING.md#releasing-maintainers); changes are listed in
[CHANGELOG.md](CHANGELOG.md). Verify an installed copy with `npm audit signatures`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License

MIT. Based on [JsSIP](https://jssip.net/), Copyright (c) José Luis Millán, MIT License.
