import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const catalog = readFileSync(new URL('../src/copy/en.ts', import.meta.url), 'utf8');
const models = readFileSync(new URL('../src/types/models.ts', import.meta.url), 'utf8');
const db = readFileSync(new URL('../src/services/db.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tauriConfig = readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');

const failures = [];
const forbiddenArchitecture = [
  [app, /\bAppLanguage\b/, 'AppLanguage is still referenced by the UI.'],
  [app, /LOCALIZED_TEXT|LANGUAGE_OPTIONS|RTL_LANGUAGES|lang-ar|rtl-app/, 'Legacy language or RTL runtime code remains in App.tsx.'],
  [models, /\blanguage\s*:/, 'Language remains part of AppSettings.'],
  [db, /settings\.language|detectInitialLanguage|allowedLanguages/, 'Runtime language persistence remains in db.ts.'],
  [css, /\.lang-ar|\.rtl-app|\[dir=['"]?rtl/, 'Arabic or RTL selectors remain in styles.css.'],
  [html, /<html(?![^>]*\blang="en"[^>]*\bdir="ltr")/s, 'index.html must declare English LTR.'],
  [tauriConfig, /"Arabic"|"Turkish"|"displayLanguageSelector"\s*:\s*true/, 'The Windows installer must be English-only.']
];

for (const [source, pattern, message] of forbiddenArchitecture) {
  if (pattern.test(source)) failures.push(message);
}

const visibleSources = [app, catalog, html];
const nonEnglishScripts = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]|[ğĞıİşŞçÇöÖüÜ]/;
if (visibleSources.some((source) => nonEnglishScripts.test(source))) {
  failures.push('Arabic or Turkish characters remain in visible application sources.');
}

const dictionaryStart = catalog.indexOf('export const ENGLISH_COPY = {');
const dictionaryEndMatch = catalog.slice(dictionaryStart).match(/\n\s*}\s+as const;/);
const dictionaryEnd = dictionaryEndMatch ? dictionaryStart + dictionaryEndMatch.index : -1;
if (dictionaryStart < 0 || dictionaryEnd < 0) {
  failures.push('The English UI catalog was not found.');
} else {
  const block = catalog.slice(dictionaryStart, dictionaryEnd);
  const keys = [...block.matchAll(/^\s+([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
  if (keys.length < 400) failures.push(`English catalog is unexpectedly incomplete (${keys.length} keys).`);
  if (new Set(keys).size !== keys.length) failures.push('English catalog contains duplicate keys.');
}

if (!db.includes("DELETE FROM settings WHERE key = 'language'")) {
  failures.push('Upgraded databases do not remove the obsolete language preference.');
}

if (failures.length) {
  console.error('English-only validation failed:');
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('English-only validation passed.');
