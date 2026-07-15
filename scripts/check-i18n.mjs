import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const allBlock = source.match(/const ALL_APP_LANGUAGES: AppLanguage\[\] = \[([^\]]+)\]/)?.[1] || '';
const visible = source.match(/const LANGUAGE_OPTIONS:[\s\S]*?= \[([\s\S]*?)\];/)?.[1] || '';
const visibleValues = [...visible.matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
const completeValues = [...allBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const missingVisible = visibleValues.filter((value) => !completeValues.includes(value));
if (missingVisible.length) {
  console.error(`Missing complete dictionaries for visible languages: ${missingVisible.join(', ')}`);
  process.exit(1);
}
if (!visibleValues.includes('ar') || !visibleValues.includes('en') || !visibleValues.includes('tr')) {
  console.error('Arabic, English, and Turkish must remain visible.');
  process.exit(1);
}
const expectedLanguages = ['ar', 'en', 'tr'];
if (JSON.stringify(visibleValues) !== JSON.stringify(expectedLanguages) || JSON.stringify(completeValues) !== JSON.stringify(expectedLanguages)) {
  console.error(`Only Arabic, English, and Turkish are supported. Visible=${visibleValues.join(', ')} dictionaries=${completeValues.join(', ')}`);
  process.exit(1);
}
function extractObjectBlock(label) {
  const marker = `const ${label}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${label} not found`);
  const open = source.indexOf('{', start);
  let depth = 1;
  let inString = false;
  let escaped = false;
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === "'") inString = false;
    } else {
      if (ch === "'") inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`${label} block did not close`);
}
const localized = extractObjectBlock('LOCALIZED_TEXT');
function extractLang(lang) {
  const re = new RegExp(`\\n\\s*${lang}:\\s*\\{`);
  const match = localized.match(re);
  if (!match) return '';
  const open = localized.indexOf('{', match.index);
  let depth = 1;
  let inString = false;
  let escaped = false;
  for (let i = open + 1; i < localized.length; i++) {
    const ch = localized[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === "'") inString = false;
    } else {
      if (ch === "'") inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return localized.slice(open + 1, i);
      }
    }
  }
  return '';
}
const englishBlock = extractLang('en');
const englishKeys = [...englishBlock.matchAll(/\n\s*([A-Za-z0-9_]+):\s*'/g)].map((m) => m[1]);
const failures = [];
for (const lang of completeValues) {
  const block = extractLang(lang);
  if (!block) {
    failures.push(`${lang}: missing dictionary`);
    continue;
  }
  const entries = new Map([...block.matchAll(/\n\s*([A-Za-z0-9_]+):\s*'((?:\\'|[^'])*)'/g)].map((m) => [m[1], m[2]]));
  for (const key of englishKeys) {
    if (!entries.has(key)) failures.push(`${lang}: missing ${key}`);
    if (entries.get(key) === key) failures.push(`${lang}: raw key leaked as value for ${key}`);
  }
}
if (failures.length) {
  console.error('i18n validation failed:');
  console.error(failures.slice(0, 80).join('\n'));
  if (failures.length > 80) console.error(`...and ${failures.length - 80} more`);
  process.exit(1);
}
console.log(`i18n validation passed. Languages: ${completeValues.join(', ')}. Keys per language: ${englishKeys.length}`);
