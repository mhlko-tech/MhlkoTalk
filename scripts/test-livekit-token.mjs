import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createLiveKitJoinToken, normalizeLiveKitUrl } from '../worker/src/livekitToken.ts';

function decodeBase64Url(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const secret = 'test-secret-that-is-long-enough';
const token = await createLiveKitJoinToken('test-key', secret, {
  room: 'MHLKO-TEST_ROOM',
  identity: 'peer_123',
  name: 'Test User',
  role: 'moderator'
}, 1_800_000_000);

const [headerPart, payloadPart, signaturePart] = token.split('.');
assert.equal(token.split('.').length, 3);
assert.deepEqual(JSON.parse(decodeBase64Url(headerPart)), { alg: 'HS256', typ: 'JWT' });
const payload = JSON.parse(decodeBase64Url(payloadPart));
assert.equal(payload.iss, 'test-key');
assert.equal(payload.sub, 'peer_123');
assert.equal(payload.exp, 1_800_000_300);
assert.equal(payload.video.room, 'MHLKO-TEST_ROOM');
assert.equal(payload.video.roomJoin, true);
assert.equal(payload.video.canPublishData, false);
assert.deepEqual(JSON.parse(payload.metadata), { role: 'moderator' });

const expectedSignature = createHmac('sha256', secret)
  .update(`${headerPart}.${payloadPart}`)
  .digest();
assert.equal(decodeBase64Url(signaturePart).toString('hex'), expectedSignature.toString('hex'));
assert.equal(normalizeLiveKitUrl('wss://example.livekit.cloud/'), 'wss://example.livekit.cloud');
assert.equal(normalizeLiveKitUrl('https://example.livekit.cloud/'), 'wss://example.livekit.cloud');
assert.throws(() => normalizeLiveKitUrl('ws://insecure.example.com'));

console.log('LiveKit token contract tests passed.');
