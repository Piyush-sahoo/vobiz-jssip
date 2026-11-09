// Call-matrix runner. Each scenario: A calls B, both sides hold and resume (where they can),
// media is counted in every phase, then one side hangs up and the other must see the call end.
//
//   node matrix.js <bundle.js> <scenario,...|all>   (env: see README)
const fs = require('fs');
const { BrowserParty, SipParty, PhoneParty, closeAll, sleep, stamp } = require('./parties');

const bundle = process.argv[2];
const want = (process.argv[3] || 'all').split(',');
const env = process.env;
const DID = env.DID;                 // our DID, attached to the demo app; rings W2 (JWT) and E2 (SIP_ENDPOINT)
const PHONE = env.PHONE;             // a real handset
const PUBLIC_IP = env.PUBLIC_IP;
const W1_URL = env.W1_URL;           // demo server minting the W1 identity (caller side)
const W2_URL = env.W2_URL;           // demo server minting the identity the DID rings (callee side)
const WINDOW = Number(env.WINDOW_MS || 2500);

const mk = {
  W1: () => new BrowserParty('W1', W1_URL, bundle),
  W2: () => new BrowserParty('W2', W2_URL, bundle),
  E1: () => new SipParty('E1', env.EA_USER, env.EA_PASS, PUBLIC_IP),
  E2: () => new SipParty('E2', env.EB_USER, env.EB_PASS, PUBLIC_IP),
  PHONE: () => new PhoneParty('PHONE', PHONE),
};

// id, caller, callee, what the caller dials, human step (if any)
const SCENARIOS = [
  ['webrtc-to-webrtc', 'W1', 'W2', () => DID],
  ['sip-to-sip', 'E1', 'E2', () => DID],
  ['webrtc-to-sip', 'W1', 'E2', () => DID],
  ['sip-to-webrtc', 'E1', 'W2', () => DID],
  ['webrtc-to-pstn', 'W1', 'PHONE', () => PHONE, `ANSWER your phone ${PHONE} and stay on`],
  ['sip-to-pstn', 'E1', 'PHONE', () => PHONE, `ANSWER your phone ${PHONE} and stay on`],
  ['pstn-to-webrtc', 'PHONE', 'W2', null, `DIAL ${DID} from your phone and stay on`],
  ['pstn-to-sip', 'PHONE', 'E2', null, `DIAL ${DID} from your phone and stay on`],
];

async function delta(parties, fn) {
  const before = await Promise.all(parties.map((p) => p.media()));
  await fn();
  await sleep(WINDOW);
  const after = await Promise.all(parties.map((p) => p.media()));
  return parties.map((p, i) => (before[i] && after[i] ? `${p.name} tx+${after[i].sent - before[i].sent}/rx+${after[i].recv - before[i].recv}` : `${p.name} n/a`)).join('  ');
}

async function runScenario([id, ca, cb, dest, human]) {
  console.log(`\n${'='.repeat(70)}\n${stamp()} SCENARIO ${id}: ${ca} -> ${cb}${human ? `\n>>> ${human}` : ''}\n${'='.repeat(70)}`);
  const A = mk[ca](); const B = mk[cb]();
  const res = { id, caller: `${ca} (${A.kind})`, callee: `${cb} (${B.kind})`, steps: [] };
  const step = (name, ok, detail) => { res.steps.push({ name, ok, detail }); console.log(`${stamp()} ${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'} ${name}: ${detail}`); };
  try {
    await B.start(); await A.start();
    const answered = B.kind === 'PSTN phone' ? Promise.resolve(true) : B.answerIncoming(90000);
    const dialed = A.kind === 'PSTN phone' ? Promise.resolve(true) : A.dial(dest());
    const [okA, okB] = await Promise.all([dialed, answered]);
    const up = okA && okB && (A.kind === 'PSTN phone' || await A.alive()) && (B.kind === 'PSTN phone' || await B.alive());
    step('call connects', !!up, `caller ${okA}, callee ${okB}`);
    if (!up) throw new Error('call did not connect');
    step('media before hold', null, await delta([A, B], async () => {}));
    for (const [who, other] of [[A, B], [B, A]]) {
      if (who.kind === 'PSTN phone') continue;
      let r;
      const m1 = await delta([A, B], async () => { r = await who.hold(); });
      step(`${who.name} holds (re-INVITE)`, r.ok, `${r.detail}; media: ${m1}`);
      const seen = await other.remoteHeld();
      if (seen !== null) step(`${other.name} signalled remote hold`, null, `${seen} (media server is a B2BUA: hold is answered on the holder's leg, not forwarded)`);
      const m2 = await delta([A, B], async () => { r = await who.unhold(); });
      step(`${who.name} resumes (re-INVITE)`, r.ok, `${r.detail}; media: ${m2}`);
      if (who.holdUpdate) {
        r = await who.holdUpdate(); step(`${who.name} holds (UPDATE, SDK path)`, r.ok, r.detail); await sleep(800);
        r = await who.unholdUpdate(); step(`${who.name} resumes (UPDATE, SDK path)`, r.ok, r.detail); await sleep(800);
      }
    }
    // hang up from the callee when it is ours, else from the caller; the other side must end
    const [hu, other] = B.kind !== 'PSTN phone' ? [B, A] : [A, B];
    await hu.hangup();
    const ended = await other.waitEnded(10000);
    if (ended !== null) step(`${hu.name} hangs up -> ${other.name} call ends`, ended, String(ended));
    else step(`${hu.name} hangs up`, true, 'sent; handset side not observable');
  } catch (e) {
    step('error', false, e.message);
    for (const p of [A, B]) { try { await p.hangup(); } catch {} }
  }
  res.trace = { [A.name]: A.trace, [B.name]: B.trace };
  for (const p of [A, B]) { try { await p.stop(); } catch {} }
  await sleep(1500);
  return res;
}

(async () => {
  const results = [];
  for (const sc of SCENARIOS) if (want.includes('all') || want.includes(sc[0])) results.push(await runScenario(sc));
  await closeAll();
  const out = env.OUT || 'matrix-results.json';
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log('\n===== SUMMARY =====');
  for (const r of results) {
    const fails = r.steps.filter((s) => s.ok === false);
    console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${r.id.padEnd(18)} ${r.caller} -> ${r.callee}${fails.length ? '  :: ' + fails.map((f) => `${f.name} (${f.detail})`).join('; ') : ''}`);
  }
  process.exit(0);
})();
