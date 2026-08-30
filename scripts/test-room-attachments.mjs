import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../supabase/migrations/202608300001_room_attachments.sql", import.meta.url),
  "utf8",
);
const worker = readFileSync(new URL("../worker/src/index.ts", import.meta.url), "utf8");

assert.match(migration, /create table if not exists public\.room_attachments/i);
assert.match(migration, /alter table public\.room_attachments enable row level security/i);
assert.match(migration, /revoke all on table public\.room_attachments from public, anon, authenticated/i);
assert.match(migration, /public\s*=\s*false/i);
assert.match(worker, /\/attachments\/upload-ticket/);
assert.match(worker, /\/attachments\/complete/);
assert.match(worker, /\/attachments\/download-ticket/);
assert.match(worker, /\/attachments\/delete/);
assert.match(worker, /cleanupExpiredAttachments/);

console.log("Room attachment contract tests passed: 9");
