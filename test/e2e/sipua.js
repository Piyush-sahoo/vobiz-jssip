// Minimal SIP endpoint (UA) over TCP for E2E tests: REGISTER, INVITE (UAC/UAS), re-INVITE hold/resume
// in both directions, BYE, OPTIONS, digest auth, and real PCMU RTP with packet counters.
// Not a general-purpose stack: one dialog at a time, enough to exercise the platform like a softphone.
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');

const rnd = (n = 8) => crypto.randomBytes(n).toString('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type' };

function localIp() {
  for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

// split a header value on commas that are outside <...> and quotes
function splitList(v) {
  const out = []; let cur = ''; let depth = 0; let q = false;
  for (const ch of v) {
    if (ch === '"') q = !q;
    if (!q && ch === '<') depth++;
    if (!q && ch === '>') depth--;
    if (ch === ',' && depth === 0 && !q) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parse(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  const lines = head.split('\r\n');
  const first = lines.shift();
  const headers = [];
  for (const l of lines) {
    if (/^\s/.test(l) && headers.length) { headers[headers.length - 1][1] += ' ' + l.trim(); continue; }
    const i = l.indexOf(':');
    let name = l.slice(0, i).trim().toLowerCase();
    name = COMPACT[name] || name;
    headers.push([name, l.slice(i + 1).trim()]);
  }
  const msg = { first, headers, body, raw };
  const m = first.match(/^SIP\/2\.0 (\d{3}) ?(.*)$/);
  if (m) { msg.status = Number(m[1]); msg.reason = m[2]; } else { const r = first.split(' '); msg.method = r[0]; msg.ruri = r[1]; }
  msg.get = (n) => { const h = headers.find((x) => x[0] === n); return h ? h[1] : undefined; };
  msg.all = (n) => headers.filter((x) => x[0] === n).flatMap((x) => (n === 'via' || n === 'record-route' || n === 'route' ? splitList(x[1]) : [x[1]]));
  msg.cseq = () => { const [num, meth] = (msg.get('cseq') || '').split(/\s+/); return { num: Number(num), method: meth }; };
  return msg;
}

const tagOf = (h) => ((h || '').match(/;tag=([^;>\s]+)/) || [])[1];
const uriOf = (h) => { const m = (h || '').match(/<([^>]+)>/); return m ? m[1] : (h || '').split(';')[0].trim(); };
const sdpDir = (sdp) => ((sdp || '').match(/a=(sendrecv|sendonly|recvonly|inactive)/) || [])[1] || 'sendrecv';
const mirror = { sendonly: 'recvonly', recvonly: 'sendonly', inactive: 'inactive', sendrecv: 'sendrecv' };

class SipUA extends EventEmitter {
  constructor({ user, pass, name, domain = 'registrar.vobiz.ai', port = 5060, publicIp, autoAnswer = true, verbose = true }) {
    super();
    Object.assign(this, { user, pass, name: name || user.slice(0, 9), domain, port, publicIp, autoAnswer, verbose });
    this.buf = '';
    this.pending = new Map(); // branch -> {resolve, msg}
    this.cseq = Math.floor(Math.random() * 1000) + 1;
    this.dialog = null;
    this.rtp = { sock: null, port: 0, remote: null, sent: 0, recv: 0, timer: null, dir: 'sendrecv', marks: [] };
    this.trace = [];
    this.t0 = Date.now();
  }

  log(...a) { if (this.verbose) console.log(`${((Date.now() - this.t0) / 1000).toFixed(2).padStart(7)}s [${this.name}]`, ...a); }

  async start() {
    await this._rtpOpen();
    await new Promise((resolve, reject) => {
      this.sock = net.connect({ host: this.domain, port: this.port }, resolve);
      this.sock.once('error', reject);
      this.sock.on('data', (d) => this._onData(d.toString('binary')));
      this.sock.on('close', () => this.log('TCP closed'));
    });
    this.lip = this.sock.localAddress.replace(/^::ffff:/, '');
    this.lport = this.sock.localPort;
    this.contactHost = `${this.publicIp || this.lip}:${this.lport}`;
    this.contact = `<sip:${this.user}@${this.contactHost};transport=tcp>`;
  }

  stop() { clearInterval(this.rtp.timer); try { this.rtp.sock.close(); } catch {} try { this.sock.destroy(); } catch {} }

  // ---------- transport ----------
  _onData(chunk) {
    this.buf += chunk;
    for (;;) {
      while (this.buf.startsWith('\r\n')) this.buf = this.buf.slice(2); // keepalive CRLF
      const i = this.buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = this.buf.slice(0, i);
      const cl = Number((head.match(/\r\n(?:content-length|l)\s*:\s*(\d+)/i) || [])[1] || 0);
      if (this.buf.length < i + 4 + cl) return;
      const raw = this.buf.slice(0, i + 4 + cl);
      this.buf = this.buf.slice(i + 4 + cl);
      this._onMsg(parse(raw));
    }
  }

  _send(text) { this.sock.write(Buffer.from(text, 'binary')); }

  _note(dir, msg) {
    const c = msg.cseq();
    const line = msg.status ? `${msg.status} ${msg.reason}` : `${msg.method}`;
    const dirSdp = msg.body && msg.body.includes('m=audio') ? ` ${sdpDir(msg.body)}` : '';
    if (c.method !== 'OPTIONS' && c.method !== 'REGISTER' && msg.method !== 'NOTIFY') {
      this.trace.push(`${dir} ${line} [${c.num} ${c.method}]${dirSdp}`);
      this.log(`${dir} ${line} [${c.num} ${c.method}]${dirSdp}`);
    }
  }

  _build({ method, ruri, headers, body = '' }) {
    const lines = [`${method} ${ruri} SIP/2.0`, ...headers, 'Max-Forwards: 70', `User-Agent: vobiz-e2e-sipua`];
    if (body) lines.push('Content-Type: application/sdp');
    lines.push(`Content-Length: ${Buffer.byteLength(body, 'binary')}`, '', body);
    return lines.join('\r\n');
  }

  // send a request and resolve with the final response (handles 1xx and digest challenges)
  request({ method, ruri, to, from, callId, cseq, extra = [], body = '', routes = [], onProvisional }) {
    return new Promise((resolve) => {
      const attempt = (authHeader) => {
        const branch = `z9hG4bK${rnd()}`;
        const num = cseq !== undefined && !authHeader ? cseq : this.cseq++;
        const headers = [
          `Via: SIP/2.0/TCP ${this.lip}:${this.lport};branch=${branch};rport`,
          ...routes.map((r) => `Route: ${r}`),
          `From: ${from}`, `To: ${to}`, `Call-ID: ${callId}`, `CSeq: ${num} ${method}`,
          `Contact: ${this.contact}`, ...extra, ...(authHeader ? [authHeader] : []),
        ];
        const text = this._build({ method, ruri, headers, body });
        const reqMsg = parse(text);
        this._note('>>', reqMsg);
        this.pending.set(branch, (res) => {
          if (res.status < 200) { if (onProvisional) onProvisional(res); return false; }
          if ((res.status === 401 || res.status === 407) && !authHeader) {
            if (method === 'INVITE') this._ackNon2xx(reqMsg, res, branch);
            const ch = res.get(res.status === 401 ? 'www-authenticate' : 'proxy-authenticate');
            const hdr = `${res.status === 401 ? 'Authorization' : 'Proxy-Authorization'}: ${this._digest(ch, method, ruri)}`;
            setImmediate(() => attempt(hdr));
            return true;
          }
          if (method === 'INVITE' && res.status >= 300) this._ackNon2xx(reqMsg, res, branch);
          resolve({ res, req: reqMsg, cseqNum: num });
          return true;
        });
        this._send(text);
      };
      attempt(null);
    });
  }

  _digest(ch, method, uri) {
    const p = {}; ch.replace(/(\w+)="?([^",]+)"?/g, (_, k, v) => { p[k] = v; });
    const ha1 = md5(`${this.user}:${p.realm}:${this.pass}`);
    const ha2 = md5(`${method}:${uri}`);
    if (p.qop) {
      const nc = '00000001'; const cnonce = rnd(4);
      const resp = md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:auth:${ha2}`);
      return `Digest username="${this.user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${resp}", algorithm=MD5, qop=auth, nc=${nc}, cnonce="${cnonce}"${p.opaque ? `, opaque="${p.opaque}"` : ''}`;
    }
    return `Digest username="${this.user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${md5(`${ha1}:${p.nonce}:${ha2}`)}", algorithm=MD5${p.opaque ? `, opaque="${p.opaque}"` : ''}`;
  }

  _ackNon2xx(req, res, branch) {
    const headers = [
      `Via: SIP/2.0/TCP ${this.lip}:${this.lport};branch=${branch};rport`,
      `From: ${req.get('from')}`, `To: ${res.get('to')}`, `Call-ID: ${req.get('call-id')}`, `CSeq: ${req.cseq().num} ACK`,
    ];
    this._send(this._build({ method: 'ACK', ruri: req.ruri, headers }));
  }

  _respond(req, status, reason, { body = '', toTag, extra = [] } = {}) {
    let to = req.get('to');
    if (toTag && !tagOf(to)) to += `;tag=${toTag}`;
    const lines = [`SIP/2.0 ${status} ${reason}`, ...req.all('via').map((v) => `Via: ${v}`)];
    if (req.method === 'INVITE' || req.method === 'UPDATE') for (const rr of req.headers.filter((h) => h[0] === 'record-route')) lines.push(`Record-Route: ${rr[1]}`);
    lines.push(`From: ${req.get('from')}`, `To: ${to}`, `Call-ID: ${req.get('call-id')}`, `CSeq: ${req.get('cseq')}`);
    if (status >= 200 && status < 300 && (req.method === 'INVITE' || req.method === 'UPDATE')) lines.push(`Contact: ${this.contact}`);
    lines.push(...extra, 'User-Agent: vobiz-e2e-sipua');
    if (body) lines.push('Content-Type: application/sdp');
    lines.push(`Content-Length: ${Buffer.byteLength(body, 'binary')}`, '', body);
    const text = lines.join('\r\n');
    this._note('>>', parse(text));
    this._send(text);
  }

  _onMsg(msg) {
    if (msg.status) {
      const via = msg.all('via')[0] || '';
      const branch = (via.match(/branch=([^;\s]+)/) || [])[1];
      const h = this.pending.get(branch);
      this._note('<<', msg);
      if (h && h(msg)) this.pending.delete(branch);
      return;
    }
    this._note('<<', msg);
    const m = msg.method;
    if (m === 'OPTIONS' || m === 'NOTIFY' || m === 'MESSAGE' || m === 'INFO') return this._respond(msg, 200, 'OK');
    if (m === 'ACK') { this.emit('ack', msg); return; }
    if (m === 'CANCEL') { this._respond(msg, 200, 'OK'); this.emit('cancel'); return; }
    if (m === 'BYE') {
      this._respond(msg, 200, 'OK');
      if (this.dialog && this.dialog.callId === msg.get('call-id')) { this.dialog.ended = 'remote BYE'; this._rtpStop(); }
      this.emit('bye', msg);
      return;
    }
    if (m === 'INVITE' || m === 'UPDATE') {
      const inDialog = !!tagOf(msg.get('to'));
      if (inDialog && this.dialog && this.dialog.callId === msg.get('call-id')) {
        // re-INVITE / UPDATE from the far end: answer with the mirrored direction
        const offerDir = sdpDir(msg.body);
        if (msg.body) this._rtpRemote(msg.body);
        const ans = mirror[offerDir] || 'sendrecv';
        this.rtp.dir = ans;
        this.rtp.marks.push({ t: Date.now(), ev: `remote ${m} ${offerDir}` });
        this.emit('remoteReoffer', { method: m, offerDir });
        if (m === 'INVITE') this._respond(msg, 100, 'Trying');
        this._respond(msg, 200, 'OK', { body: msg.body ? this._sdp(ans) : '' });
        return;
      }
      if (inDialog) return this._respond(msg, 481, 'Call/Transaction Does Not Exist');
      // new incoming call
      if (this.dialog && !this.dialog.ended) return this._respond(msg, 486, 'Busy Here');
      const toTag = rnd(4);
      this._respond(msg, 100, 'Trying');
      this.dialog = {
        callId: msg.get('call-id'), localTag: toTag, remoteTag: tagOf(msg.get('from')),
        local: `${msg.get('to')};tag=${toTag}`, remote: msg.get('from'),
        remoteTarget: uriOf(msg.get('contact')), routes: msg.all('record-route'), uas: true, inviteReq: msg,
      };
      this.emit('incoming', msg);
      if (this.autoAnswer) setTimeout(() => this.answer(), 600);
      return;
    }
    this._respond(msg, 405, 'Method Not Allowed');
  }

  answer() {
    const d = this.dialog; const req = d.inviteReq;
    this._respond(req, 180, 'Ringing', { toTag: d.localTag });
    if (req.body) this._rtpRemote(req.body);
    setTimeout(() => {
      this._respond(req, 200, 'OK', { toTag: d.localTag, body: this._sdp('sendrecv') });
      this._rtpStart();
      d.confirmed = Date.now();
      this.emit('answered');
    }, 300);
  }

  // ---------- registration & calls ----------
  async register(expires = 300) {
    const aor = `sip:${this.user}@${this.domain}`;
    const { res } = await this.request({ method: 'REGISTER', ruri: `sip:${this.domain}`, to: `<${aor}>`, from: `<${aor}>;tag=${rnd(4)}`, callId: `reg-${rnd()}`, extra: [`Expires: ${expires}`] });
    this.log(`REGISTER -> ${res.status} ${res.reason}`);
    return res.status;
  }

  async call(target) {
    const aor = `sip:${this.user}@${this.domain}`;
    const ruri = target.startsWith('sip:') ? target : `sip:${target}@${this.domain}`;
    const callId = `e2e-${rnd()}`;
    const fromTag = rnd(4);
    const from = `<${aor}>;tag=${fromTag}`;
    this.dialog = { callId, localTag: fromTag, local: from, remote: `<${ruri}>`, uas: false };
    const { res, cseqNum } = await this.request({
      method: 'INVITE', ruri, to: `<${ruri}>`, from, callId, body: this._sdp('sendrecv'),
      onProvisional: (r) => { if (r.body) this._rtpRemote(r.body); },
    });
    if (res.status >= 300) { this.dialog.ended = `${res.status} ${res.reason}`; return res.status; }
    Object.assign(this.dialog, { remote: res.get('to'), remoteTag: tagOf(res.get('to')), remoteTarget: uriOf(res.get('contact')), routes: res.all('record-route').reverse(), confirmed: Date.now() });
    this._ack2xx(cseqNum);
    if (res.body) this._rtpRemote(res.body);
    this._rtpStart();
    return res.status;
  }

  _ack2xx(cseqNum) {
    const d = this.dialog;
    const headers = [
      `Via: SIP/2.0/TCP ${this.lip}:${this.lport};branch=z9hG4bK${rnd()};rport`,
      ...d.routes.map((r) => `Route: ${r}`),
      `From: ${d.local}`, `To: ${d.remote}`, `Call-ID: ${d.callId}`, `CSeq: ${cseqNum} ACK`, `Contact: ${this.contact}`,
    ];
    const text = this._build({ method: 'ACK', ruri: d.remoteTarget, headers });
    this._note('>>', parse(text));
    this._send(text);
  }

  async _inDialog(method, body = '') {
    const d = this.dialog;
    return this.request({ method, ruri: d.remoteTarget, to: d.remote, from: d.local, callId: d.callId, body, routes: d.routes });
  }

  async reoffer(dir) {
    this.rtp.marks.push({ t: Date.now(), ev: `local re-INVITE ${dir}` });
    const { res, cseqNum } = await this._inDialog('INVITE', this._sdp(dir));
    if (res.status >= 200 && res.status < 300) { this._ack2xx(cseqNum); this.rtp.dir = dir; }
    return { status: res.status, answerDir: res.body ? sdpDir(res.body) : null };
  }

  hold() { return this.reoffer('sendonly'); }
  unhold() { return this.reoffer('sendrecv'); }

  async hangup() {
    if (!this.dialog || this.dialog.ended) return null;
    const { res } = await this._inDialog('BYE');
    this.dialog.ended = 'local BYE'; this._rtpStop();
    return res.status;
  }

  // ---------- media ----------
  _sdp(dir) {
    const ip = this.publicIp || this.lip;
    return ['v=0', `o=e2e ${this.t0} ${Date.now()} IN IP4 ${ip}`, 's=e2e', `c=IN IP4 ${ip}`, 't=0 0',
      `m=audio ${this.rtp.port} RTP/AVP 0 101`, 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-15', 'a=ptime:20', `a=${dir}`, ''].join('\r\n');
  }

  _rtpOpen() {
    return new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      s.on('message', () => { this.rtp.recv += 1; });
      s.bind(0, () => { this.rtp.sock = s; this.rtp.port = s.address().port; resolve(); });
    });
  }

  _rtpRemote(sdp) {
    const ip = (sdp.match(/c=IN IP4 ([\d.]+)/) || [])[1];
    const port = Number((sdp.match(/m=audio (\d+)/) || [])[1]);
    if (ip && port) this.rtp.remote = { ip, port };
  }

  _rtpStart() {
    if (this.rtp.timer) return;
    let seq = 0; let ts = 0; const ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.rtp.timer = setInterval(() => {
      if (!this.rtp.remote || this.rtp.dir === 'recvonly' || this.rtp.dir === 'inactive') return;
      const pkt = Buffer.alloc(12 + 160, 0xff);
      pkt[0] = 0x80; pkt[1] = 0; pkt.writeUInt16BE(seq++ & 0xffff, 2); pkt.writeUInt32BE(ts >>> 0, 4); pkt.writeUInt32BE(ssrc, 8);
      ts += 160;
      this.rtp.sock.send(pkt, this.rtp.remote.port, this.rtp.remote.ip);
      this.rtp.sent += 1;
    }, 20);
  }

  _rtpStop() { clearInterval(this.rtp.timer); this.rtp.timer = null; }

  // packets received in a window
  rtpSnapshot() { return { sent: this.rtp.sent, recv: this.rtp.recv }; }
}

module.exports = { SipUA, localIp };
