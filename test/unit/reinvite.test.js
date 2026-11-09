// Unit tests for the re-INVITE paths in RTCSession (no network, no browser).
// Runs every case against both dist/vobiz-jssip.js and dist/vobiz-jssip.min.js, because the
// minified file is edited by hand and must behave the same.
//
//   npm test            (node --test test/unit)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Minimal browser globals so the bundle loads and a UA can create an RTCSession.
global.window = global;
// Node 21+ has a read-only global navigator; only add one on older Node.
if (typeof navigator === 'undefined') global.navigator = { userAgent: 'node' };
global.RTCPeerConnection = class {
  constructor() { this.iceGatheringState = 'new'; this.signalingState = 'stable'; }
  addEventListener() {} removeEventListener() {} addTrack() {} getSenders() { return []; } close() {}
  createOffer() { return new Promise(() => {}); }
};
global.RTCSessionDescription = class { constructor(x) { Object.assign(this, x); } };

const STATUS_CONFIRMED = 9;
const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=candidate:1 1 udp 1 10.0.0.1 5000 typ host\r\na=sendrecv\r\n';
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadRTCSession(file) {
  delete require.cache[require.resolve(file)];
  const JsSIP = require(file);
  const socket = {
    via_transport: 'WSS', url: 'wss://x.invalid', sip_uri: 'sip:x.invalid;transport=ws',
    connect() {}, disconnect() {}, send() { return true; }, isConnected() { return false; }, isConnecting() { return false; },
  };
  const ua = new JsSIP.UA({ sockets: [socket], uri: 'sip:a@x.invalid', register: false });
  let Cls;
  ua.on('newRTCSession', (e) => { Cls = e.session.constructor; });
  try { ua.call('sip:b@x.invalid', { mediaStream: { getTracks() { return []; } } }); } catch (e) { /* only the class is needed */ }
  if (!Cls) throw new Error(`could not get RTCSession from ${file}`);
  return Cls;
}

// A confirmed session with the network, peer connection and dialog stubbed out.
// `gather(isNetworkChange)` decides what _createLocalDescription returns.
function fakeSession(Cls, { gather } = {}) {
  const s = Object.create(Cls.prototype);
  const sent = [];
  const transportCalls = [];
  Object.assign(s, {
    _status: STATUS_CONFIRMED,
    _contact: '<sip:a@x.invalid;transport=ws>',
    _sessionTimers: { running: false },
    _connectionPromiseQueue: Promise.resolve(),
    _rtcOfferConstraints: null,
    _rtcReady: true,
    _dialog: { uac_pending_reply: false, uas_pending_reply: false },
    _localHold: false,
    _connection: { setRemoteDescription: () => Promise.resolve() },
    _transport: {
      status: 0,
      isConnecting: () => false,
      disconnect: () => transportCalls.push('disconnect'),
      connect: () => transportCalls.push('connect'),
    },
    _ua: { isConnected: () => true, isRegistered: () => true, isRegistering: () => false },
    inviteInterval: null,
    reconnectTryCount: 0,
    _mangleOffer: (sdp) => sdp,
    _setLocalMediaStatus() {},
    _onhold() {}, _onunhold() {},
    _handleSessionTimersInIncomingResponse() {},
    emit() {},
    sendRequest(method, options) { sent.push({ method, options }); },
    _createLocalDescription(type, constraints, isNetworkChange = false) {
      return gather ? gather(isNetworkChange, constraints) : Promise.resolve(SDP);
    },
  });
  return { s, sent, transportCalls };
}

const ok200 = { status_code: 200, body: SDP, getHeader: (h) => (/content-type/i.test(h) ? 'application/sdp' : undefined) };
const invites = (sent) => sent.filter((x) => x.method === 'INVITE');
const stop = (s) => { if (s.inviteInterval) { clearInterval(s.inviteInterval); s.inviteInterval = null; } };

for (const name of ['vobiz-jssip.js', 'vobiz-jssip.min.js']) {
  const Cls = loadRTCSession(path.join(__dirname, '..', '..', 'dist', name));

  test(`${name}: regular re-INVITE is sent immediately and answered`, async () => {
    const { s, sent } = fakeSession(Cls);
    let succeeded = false;
    s._sendReinvite({ eventHandlers: { succeeded: () => { succeeded = true; } } });
    await tick(); await tick();
    const inv = invites(sent);
    assert.equal(inv.length, 1, 'one INVITE on the wire');
    assert.equal(inv[0].options.body, SDP);
    assert.ok(inv[0].options.extraHeaders.some((h) => /^Contact:/.test(h)));
    inv[0].options.eventHandlers.onSuccessResponse(ok200);
    await tick(); await tick();
    assert.ok(sent.some((x) => x.method === 'ACK'), 'ACK sent for the 200');
    assert.ok(succeeded, 'succeeded callback fired');
    assert.equal(s.inviteInterval, null, 'no retry loop started');
  });

  test(`${name}: hold()/unhold() without useUpdate send a re-INVITE and call done`, async () => {
    const { s, sent } = fakeSession(Cls);
    let held = false;
    assert.equal(s.hold({}, () => { held = true; }), true);
    await tick(); await tick();
    assert.equal(invites(sent).length, 1);
    invites(sent)[0].options.eventHandlers.onSuccessResponse(ok200);
    await tick(); await tick();
    assert.ok(held, 'hold done callback fired');
    let resumed = false;
    assert.equal(s.unhold({}, () => { resumed = true; }), true);
    await tick(); await tick();
    assert.equal(invites(sent).length, 2);
    invites(sent)[1].options.eventHandlers.onSuccessResponse(ok200);
    await tick(); await tick();
    assert.ok(resumed, 'unhold done callback fired');
  });

  test(`${name}: re-INVITE error response calls failed, not succeeded`, async () => {
    const { s, sent } = fakeSession(Cls);
    let failed = null;
    s._sendReinvite({ eventHandlers: { failed: (r) => { failed = r; } } });
    await tick(); await tick();
    invites(sent)[0].options.eventHandlers.onErrorResponse({ status_code: 488 });
    assert.equal(failed && failed.status_code, 488);
  });

  test(`${name}: iceRestart re-INVITE waits for fresh candidates (network-change path)`, async () => {
    let networkCalls = 0;
    const { s, sent } = fakeSession(Cls, {
      gather: (isNetworkChange) => {
        if (isNetworkChange) networkCalls += 1;
        return Promise.resolve(SDP);
      },
    });
    s._sendReinvite({ rtcOfferConstraints: { iceRestart: true }, eventHandlers: {} });
    await tick(); await tick();
    assert.equal(invites(sent).length, 0, 'not sent before the retry loop runs');
    assert.notEqual(s.inviteInterval, null, 'retry loop started');
    await sleep(1150);
    assert.equal(invites(sent).length, 1, 'sent by the loop once candidates are present');
    assert.ok(networkCalls >= 1, 'loop asked for a network-change offer');
    stop(s);
  });

  test(`${name}: explicit isNetworkChange:false overrides iceRestart`, async () => {
    const { s, sent } = fakeSession(Cls);
    s._sendReinvite({ rtcOfferConstraints: { iceRestart: true }, isNetworkChange: false, eventHandlers: {} });
    await tick(); await tick();
    assert.equal(invites(sent).length, 1);
    assert.equal(s.inviteInterval, null);
  });

  test(`${name}: renegotiate() with no options keeps the WebSocket and sends at once (review issue 1)`, async () => {
    const { s, sent, transportCalls } = fakeSession(Cls);
    assert.equal(s.renegotiate({}, () => {}), true);
    await tick(); await tick();
    assert.deepEqual(transportCalls, [], 'socket not reset');
    assert.equal(invites(sent).length, 1);
    assert.equal(s.inviteInterval, null);
  });

  test(`${name}: renegotiate({iceRestart}) still resets the socket and uses the loop`, async () => {
    const { s, sent, transportCalls } = fakeSession(Cls);
    assert.equal(s.renegotiate({ rtcOfferConstraints: { iceRestart: true } }, () => {}), true);
    await tick(); await tick();
    assert.deepEqual(transportCalls, ['disconnect', 'connect']);
    assert.equal(invites(sent).length, 0);
    assert.notEqual(s.inviteInterval, null);
    stop(s);
  });

  test(`${name}: renegotiate({iceRestart, sendReinviteOnly}) keeps the socket`, async () => {
    const { s, transportCalls } = fakeSession(Cls);
    s.renegotiate({ rtcOfferConstraints: { iceRestart: true }, sendReinviteOnly: true }, () => {});
    await tick(); await tick();
    assert.deepEqual(transportCalls, []);
    assert.notEqual(s.inviteInterval, null);
    stop(s);
  });

  test(`${name}: no new re-offer while a network-change re-INVITE is pending (review issue 2)`, async () => {
    const { s, sent } = fakeSession(Cls, { gather: () => new Promise(() => {}) });
    s._sendReinvite({ isNetworkChange: true, eventHandlers: {} });
    await tick();
    assert.notEqual(s.inviteInterval, null);
    assert.equal(s._isReadyToReOffer(), false);
    assert.equal(s.hold({}, () => {}), false, 'hold refused');
    assert.equal(s.renegotiate({}, () => {}), false, 'renegotiate refused');
    s._sendReinvite(); // session-timer refresh path calls this directly
    await tick(); await tick();
    assert.equal(invites(sent).length, 0, 'nothing extra on the wire');
    stop(s);
    assert.equal(s._isReadyToReOffer(), true, 'ready again once the loop is gone');
  });
}
