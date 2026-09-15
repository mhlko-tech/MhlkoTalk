import test from 'node:test';
import {createHmac,randomBytes} from 'node:crypto';
import {verifyAccess} from '../src/access.mjs';
const secret='test-secret-'.repeat(5);
const sign=(subject,now,audience='https://relay.example')=>{const p=Buffer.from(JSON.stringify({v:1,aud:audience,sub:subject,exp:now+300000,jti:randomBytes(24).toString('hex')})).toString('base64url');return p+'.'+createHmac('sha256',secret).update(p).digest('base64url');};
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import WebSocket, { createWebSocketStream } from 'ws';
import tls from 'node:tls';
import { createRelay, dialPublic } from '../src/relay.mjs';
import { allowedHost, hash, publicAddress, RateLimit, token } from '../src/policy.mjs';
import { DailyBudget } from '../src/budget.mjs';

async function fixture(t, options={}) {
  const invite=token(); let clock=Date.now(); let proof={}; let calls=0;
  const origin='https://relay.example';
  const relay=createRelay({origin,sitekey:'test-only-injected-key',secret:'test-only-injected-secret',accessSecret:secret,budget:{take:()=>true},...options}, {
    now:()=>clock, verify:async()=>{calls++;return proof;}, dial:async()=>new PassThrough(), ...options.dependencies,
  });
  relay.server.listen(0,'127.0.0.1'); await once(relay.server,'listening');
  t.after(()=>relay.close());
  const base=`http://127.0.0.1:${relay.server.address().port}`;
  const request=(path,method='GET',data,auth,extra={})=>fetch(base+path,{method,headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`} : {}),...extra},body:data===undefined?undefined:JSON.stringify(data)});
  const start=async()=>{const r=await request('/v1/attempts','POST',{accessToken:sign(invite,clock)});assert.equal(r.status,201);return r.json();};
  const verify=async a=>{
    proof={success:true,hostname:'relay.example',action:'patreon_access',cdata:a.id};
    return request(`/v1/verify/${a.id}`,'POST',{token:'one-use-turnstile-token'},undefined,{origin});
  };
  const redeem=a=>request(`/v1/attempts/${a.id}`,'POST',undefined,a.pollToken);
  const grant=async()=>{const a=await start();assert.equal((await verify(a)).status,200);return (await redeem(a)).json();};
  return {base,request,start,verify,redeem,grant,invite,authorization:()=>sign(invite,clock),origin,advance:ms=>clock+=ms,setProof:p=>proof=p,calls:()=>calls};
}
test('host and IP policy rejects SSRF, local networks, special ranges and lookalike domains',async()=>{
  for(const address of ['127.0.0.1','0.0.0.0','169.254.169.254','10.0.0.1','172.16.0.1','192.168.1.1','100.64.0.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('1.1.1.1'),true);
  for(const host of ['evil.example','www.patreon.com.evil.example','www.patreon.com.','user@patreon.com','PATREON.COM','localhost','127.0.0.1']) assert.equal(allowedHost(host),false,host);
  assert.equal(allowedHost('www.patreon.com'),true);
  assert.equal(allowedHost('c10.patreonusercontent.com'),true);
  await assert.rejects(dialPublic('localhost'));
});
test('signed account authorization is required and sessions are exclusive',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/v1/attempts','POST',{accessToken:'wrong'})).status,403);
  assert.equal((await f.request('/v1/attempts','POST',{accessToken:hash(f.invite)})).status,403);
  const a=await f.start();
  assert.ok(!JSON.stringify(a).includes(f.invite));
  assert.equal((await f.request(`/v1/attempts/${a.id}`,'POST')).status,401);
  assert.equal((await f.redeem(a)).status,202);
  assert.equal((await f.request('/v1/attempts','POST',{accessToken:f.authorization()})).status,409);
});
test('Patreon login asset CDN opens a tunnel, while lookalikes remain blocked',async t=>{
  const dialed=[];
  const f=await fixture(t,{dependencies:{dial:async host=>{dialed.push(host);return new PassThrough();}}});
  const grant=await f.grant();
  const connect=host=>new WebSocket(f.base.replace('http:','ws:')+`/v1/tunnel?host=${host}&port=443`,{headers:{authorization:`Bearer ${grant.accessToken}`}});
  const assets=connect('c13.patreon.com');
  await once(assets,'open');
  const message=once(assets,'message');assets.send(Buffer.from('login assets'));
  assert.equal((await message)[0].toString(),'login assets');
  for(const host of ['c13.patreon.com.evil.example','evil.c13.patreon.com','c13-patreon.com']) {
    assert.match((await once(connect(host),'error'))[0].message,/403/);
  }
  assert.deepEqual(dialed,['c13.patreon.com']);
  assets.close();
});
test('live Patreon CSS and JavaScript load through the relay with trusted end-to-end TLS',{
  skip:process.env.PATREON_LIVE_ASSETS !== '1', timeout:60000,
},async t=>{
  // Isolated test instance only: real destination dialing, no production invitations
  // or CAPTCHA configuration changes. Paths observed on the public login page.
  const f=await fixture(t,{dependencies:{dial:dialPublic}});
  const grant=await f.grant();
  for(const [path,kind] of [
    ['/assets/_next/static/chunks/1ifjqe2-s5cse.css','css'],
    ['/assets/_next/static/chunks/08k-pqui79ebr.js','javascript'],
  ]) {
    const ws=new WebSocket(f.base.replace('http:','ws:')+'/v1/tunnel?host=c13.patreon.com&port=443',{
      headers:{authorization:`Bearer ${grant.accessToken}`},
    });
    await once(ws,'open');
    const transport=createWebSocketStream(ws);
    const secure=tls.connect({socket:transport,servername:'c13.patreon.com',rejectUnauthorized:true});
    try {
      await once(secure,'secureConnect');
      assert.equal(secure.authorized,true);
      const chunks=[];
      const response=new Promise((resolve,reject)=>{
        secure.on('data',chunk=>chunks.push(chunk));
        secure.once('end',()=>resolve(Buffer.concat(chunks).toString()));
        secure.once('error',reject);
        secure.setTimeout(20000,()=>secure.destroy(new Error('Asset download timed out')));
      });
      secure.write(`GET ${path} HTTP/1.1\r\nHost: c13.patreon.com\r\nConnection: close\r\n\r\n`);
      const result=await response;
      assert.match(result,/^HTTP\/1\.1 200 /);
      const [headers,body]=result.split('\r\n\r\n');
      assert.match(headers,new RegExp(`content-type: [^\\r\\n]*${kind}`,'i'));
      assert.ok(body.length>1000,`${kind} payload must be present`);
    } finally {secure.destroy();transport.destroy();ws.terminate();}
  }
});
test('captcha proof validates hostname, action and attempt binding, never just success',async t=>{
  const f=await fixture(t); const a=await f.start();
  for(const proof of [
    {success:true,hostname:'evil.example',action:'patreon_access',cdata:a.id},
    {success:true,hostname:'relay.example',action:'other',cdata:a.id},
    {success:true,hostname:'relay.example',action:'patreon_access',cdata:'another-attempt'},
  ]) {
    f.setProof(proof);
    assert.equal((await f.request(`/v1/verify/${a.id}`,'POST',{token:'fake'},undefined,{origin:f.origin})).status,403);
  }
  assert.equal((await f.redeem(a)).status,202); assert.equal(f.calls(),3);
});
test('verification rejects cross-origin requests before contacting Turnstile',async t=>{
  const f=await fixture(t); const a=await f.start();
  assert.equal((await f.request(`/v1/verify/${a.id}`,'POST',{token:'fake'},undefined,{origin:'https://evil.example'})).status,403);
  assert.equal(f.calls(),0);
});
test('verified attempt is one-use; racing redemption produces exactly one grant',async t=>{
  const f=await fixture(t);const a=await f.start();
  const page=await f.request(`/verify/${a.id}`); assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await f.verify(a)).status,200);
  assert.equal((await f.verify(a)).status,409);
  const results=await Promise.all([f.redeem(a),f.redeem(a)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);
  const data=await results.find(r=>r.status===200).json();
  assert.equal(data.checkout,false); assert.equal(data.maxBytes,100*1024*1024);
  assert.equal((await f.request('/v1/session','DELETE',undefined,data.accessToken)).status,200);
  assert.equal((await f.request('/v1/session','DELETE',undefined,data.accessToken)).status,401);
});
test('attempt expiration and cancellation invalidate credentials',async t=>{
  const f=await fixture(t);const a=await f.start();
  f.advance(300001); assert.equal((await f.redeem(a)).status,401);
  const b=await f.start();assert.equal((await f.request(`/v1/attempts/${b.id}`,'DELETE',undefined,b.pollToken)).status,200);
  assert.equal((await f.redeem(b)).status,401);
});
test('expired grants and browser-origin tunnel requests are rejected',async t=>{
  const f=await fixture(t,{limits:{sessionMs:500}});const grant=await f.grant();
  const reject=async(headers={})=>{
    const ws=new WebSocket(f.base.replace('http:','ws:')+'/v1/tunnel?host=www.patreon.com&port=443',{headers:{authorization:`Bearer ${grant.accessToken}`,...headers}});
    const [error]=await once(ws,'error');assert.match(error.message,/Unexpected server response/);
  };
  await reject({origin:'https://www.patreon.com'});
  f.advance(501);await reject();
});
test('tunnel relays binary bytes, denies other hosts, and revocation closes it',async t=>{
  const f=await fixture(t);const grant=await f.grant();
  const ws=new WebSocket(f.base.replace('http:','ws:')+'/v1/tunnel?host=www.patreon.com&port=443',{headers:{authorization:`Bearer ${grant.accessToken}`}});
  await once(ws,'open');
  const message=once(ws,'message');ws.send(Buffer.from([0,1,2,255]));
  assert.deepEqual((await message)[0],Buffer.from([0,1,2,255]));
  const denied=new WebSocket(f.base.replace('http:','ws:')+'/v1/tunnel?host=evil.example&port=443',{headers:{authorization:`Bearer ${grant.accessToken}`}});
  assert.match((await once(denied,'error'))[0].message,/403/);
  const closed=once(ws,'close');await f.request('/v1/session','DELETE',undefined,grant.accessToken);await closed;
});
test('byte cap tears down the whole session',async t=>{
  const f=await fixture(t,{limits:{sessionBytes:4}});const grant=await f.grant();
  const ws=new WebSocket(f.base.replace('http:','ws:')+'/v1/tunnel?host=www.patreon.com&port=443',{headers:{authorization:`Bearer ${grant.accessToken}`}});
  await once(ws,'open');const closed=once(ws,'close');ws.send(Buffer.from('too much'));await closed;
  assert.equal((await f.request('/v1/session','DELETE',undefined,grant.accessToken)).status,401);
});
test('verification service failure closes access and does not crash the relay',async t=>{
  const f=await fixture(t,{dependencies:{verify:async()=>{throw Error('failure containing secret');}}});const a=await f.start();
  const r=await f.verify(a);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/containing secret/);
  assert.equal((await f.redeem(a)).status,202);assert.equal((await f.request('/health')).status,200);
});
test('request size and global pending-session count are bounded',async t=>{
  const f=await fixture(t,{limits:{sessions:1}});
  assert.equal((await f.request('/v1/attempts','POST',{accessToken:'x'.repeat(5000)})).status,413);
  await f.start(); assert.equal((await f.request('/health')).status,200);
});
test('invitation rate limit survives cancellation within its window',async t=>{
  const f=await fixture(t);
  for(let n=0;n<3;n++){const a=await f.start();await f.request(`/v1/attempts/${a.id}`,'DELETE',undefined,a.pollToken);}
  assert.equal((await f.request('/v1/attempts','POST',{accessToken:f.authorization()})).status,429);
  f.advance(600001);await f.start();
});
test('daily quota reservations survive restart; corrupted state fails closed',()=>{
  const dir=mkdtempSync(join(tmpdir(),'patreon-budget-'));const file=join(dir,'budget.json');
  try {
    const budget=new DailyBudget(file,512*1024);
    assert.equal(budget.take(1),true);
    const restarted=new DailyBudget(file,512*1024);assert.equal(restarted.take(256*1024),true);assert.equal(restarted.take(1),false);
    writeFileSync(file,'not-json');assert.throws(()=>new DailyBudget(file,512*1024));
  }finally{rmSync(dir,{recursive:true});}
});
test('rate limiter preserves the limit then resets after expiration',()=>{
  const r=new RateLimit();assert.equal(r.take('x',1,100,0),true);assert.equal(r.take('x',1,100,10),false);assert.equal(r.take('x',1,100,101),true);
});

test('signed access rejects tampering, wrong audience, expiry and replay',async t=>{
  const f=await fixture(t); const auth=f.authorization();
  assert.ok(verifyAccess(auth,secret,f.origin));
  assert.equal(verifyAccess(auth,secret,'https://evil.example'),null);
  assert.equal(verifyAccess(auth+'x',secret,f.origin),null);
  assert.equal(verifyAccess(auth,secret+'x',f.origin),null);
  assert.equal(verifyAccess(sign(token(),Date.now()-300001),secret,f.origin),null);
  assert.equal(verifyAccess(sign(token(),Date.now()+60000),secret,f.origin),null);
  assert.equal((await f.request('/v1/attempts','POST',{accessToken:auth})).status,201);
  assert.equal((await f.request('/v1/attempts','POST',{accessToken:auth})).status,403);
});
