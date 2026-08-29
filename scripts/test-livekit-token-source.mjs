import assert from 'node:assert/strict';
import { liveKitTokenEndpoint } from '../src/services/media/livekitTokenSource.ts';

assert.equal(
  liveKitTokenEndpoint({
    endpointUrl: 'https://signal.example.com/room/MHLKO-TEST/profiles?old=1',
    token: 'secret',
    generation: 1
  }),
  'https://signal.example.com/room/MHLKO-TEST/media-token'
);
assert.throws(() => liveKitTokenEndpoint({
  endpointUrl: 'https://signal.example.com/not-a-room',
  token: 'secret',
  generation: 1
}));

console.log('LiveKit client token-source tests passed.');
