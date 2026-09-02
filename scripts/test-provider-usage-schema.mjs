import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../supabase/migrations/202608280003_rtc_provider_usage.sql", import.meta.url),
  "utf8",
) + readFileSync(
  new URL("../supabase/migrations/202608310001_replace_vonage_with_mirotalk.sql", import.meta.url),
  "utf8",
) + readFileSync(
  new URL("../supabase/migrations/202609020001_retire_low_value_rtc_providers.sql", import.meta.url),
  "utf8",
);

const providers = [
  "stream",
  "agora",
  "tencent",
  "cloudflare-realtime",
  "livekit",
  "whereby",
  "jaas",
  "mirotalk",
];

for (const provider of providers) {
  assert.match(sql, new RegExp(`'${provider.replace("-", "\\-")}'`));
}
assert.equal(providers.length, 8);
assert.match(sql, /delete from public\.rtc_provider_policies\s+where provider in \('100ms', 'cometchat', 'videosdk'\)/i);
assert.match(
  sql,
  /\('cloudflare-realtime',\s*4,\s*false,\s*'egress_byte',\s*1000000000000,\s*'monthly',\s*45,\s*50,\s*55,\s*60/,
);
assert.match(sql, /on conflict \(report_id\) do nothing/i);
assert.match(sql, /greatest\(coalesce\(usage\.internal_used, 0\), coalesce\(usage\.provider_used, 0\)\)/i);
assert.match(sql, /revoke all on table public\.rtc_provider_policies from public, anon, authenticated/i);
assert.match(sql, /grant execute on function public\.rtc_provider_health_snapshot\(\) to service_role/i);

console.log("Provider usage schema tests passed: 18");
