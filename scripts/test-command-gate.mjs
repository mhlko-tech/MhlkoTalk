import assert from 'node:assert/strict';
import { AsyncCommandGate } from '../src/core/asyncCommandGate.ts';

const gate = new AsyncCommandGate();

assert.equal(gate.tryEnter('open-room'), true);
assert.equal(gate.tryEnter('open-room'), false, 'a rapid duplicate command must be rejected');
assert.equal(gate.tryEnter('check-update'), true, 'different commands may run concurrently');
assert.equal(gate.isActive('open-room'), true);

gate.leave('open-room');
assert.equal(gate.tryEnter('open-room'), true, 'a completed command must be allowed again');
gate.clear();

assert.equal(gate.isActive('open-room'), false);
assert.equal(gate.isActive('check-update'), false);
console.log('Async command gate tests passed.');
