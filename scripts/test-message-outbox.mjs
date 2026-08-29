import assert from 'node:assert/strict';
import { BoundedMessageIdCache, outboxRetryDelayMs, pendingOutboxRecipients } from '../src/core/outboxPolicy.ts';

assert.equal(outboxRetryDelayMs(0), 1_000);
assert.equal(outboxRetryDelayMs(3), 8_000);
assert.equal(outboxRetryDelayMs(99), 60_000);

assert.deepEqual(
  pendingOutboxRecipients(['a', 'b', 'b', 'c'], ['b'], ['a', 'b', 'd']),
  ['a']
);

const cache = new BoundedMessageIdCache(2);
assert.equal(cache.remember('one'), false);
assert.equal(cache.remember('one'), true);
assert.equal(cache.remember('two'), false);
assert.equal(cache.remember('three'), false);
assert.equal(cache.remember('one'), false, 'oldest id must be evicted at capacity');
cache.clear();
assert.equal(cache.remember('three'), false);

console.log('Message outbox policy checks passed.');
