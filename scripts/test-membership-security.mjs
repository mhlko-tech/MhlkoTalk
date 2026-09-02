import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker/src/index.ts", import.meta.url), "utf8");
const workerConfig = await readFile(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../supabase/migrations/202609020002_membership_badge_tiers.sql", import.meta.url),
  "utf8",
);

const oauthPage = worker.slice(
  worker.indexOf("const oauthCompletePage"),
  worker.indexOf("const configured", worker.indexOf("const oauthCompletePage")),
);
assert.match(oauthPage, /\["code", "error", "error_code", "error_description"\]/);
assert.doesNotMatch(oauthPage, /["']access_token["']/);
assert.doesNotMatch(oauthPage, /["']refresh_token["']/);
assert.match(oauthPage, /content-security-policy/i);
assert.match(oauthPage, /referrer-policy/i);

assert.match(worker, /path === "\/social\/badges"/);
assert.match(worker, /body\.ids\.length > 50/);
assert.match(worker, /rateLimited\(request, env, "profile-badges"/);
assert.match(worker, /subscriptionFor\(profile\)\.tier/);
assert.match(worker, /!\["plus", "pro", "ultimate", "max_supporter"\]\.includes\(planId\)/);
assert.match(worker, /membership\.entitlementTier === "patreon_plus" \|\| membership\.entitlementTier === "patreon_pro"/);
assert.match(worker, /LAVA_MEMBERSHIP_BACKEND\?: Fetcher/);
assert.match(worker, /service\.fetch\(new Request\(url/);
assert.match(workerConfig, /binding = "LAVA_MEMBERSHIP_BACKEND"/);
assert.match(workerConfig, /service = "mvdownloader-lava-staging"/);

for (const tier of ["plus", "pro", "ultimate", "max_supporter"]) {
  assert.match(migration, new RegExp(`'${tier}'`));
}

console.log("membership authority and OAuth security tests passed");
