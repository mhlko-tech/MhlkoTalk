const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);
const RESERVED = new Set([
  'Alt+F4',
  'Ctrl+Alt+Delete',
  'Meta+KeyL',
  'Meta+KeyD',
  'Meta+KeyR',
  'Meta+KeyE'
]);

export function validateHotkeyCombination(combo: string): string | null {
  if (!combo) return null;
  const parts = combo.split('+').filter(Boolean);
  const key = parts[parts.length - 1] || '';
  const modifiers = parts.slice(0, -1);
  if (!key || MODIFIERS.has(key) || modifiers.length === 0) return 'A shortcut must include a modifier and a non-modifier key.';
  if (modifiers.some((part) => !MODIFIERS.has(part))) return 'The shortcut contains an unsupported modifier.';
  if (new Set(modifiers).size !== modifiers.length) return 'The shortcut contains a duplicate modifier.';
  if (RESERVED.has(combo)) return 'This shortcut is reserved by Windows or the application shell.';
  return null;
}

export function validateHotkeyMap(hotkeys: Record<string, string>): string | null {
  const seen = new Map<string, string>();
  for (const [action, combo] of Object.entries(hotkeys)) {
    const error = validateHotkeyCombination(combo);
    if (error) return `${action}: ${error}`;
    if (!combo) continue;
    const previous = seen.get(combo);
    if (previous) return `${action}: shortcut conflicts with ${previous}.`;
    seen.set(combo, action);
  }
  return null;
}
