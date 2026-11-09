// Uniform "party" wrappers for the call matrix: a browser running the Vobiz SDK (WebRTC) and a
// SIP endpoint (sipua.js). Every party exposes the same async API so scenarios are written once.
const { chromium } = require('playwright-core');
const path = require('path');
const { SipUA } = require('./sipua');

const SDK_URL = 'https://unpkg.com/vobiz-webrtc-sdk@1.0.3/dist/vobiz-webrtc-sdk.min.js';
// Chromium from `npx playwright install chromium`, or set CHROME_PATH to any Chrome/Chromium binary.
const CHROME = process.env.CHROME_PATH || undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browserPromise = null;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s`;

function sharedBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: CHROME, headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
  }
  return browserPromise;
}

function sipLine(payload) {
  const s = typeof payload === 'string' ? payload : payload.toString();
  const first = s.split('\r\n')[0];
  if (!/SIP\/2\.0/.test(first)) return null;
  const cseq = (s.match(/\r\nCSeq:\s*([^\r]*)/i) || [])[1] || '';
  if (/OPTIONS|REGISTER|MESSAGE|NOTIFY/.test(cseq)) return null;
  const dir = (s.match(/a=(sendonly|recvonly|inactive|sendrecv)/) || [])[1] || '';
  return `${first.replace(/ SIP\/2\.0$/, '').replace(/^SIP\/2\.0 /, '')} [${cseq}]${dir ? ' ' + dir : ''}`;
}

class BrowserParty {
  // demoUrl: a Vobiz-RTC-demo server; its POST /token decides the JWT identity
  constructor(name, demoUrl, bundle) { Object.assign(this, { name, demoUrl, bundle, kind: 'WebRTC', trace: [] }); }

  log(...a) { console.log(stamp(), `[${this.name}]`, ...a); }

  async start() {
    const browser = await sharedBrowser();
    this.ctx = await browser.newContext({ permissions: ['microphone'] });
    this.page = await this.ctx.newPage();
    await this.page.route(SDK_URL, (route) => route.fulfill({ path: this.bundle, contentType: 'application/javascript' }));
    this.page.on('websocket', (ws) => {
      if (!/5063/.test(ws.url())) return;
      const on = (d) => (ev) => { const l = sipLine(ev.payload); if (l) { this.trace.push(`${d} ${l}`); this.log(d, l); } };
      ws.on('framesent', on('>>')); ws.on('framereceived', on('<<'));
    });
    await this.page.goto(this.demoUrl);
    await this.page.evaluate(() => {
      window.__ev = [];
      const orig = window.createClient;
      window.createClient = function () {
        orig();
        for (const e of ['onLogin', 'onLoginFailed', 'onCallAnswered', 'onCallTerminated', 'onCallFailed', 'onCallHold', 'onCallResume', 'onIncomingCall'])
          vobiz.client.on(e, () => window.__ev.push({ e, t: Date.now() }));
      };
      window.__s = () => vobiz.client._currentSession && vobiz.client._currentSession.session;
    });
    await this.page.evaluate(() => { setAuthMode('token'); doTokenLogin(); });
    if (!(await this._waitEv('onLogin', 20000))) throw new Error(`${this.name} login failed`);
    this.identity = await this.page.evaluate(() => (window.lastToken && lastToken.sip_username) || '');
    this.log(`logged in as ${this.identity}`);
  }

  _waitEv(e, ms, since = 0) {
    return this.page.waitForFunction(([e, since]) => window.__ev.some((x) => x.e === e && x.t > since), [e, since], { timeout: ms }).then(() => true).catch(() => false);
  }

  async dial(dest) {
    const since = await this.page.evaluate(() => Date.now());
    await this.page.evaluate((d) => { document.getElementById('destination').value = d; doCall(); }, dest);
    const ok = await Promise.race([this._waitEv('onCallAnswered', 50000, since), this._waitEv('onCallFailed', 50000, since).then((f) => (f ? false : null))]);
    return ok === true;
  }

  async answerIncoming(ms = 60000) {
    if (!(await this._waitEv('onIncomingCall', ms))) return false;
    await sleep(700);
    await this.page.evaluate(() => doAnswer());
    return this.page.waitForFunction(() => window.__s() && window.__s().status === 9, null, { timeout: 10000 }).then(() => true).catch(() => false);
  }

  _reoffer(action, useUpdate) {
    return this.page.evaluate(([action, useUpdate]) => new Promise((res) => {
      const s = window.__s(); if (!s) return res({ ok: false, detail: 'no session' });
      let done = false;
      const sent = s[action](useUpdate ? { useUpdate: true } : {}, () => { done = true; res({ ok: true, detail: `${useUpdate ? 'UPDATE' : 're-INVITE'} accepted` }); });
      if (!sent) return res({ ok: false, detail: `${action}() returned false` });
      setTimeout(() => { if (!done) res({ ok: false, detail: `no answer in 8 s (status ${s.status})` }); }, 8000);
    }), [action, useUpdate]);
  }

  hold() { return this._reoffer('hold', false); }
  unhold() { return this._reoffer('unhold', false); }
  holdUpdate() { return this._reoffer('hold', true); }
  unholdUpdate() { return this._reoffer('unhold', true); }

  remoteHeld() { return this.page.evaluate(() => { const s = window.__s(); return !!(s && s.isOnHold().remote); }); }

  media() {
    return this.page.evaluate(async () => {
      const s = window.__s(); if (!s || !s.connection) return { sent: 0, recv: 0 };
      const st = await s.connection.getStats(); let sent = 0; let recv = 0;
      st.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'audio') sent += r.packetsSent || 0; if (r.type === 'inbound-rtp' && r.kind === 'audio') recv += r.packetsReceived || 0; });
      return { sent, recv };
    });
  }

  alive() { return this.page.evaluate(() => { const s = window.__s(); return !!(s && s.status === 9); }); }

  async hangup() { await this.page.evaluate(() => { try { doHangup(); } catch (e) {} }); return true; }

  waitEnded(ms = 10000) {
    return this.page.waitForFunction(() => { const s = window.__s(); return !s || s.status === 8; }, null, { timeout: ms }).then(() => true).catch(() => false);
  }

  async stop() { try { await this.page.evaluate(() => { try { doLogout(); } catch (e) {} }); } catch {} await sleep(500); await this.ctx.close(); }
}

class SipParty {
  constructor(name, user, pass, publicIp) { this.name = name; this.kind = 'SIP endpoint'; this.ua = new SipUA({ user, pass, name, publicIp }); this.identity = user; }
  get trace() { return this.ua.trace; }
  log(...a) { this.ua.log(...a); }
  async start() { await this.ua.start(); const s = await this.ua.register(120); if (s !== 200) throw new Error(`${this.name} REGISTER ${s}`); this.ua.on('remoteReoffer', (r) => { this._remoteDir = r.offerDir; }); }
  async dial(dest) { const s = await this.ua.call(dest); return s >= 200 && s < 300; }
  answerIncoming(ms = 60000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      this.ua.once('answered', () => { clearTimeout(t); resolve(true); });
    });
  }
  async hold() { const r = await this.ua.hold(); return { ok: r.status === 200, detail: `re-INVITE ${r.status}, answer ${r.answerDir}` }; }
  async unhold() { const r = await this.ua.unhold(); return { ok: r.status === 200, detail: `re-INVITE ${r.status}, answer ${r.answerDir}` }; }
  async remoteHeld() { return this._remoteDir === 'sendonly' || this._remoteDir === 'inactive'; }
  async media() { return this.ua.rtpSnapshot(); }
  async alive() { return !!(this.ua.dialog && !this.ua.dialog.ended); }
  async hangup() { return this.ua.hangup(); }
  waitEnded(ms = 10000) {
    return new Promise((resolve) => {
      if (this.ua.dialog && this.ua.dialog.ended) return resolve(true);
      const t = setTimeout(() => resolve(false), ms);
      this.ua.once('bye', () => { clearTimeout(t); resolve(true); });
    });
  }
  async stop() { try { await this.ua.register(0); } catch {} this.ua.stop(); }
}

// The PSTN phone is a person: the runner prints what to do and waits.
class PhoneParty {
  constructor(name, number) { Object.assign(this, { name, number, kind: 'PSTN phone', identity: number, trace: [] }); }
  log(...a) { console.log(stamp(), `[${this.name}]`, ...a); }
  async start() {}
  async hold() { return { ok: false, detail: 'n/a (handset)' }; }
  async unhold() { return { ok: false, detail: 'n/a (handset)' }; }
  async remoteHeld() { return null; }
  async media() { return null; }
  async alive() { return null; }
  async hangup() { return null; }
  async waitEnded() { return null; }
  async stop() {}
}

async function closeAll() { if (browserPromise) { const b = await browserPromise; await b.close(); browserPromise = null; } }

module.exports = { BrowserParty, SipParty, PhoneParty, closeAll, sleep, stamp };
