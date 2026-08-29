import assert from 'node:assert/strict';
import { validateHotkeyCombination, validateHotkeyMap } from '../src/core/hotkeyPolicy.ts';

assert.equal(validateHotkeyCombination('Ctrl+Shift+KeyM'), null);
assert.match(validateHotkeyCombination('KeyM') || '', /modifier/);
assert.match(validateHotkeyCombination('Ctrl') || '', /modifier/);
assert.match(validateHotkeyCombination('Alt+F4') || '', /reserved/);
assert.equal(validateHotkeyMap({ one: 'Ctrl+KeyA', two: 'Alt+KeyA' }), null);
assert.match(validateHotkeyMap({ one: 'Ctrl+KeyA', two: 'Ctrl+KeyA' }) || '', /conflicts/);

console.log('Hotkey policy checks passed.');
