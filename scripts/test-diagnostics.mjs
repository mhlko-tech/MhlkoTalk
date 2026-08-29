import assert from 'node:assert/strict';
import { appendDiagnostic, clearDiagnostics, loadDiagnostics } from '../src/core/diagnostics.ts';

clearDiagnostics();
const created = appendDiagnostic('simulated failure', 'error');
assert.equal(created.level, 'error');
assert.equal(loadDiagnostics()[0]?.message, 'simulated failure');
clearDiagnostics();
assert.equal(loadDiagnostics().length, 0);

console.log('Diagnostics recovery checks passed.');
