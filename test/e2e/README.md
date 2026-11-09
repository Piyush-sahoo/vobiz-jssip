# Live call tests

These tests place **real, billed calls** through the Vobiz platform. They build the browser SDK
against this repo's `dist/`, drive [Vobiz-RTC-demo](https://github.com/vobiz-ai/Vobiz-RTC-demo) in
headless Chromium, and use a small raw SIP client (`sipua.js`) for SIP endpoints.

Nothing here contains credentials. Everything comes from environment variables.

## What is tested

Every scenario: A calls B, each side holds and resumes with a **re-INVITE** (browsers also with the
SDK's UPDATE path), RTP packets are counted in every phase, then one side hangs up and the other
must see the call end.

| Scenario | Caller | Callee | Route |
|---|---|---|---|
| `webrtc-to-webrtc` | browser W1 | browser W2 | W1 dials the DID; the DID's app rings W2 |
| `webrtc-to-pstn` | browser W1 | a handset | W1 dials `PHONE` |
| `pstn-to-webrtc` | a handset | browser W2 | you dial the DID |
| `sip-to-sip` | endpoint E1 | endpoint E2 | E1 dials the DID; the app rings E2 |
| `webrtc-to-sip` | browser W1 | endpoint E2 | W1 dials the DID |
| `sip-to-webrtc` | endpoint E1 | browser W2 | E1 dials the DID |
| `sip-to-pstn` | endpoint E1 | a handset | E1 dials `PHONE` |
| `pstn-to-sip` | a handset | endpoint E2 | you dial the DID |

`run.js` is the single-call version (browser to one number) with extra cases: the SDK's network
recovery `renegotiate({ iceRestart })` (`--sdk-netchange`), `renegotiate()` with no options
(`--issue1`), and hold while a network-change re-INVITE is pending (`--issue2`).

## Setup

1. **SDK bundle.** In a checkout of `vobiz-webrtc-sdk`: `npm ci --legacy-peer-deps`, copy this repo's
   `dist/vobiz-jssip.js` and `dist/vobiz-jssip.min.js` into `node_modules/vobiz-jssip/dist/`, then
   `npm run build:nominify`. Use `dist/vobiz-webrtc-sdk.js` as the bundle argument below. The tests
   swap it in for the demo's unpkg SDK, so the demo itself is not modified.
2. **Demo servers.** Run Vobiz-RTC-demo with a public URL on the app's answer URL. The app's `/answer`
   rings `SIP_ENDPOINT` and the JWT identity on inbound DID calls.
   - callee side (W2): `PORT=3011 PUBLIC_URL=<public url> SIP_ENDPOINT=sip:<E2 user>@registrar.vobiz.ai node server.js`
   - caller side (W1), token only, no public URL needed: `PORT=3012 JWT_SUB=e2ew1 node server.js`
3. **DID.** Attach a spare number to the demo app (`POST /api/v1/Account/{id}/numbers/{e164}/application`).
4. **SIP endpoints** (for `sip-*`): create two endpoints on the demo app.
5. `npm install` here, and `npx playwright install chromium` (or set `CHROME_PATH`).

## Run

```bash
export DID=+91XXXXXXXXXX PHONE=+91XXXXXXXXXX PUBLIC_IP=$(curl -s https://api.ipify.org)
export W1_URL=http://localhost:3012 W2_URL=http://localhost:3011
export EA_USER=... EA_PASS=... EB_USER=... EB_PASS=...      # SIP endpoints, only for sip-* scenarios

node matrix.js /path/to/vobiz-webrtc-sdk.js webrtc-to-webrtc,webrtc-to-pstn
node matrix.js /path/to/vobiz-webrtc-sdk.js all             # prompts you to answer/dial the handset

DEMO_URL=http://localhost:3011 node run.js /path/to/vobiz-webrtc-sdk.js +91XXXXXXXXXX --sdk-netchange --issue1 --issue2
```

Results go to `matrix-results.json` (`OUT=` to change), including the SIP trace of each party.

## Results, 2026-11-09 (vobiz-jssip PR #2)

Browser to PSTN (`run.js`, real handset), same SDK (`vobiz-webrtc-sdk` main) with three `dist/` builds:

| Case | jssip 1.0.1 | PR first commit | PR final |
|---|---|---|---|
| SDK hold/unhold (UPDATE) | pass | pass | pass |
| hold/unhold (re-INVITE) | **never sent**, session then stuck | pass | pass |
| ICE-restart re-INVITE | not sent (stuck) | pass | pass |
| `renegotiate()` no options | | **call dropped**, far leg left up | pass |
| `renegotiate({ iceRestart })` (SDK recovery) | | | pass, socket reset then re-INVITE |
| hold while recovery re-INVITE pending | | | refused (`false`) |

Matrix (`matrix.js`, PR final):

| Scenario | Result |
|---|---|
| `webrtc-to-webrtc` | pass: re-INVITE hold/resume both sides (holder's inbound RTP drops to ~0 while held), UPDATE hold both sides, hangup ends the other side |
| `webrtc-to-pstn` | pass (see table above) |
| `sip-*` | **blocked by the platform**: a password SIP endpoint calling over TCP/5060 is rejected by the media server with `486` before the answer URL is fetched (route lookup), even on the app where the JWT browser identity works. Not related to this library. |

Observed platform behaviour: the media server is a B2BUA. A hold re-INVITE is answered on the
holder's leg (`200 recvonly`) and is not forwarded to the other party, who keeps receiving media.
