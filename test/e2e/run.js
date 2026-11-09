// E2E: drive Vobiz-RTC-demo in headless Chrome with a chosen SDK bundle, place one call,
// then exercise hold/unhold (UPDATE and re-INVITE), an ICE-restart re-INVITE, and
// optionally renegotiate() without iceRestart. Logs every SIP message on the WebSocket.
//
//   node run.js <bundle.js> <+E164 dest> [--login=token|password] [--issue1]
const { chromium } = require('playwright-core');
const path = require('path');

const [bundle, dest] = process.argv.slice(2);
const flags = process.argv.slice(4);
const LOGIN = (flags.find((f) => f.startsWith('--login=')) || '--login=token').split('=')[1];
const ISSUE1 = flags.includes('--issue1');
const DEMO = process.env.DEMO_URL || 'http://localhost:3000';
const SDK_URL = 'https://unpkg.com/vobiz-webrtc-sdk@1.0.3/dist/vobiz-webrtc-sdk.min.js';
// Chromium from `npx playwright install chromium`, or set CHROME_PATH to any Chrome/Chromium binary.
const CHROME = process.env.CHROME_PATH || undefined;

const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const sip = []; // {t, dir, line, cseq}

function sipSummary(payload) {
  const s = typeof payload === 'string' ? payload : payload.toString();
  const first = s.split('\r\n')[0];
  if (!/SIP\/2\.0/.test(first)) return null;
  const cseq = (s.match(/\r\nCSeq:\s*([^\r]*)/i) || [])[1] || '';
  const sdpDir = (s.match(/a=(sendonly|recvonly|inactive|sendrecv)/) || [])[1] || '';
  const cands = (s.match(/a=candidate/g) || []).length;
  return { first, cseq, sdpDir, cands };
}

async function step(name, fn) {
  log(`--- ${name}`);
  const before = sip.length;
  let outcome;
  try { outcome = await fn(); } catch (e) { outcome = `ERROR ${e.message}`; }
  const wire = sip.slice(before).filter((m) => !/OPTIONS|REGISTER|NOTIFY/.test(m.cseq)).map((m) => `${m.dir} ${m.first.replace(/ SIP\/2\.0$/, '')} [${m.cseq}]${m.sdpDir ? ' ' + m.sdpDir : ''}`);
  results.push({ name, outcome, wire });
  log(`=> ${name}: ${outcome}`);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.route(SDK_URL, (route) => route.fulfill({ path: bundle, contentType: 'application/javascript' }));
  page.on('websocket', (ws) => {
    if (!/5063/.test(ws.url())) return;
    log(`ws open ${ws.url()}`);
    const on = (dir) => (ev) => { const m = sipSummary(ev.payload); if (m) { sip.push({ t: Date.now(), dir, ...m }); if (!/OPTIONS/.test(m.cseq)) log(`${dir} ${m.first} [${m.cseq}]${m.sdpDir ? ' ' + m.sdpDir : ''}${m.cands ? ' cand=' + m.cands : ''}`); } };
    ws.on('framesent', on('>>'));
    ws.on('framereceived', on('<<'));
    ws.on('close', () => log('ws closed'));
  });
  page.on('console', (m) => { const t = m.text(); if (/Re-Invite Sent|error|Error|terminat|Hold Failed/i.test(t) && t.length < 400) log(`[console] ${t}`); });

  await page.goto(DEMO);
  await page.evaluate(() => {
    window.__ev = [];
    const orig = window.createClient;
    window.createClient = function () {
      orig();
      for (const e of ['onLogin', 'onLoginFailed', 'onCallAnswered', 'onCallTerminated', 'onCallFailed', 'onCallHold', 'onCallResume', 'onConnectionChange'])
        vobiz.client.on(e, (x) => window.__ev.push({ e, t: Date.now(), x: typeof x === 'string' ? x : (x && (x.reason || x.state || x.callUUID)) || null }));
    };
  });
  const waitEv = (e, ms, since = 0) => page.waitForFunction(([e, since]) => window.__ev.some((x) => x.e === e && x.t > since), [e, since], { timeout: ms }).then(() => true).catch(() => false);
  const now = () => page.evaluate(() => Date.now());
  const sess = 'vobiz.client._currentSession && vobiz.client._currentSession.session';

  if (LOGIN === 'token') await page.evaluate(() => { setAuthMode('token'); doTokenLogin(); });
  else await page.evaluate(([u, p]) => { document.getElementById('username').value = u; document.getElementById('password').value = p; doLogin(); }, [process.env.SIP_USER, process.env.SIP_PASS]);
  if (!(await waitEv('onLogin', 20000))) { log('LOGIN FAILED', await page.evaluate(() => JSON.stringify(window.__ev))); await browser.close(); process.exit(2); }
  log(`logged in (${LOGIN}), bundle ${path.basename(bundle)}`);

  await page.evaluate((d) => { document.getElementById('destination').value = d; doCall(); }, dest);
  if (!(await waitEv('onCallAnswered', 45000))) {
    log('CALL NOT ANSWERED', await page.evaluate(() => JSON.stringify(window.__ev)));
    await page.evaluate(() => { try { doHangup(); } catch (e) {} }); await sleep(1500); await browser.close(); process.exit(3);
  }
  log('answered'); await sleep(4000);

  await step('SDK hold() [UPDATE path, shipped in SDK main]', async () => {
    const s = await now(); const ok = await page.evaluate(() => vobiz.client.hold());
    return `returned ${ok}, onCallHold ${await waitEv('onCallHold', 8000, s) ? 'fired' : 'NOT fired'}`;
  });
  await sleep(2000);
  await step('SDK unhold() [UPDATE path]', async () => {
    const s = await now(); const ok = await page.evaluate(() => vobiz.client.unhold());
    return `returned ${ok}, onCallResume ${await waitEv('onCallResume', 8000, s) ? 'fired' : 'NOT fired'}`;
  });
  await sleep(2000);

  const jsHold = (action) => page.evaluate(([action, sess]) => new Promise((res) => {
    const s = eval(sess); let done = false;
    const sent = s[action]({}, () => { done = true; res(`sent=${sent}, done callback fired`); });
    setTimeout(() => { if (!done) res(`sent=${sent}, done callback NOT fired in 8 s, status=${s.status}`); }, 8000);
  }), [action, sess]);
  await step('JsSIP session.hold() [re-INVITE path, what PR #2 fixes]', () => jsHold('hold'));
  await sleep(2000);
  await step('JsSIP session.unhold() [re-INVITE path]', () => jsHold('unhold'));
  await sleep(2000);

  await step('ICE-restart re-INVITE [network-change path, must still work]', () => page.evaluate((sess) => new Promise((res) => {
    const s = eval(sess); let done = false;
    s._sendReinvite({ rtcOfferConstraints: { iceRestart: true }, eventHandlers: { succeeded: () => { done = true; res('succeeded callback fired'); }, failed: (r) => { done = true; res(`failed ${r && r.status_code}`); } } });
    setTimeout(() => { if (!done) res(`no result in 12 s, status=${s.status}`); }, 12000);
  }), sess));
  await sleep(2000);

  if (ISSUE1) {
    await step('renegotiate() without iceRestart/useUpdate [review issue 1]', () => page.evaluate((sess) => new Promise((res) => {
      const s = eval(sess); let done = false;
      const ok = s.renegotiate({}, () => { done = true; res(`returned ${ok}, done fired, status=${s.status}`); });
      setTimeout(() => { if (!done) res(`returned ${ok}, done NOT fired in 10 s, status=${s.status} (9=confirmed, 8=terminated)`); }, 10000);
    }), sess));
    await sleep(1000);
  }

  if (flags.includes('--sdk-netchange')) {
    await step('renegotiate({iceRestart}) [SDK networkManager path: socket reset + re-INVITE]', () => page.evaluate((sess) => new Promise((res) => {
      const s = eval(sess); let done = false;
      const ok = s.renegotiate({ rtcOfferConstraints: { iceRestart: true } }, () => { done = true; res(`returned ${ok}, done fired, status=${s.status}`); });
      setTimeout(() => { if (!done) res(`returned ${ok}, done NOT fired in 15 s, status=${s.status}`); }, 15000);
    }), sess));
    await sleep(2000);
  }

  if (flags.includes('--issue2')) {
    await step('hold() while a network-change re-INVITE is pending [review issue 2]', () => page.evaluate((sess) => new Promise((res) => {
      const s = eval(sess);
      // isNetworkChange without iceRestart on a connected call: no new candidates, so the loop stays pending
      s._sendReinvite({ isNetworkChange: true, eventHandlers: {} });
      setTimeout(() => {
        const pending = s.inviteInterval != null;
        const sent = s.hold({}, () => {});
        res(`loop pending=${pending}, hold() returned ${sent} (expected false), status=${s.status}`);
      }, 1500);
    }), sess));
    await sleep(3000);
  }

  const alive = await page.evaluate((sess) => { const s = eval(sess); return s ? s.status : 'gone'; }, sess);
  log(`session status before hangup: ${alive}`);
  await page.evaluate(() => { try { doHangup(); } catch (e) {} });
  await sleep(2500);
  await browser.close();
  console.log('\n===== RESULTS ' + path.basename(bundle) + ' =====');
  for (const r of results) { console.log(`* ${r.name}\n    ${r.outcome}`); for (const w of r.wire) console.log(`      ${w}`); }
  console.log(`* session status before hangup: ${alive}`);
  console.log('EVENTS', JSON.stringify((await Promise.resolve([]))));
})().catch((e) => { console.error(e); process.exit(1); });
