import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { once } from 'node:events';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { Transform } from 'node:stream';
import { verifyAccess } from './access.mjs';
import { allowedHost, defaultHosts, hash, matches, publicAddress, RateLimit, token } from './policy.mjs';

const ACTION = 'patreon_access';
const MINUTE = 60_000;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };
const fail = (status, message) => Object.assign(new Error(message), { status });
async function body(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length; if (bytes > 4096) throw fail(413, 'Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'Invalid request'); }
}
function bearer(req) { return /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1] || ''; }

export async function dialPublic(host) {
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw fail(403, 'Destination rejected');
  // Connect to the checked IP, not the hostname: prevents DNS rebinding between check and connect.
  const socket = net.connect({ host: addresses[0].address, family: addresses[0].family, port: 443 });
  socket.setTimeout(10_000, () => socket.destroy(new Error('Connect timeout')));
  try { await once(socket, 'connect'); } catch { socket.destroy(); throw fail(502, 'Destination unavailable'); }
  socket.setTimeout(90_000, () => socket.destroy());
  socket.on('error', () => {});
  return socket;
}
export function createRelay(config, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const dial = dependencies.dial || dialPublic;
  const verify = dependencies.verify || (async (response, ip) => {
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: {'content-type':'application/json'},
      body: JSON.stringify({secret:config.secret, response, remoteip:ip}),
    });
    if (!result.ok) throw fail(503, 'Verification unavailable');
    return result.json();
  });
  const origin = new URL(config.origin);
  const attempts = new Map(), sessions = new Map(), rate = new RateLimit(), redeemed = new Map();
  const sockets = new Set();
  const limits = { sessionMs:20*MINUTE, sessionBytes:100*1024*1024, sessions:5, connections:24, ...config.limits };
  const revoke = session => {
    sessions.delete(session.digest);
    for (const socket of session.sockets) socket.destroy();
    session.sockets.clear();
  };
  const sweep = () => {
    for (const [id, expires] of redeemed) if (expires <= now()) redeemed.delete(id);
    for (const [id, a] of attempts) if (a.expires <= now()) attempts.delete(id);
    for (const s of sessions.values()) if (s.expires <= now()) revoke(s);
  };
  const ipOf = req => {
    // Bind Node to loopback. Caddy REPLACES this header; never trust arbitrary forwarded lists.
    const raw = config.trustProxy ? req.headers['x-patreon-client-ip'] : req.socket.remoteAddress;
    return typeof raw === 'string' && net.isIP(raw) ? raw : 'unknown';
  };
  const getAttempt = (id, req) => {
    const a = attempts.get(id);
    if (!a || a.expires <= now() || !matches(bearer(req), a.pollHash)) throw fail(401, 'Session expired');
    return a;
  };
  const getSession = req => {
    const s = sessions.get(hash(bearer(req)));
    if (!s || s.expires <= now()) throw fail(401, 'Session expired');
    return s;
  };
  const page = (a, nonce) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MHTalk Patreon · Verify access</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10111a;color:#ececf5;font:16px system-ui}main{max-width:460px;margin:24px;padding:36px;border:1px solid #343344;border-radius:20px;background:#191a26}.brand{color:#eac568;font-size:12px;letter-spacing:3px}h1{font-size:30px;line-height:1.2}p{color:#b7b8c9;line-height:1.6}#status{min-height:48px}</style>
<main><b class="brand">MHTALK</b><h1>A quick check.<br>Then Patreon.</h1><p>Verify that you are human to open your temporary private connection.</p><div id="challenge"></div><p id="status" role="status">Loading verification…</p><p>Your password and card details stay inside Patreon’s encrypted connection.</p></main>
<script nonce="${nonce}">window.onTurnstile=()=>turnstile.render('#challenge',{sitekey:${JSON.stringify(config.sitekey)},action:'${ACTION}',cData:'${a.id}',callback:async token=>{document.querySelector('#status').textContent='Verifying…';try{const r=await fetch('/v1/verify/${a.id}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});document.querySelector('#status').textContent=r.ok?'Verified. Return to MHTalk Patreon.':'Verification failed or expired. Close this window and try again.'}catch{document.querySelector('#status').textContent='Connection failed. Close this window and try again.'}},'error-callback':()=>{document.querySelector('#status').textContent='Verification could not load. Check your connection.'},'expired-callback':()=>{document.querySelector('#status').textContent='Verification expired. Please try again.'}});</script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstile&render=explicit" async defer></script></html>`;
  const server = http.createServer({maxHeaderSize:8192}, async (req, res) => {
    res.setHeader('cache-control','no-store'); res.setHeader('referrer-policy','no-referrer');
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=(), usb=()');
    try {
      sweep(); const url = new URL(req.url, origin); const ip = ipOf(req);
      if (!rate.take(`http:${ip}`, 300, MINUTE, now())) throw fail(429, 'Too many requests');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, {ok:true, service:'mhtalk-patreon-relay', protocol:1, checkout:config.checkout === true});
      if (req.method === 'POST' && url.pathname === '/v1/attempts') {
        if (!rate.take(`start:${ip}`, 12, 10*MINUTE, now())) throw fail(429, 'Please wait before trying again');
        const data = await body(req);
        const claim = verifyAccess(data.accessToken, config.accessSecret, origin.origin, now());
        if (!claim || redeemed.has(claim.jti)) throw fail(403, 'Sign in to MHTalk and start a new connection');
        if (redeemed.size >= 10000) throw fail(503, 'Connection service is busy');
        const account = { hash: claim.sub, expires: now()+limits.sessionMs+5*MINUTE };
        if (!rate.take(`account:${account.hash}`, 3, 10*MINUTE, now())) throw fail(429, 'Please try again in ten minutes');
        if ([...attempts.values()].some(a => a.account === account.hash) || [...sessions.values()].some(s => s.account === account.hash)) throw fail(409, 'This account already has an open session');
        if (attempts.size + sessions.size >= limits.sessions) throw fail(503, 'All connections are busy');
        redeemed.set(claim.jti, claim.exp);
        const id = token(), pollToken = token();
        attempts.set(id, {id, pollHash:hash(pollToken), account:account.hash, accountExpires:account.expires, expires:now()+5*MINUTE, verified:false, verifying:false});
        return json(res, 201, {id, pollToken, verificationUrl:`${origin.origin}/verify/${id}`});
      }
      const pageId = /^\/verify\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
      if (req.method === 'GET' && pageId) {
        const a = attempts.get(pageId); if (!a) throw fail(404, 'Verification expired');
        const nonce = token();
        res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; style-src 'nonce-${nonce}'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return res.end(page(a, nonce));
      }
      const verifyId = /^\/v1\/verify\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
      if (req.method === 'POST' && verifyId) {
        if (req.headers.origin !== origin.origin) throw fail(403, 'Invalid origin');
        const a = attempts.get(verifyId);
        if (!a || a.verified || a.verifying) throw fail(409, 'Verification already used or expired');
        if (!rate.take(`verify:${verifyId}`, 3, 5*MINUTE, now())) throw fail(429, 'Too many verification attempts');
        const data = await body(req);
        if (typeof data.token !== 'string' || data.token.length > 2048 || !data.token) throw fail(400, 'Invalid verification');
        a.verifying = true;
        try {
          const result = await verify(data.token, ip);
          if (attempts.get(a.id) !== a || a.expires <= now() || result.success !== true
              || result.hostname !== origin.hostname || result.action !== ACTION || result.cdata !== a.id)
            throw fail(403, 'Human verification failed');
          a.verified = true;
        } finally { a.verifying = false; }
        return json(res, 200, {ok:true});
      }
      const attemptId = /^\/v1\/attempts\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
      if (attemptId && req.method === 'DELETE') { getAttempt(attemptId, req); attempts.delete(attemptId); return json(res, 200, {ok:true}); }
      if (attemptId && req.method === 'POST') {
        const a = getAttempt(attemptId, req);
        if (!a.verified) return json(res, 202, {status:'pending'});
        const accessToken = token(), digest = hash(accessToken);
        const expires = Math.min(now()+limits.sessionMs, a.accountExpires);
        sessions.set(digest, {digest, account:a.account, expires, used:0, pending:0, sockets:new Set()});
        attempts.delete(attemptId); // Atomic one-time redemption, before response.
        return json(res, 200, {accessToken, expiresAt:expires, maxBytes:limits.sessionBytes, checkout:config.checkout === true});
      }
      if (req.method === 'DELETE' && url.pathname === '/v1/session') { revoke(getSession(req)); return json(res,200,{ok:true}); }
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, {'content-type':'text/plain'}); return res.end('MHTalk Patreon relay. Access requires a signed-in MHTalk account and human verification.'); }
      throw fail(404,'Not found');
    } catch (error) { if (!res.headersSent) json(res, error.status || 503, {error:error.status ? error.message : 'Relay temporarily unavailable'}); else res.end(); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close',()=>sockets.delete(socket)); });
  const wsServer = new WebSocketServer({noServer:true, maxPayload:64*1024, perMessageDeflate:false});
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    let session, remote, reserved = false;
    try {
      sweep();
      if (!rate.take(`ws:${ipOf(req)}`, 180, MINUTE, now())) throw fail(429,'Too many connections');
      const url = new URL(req.url, origin);
      if (url.pathname !== '/v1/tunnel' || req.headers.origin) throw fail(403,'Native client required');
      session = getSession(req);
      const host = url.searchParams.get('host');
      if (url.searchParams.get('port') !== '443' || !allowedHost(host, config.hosts || defaultHosts)) throw fail(403,'Destination not allowed');
      if (session.sockets.size + session.pending >= limits.connections || session.used >= limits.sessionBytes) throw fail(429,'Session limit reached');
      session.pending++; reserved = true;
      remote = await dial(host);
      if (!sessions.has(session.digest) || session.expires <= now() || socket.destroyed) throw fail(401,'Session expired');
      session.pending--; reserved = false;
      session.sockets.add(remote);
      wsServer.handleUpgrade(req, socket, head, ws => {
        const stream = createWebSocketStream(ws, {highWaterMark:64*1024});
        const meter = () => new Transform({ transform(chunk, _encoding, cb) {
          if (!sessions.has(session.digest) || session.expires <= now() || session.used + chunk.length > limits.sessionBytes || !config.budget.take(chunk.length, now())) {
            revoke(session); return cb(new Error('Session quota exhausted'));
          }
          session.used += chunk.length; cb(null, chunk);
        }});
        const upload = meter(), download = meter();
        const close = () => { session.sockets.delete(remote); remote.destroy(); stream.destroy(); ws.terminate(); upload.destroy(); download.destroy(); };
        for (const part of [stream, remote, upload, download]) part.once('error', close);
        remote.once('close', close); stream.once('close', close);
        stream.pipe(upload).pipe(remote).pipe(download).pipe(stream);
      });
    } catch (error) {
      if (reserved) session.pending--;
      remote?.destroy(); if (remote) session?.sockets.delete(remote);
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${error.status || 502} Relay unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  const timer = setInterval(sweep, 1000); timer.unref();
  const close = async () => {
    clearInterval(timer); for (const s of sessions.values()) revoke(s);
    for (const socket of sockets) socket.destroy();
    wsServer.close(); await new Promise(resolve => server.close(resolve));
  };
  return {server, close};
}
