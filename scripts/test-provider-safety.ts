import assert from "node:assert/strict";
import { targetRtcProviders } from "../worker/src/rtcProviderCatalog";
import {
  databaseProviderSafetyPolicies,
  jaasMonthlyActiveUserLimit,
  jaasMonthlyCredentialLimit,
  routingThresholds,
  validateProviderSafetyPolicies,
} from "../worker/src/providerSafety";

assert.equal(validateProviderSafetyPolicies(), true);
assert.equal(jaasMonthlyCredentialLimit, 19);
assert.equal(jaasMonthlyActiveUserLimit, 25);
assert.ok(jaasMonthlyCredentialLimit / jaasMonthlyActiveUserLimit < 0.8);

for (const provider of targetRtcProviders) {
  if (provider === "mirotalk") continue;
  const policy = databaseProviderSafetyPolicies[provider];
  assert.ok(policy, `${provider} must have a durable safety policy`);
  assert.ok(policy.stop_percent < 80, `${provider} must stop below 80%`);
  assert.equal(
    policy.stop_percent,
    routingThresholds(provider).disableAt,
    `${provider} database and routing cutoffs must match`,
  );
}

assert.equal(databaseProviderSafetyPolicies["cloudflare-realtime"]?.stop_percent, 60);
assert.equal(databaseProviderSafetyPolicies.whereby?.stop_percent, 75);
assert.equal(databaseProviderSafetyPolicies.videosdk?.fail_closed_on_stale, true);

console.log("Provider safety tests passed: every vendor route stops below 80%");
