import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, main, boundary] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/AppErrorBoundary.tsx', import.meta.url), 'utf8')
]);

assert.match(main, /installGlobalDiagnostics\(\)/);
assert.match(main, /<AppErrorBoundary>/);
assert.match(boundary, /componentDidCatch/);
assert.match(boundary, /window\.location\.reload\(\)/);
for (const command of ['apply-settings', 'toggle-screen-recorder', 'leave-room', 'send-chat', 'clear-chat', 'wipe-data']) {
  assert.ok(app.includes(`runGuardedCommand('${command}'`), `${command} must reject concurrent execution`);
}

console.log('Crash recovery and guarded command checks passed.');
