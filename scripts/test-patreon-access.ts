import assert from 'node:assert/strict';
import {patreonRelayAccess} from '../worker/src/patreonRelayAccess';
// Exercise the real Worker signer against the separately deployed Node verifier.
// @ts-ignore Node relay module has no TypeScript declaration.
import {verifyAccess} from '../patreon-relay/src/access.mjs';
const secret='integration-test-secret-'.repeat(3);
const audience='https://relay.example';
const now=Date.now();
const token=await patreonRelayAccess(secret,'account-1',audience,now);
const claim=verifyAccess(token,secret,audience,now);
assert.ok(claim);
assert.equal(claim.exp,now+300000);
assert.equal(JSON.stringify(claim).includes('account-1'),false);
assert.equal(verifyAccess(token,secret,audience,now+300000),null);
assert.equal(verifyAccess(token,secret,'https://wrong.example',now),null);
const another=verifyAccess(await patreonRelayAccess(secret,'account-1',audience,now),secret,audience,now);
assert.equal(another.sub,claim.sub);
assert.notEqual(another.jti,claim.jti);
assert.notEqual(verifyAccess(await patreonRelayAccess(secret,'account-2',audience,now),secret,audience,now).sub,claim.sub);
await assert.rejects(patreonRelayAccess('', 'account-1',audience));
console.log('Patreon Worker/relay access contract passed');
