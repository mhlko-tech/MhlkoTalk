import assert from "node:assert/strict";
import {
  JaasQuotaGuard,
  jaasMonthlyActiveUserLimit,
  jaasMonthlyCredentialLimit,
} from "../worker/src/managedRtcProviders";

const durableValues = new Map<string, unknown>();
const healthValues = new Map<string, string>();
const state = {
  storage: {
    async get<T>(key: string) { return durableValues.get(key) as T | undefined; },
    async put(key: string, value: unknown) { durableValues.set(key, value); },
  },
} as unknown as DurableObjectState;
const env = {
  PRIVATE_ROOMS: {
    async get(key: string) { return healthValues.get(key) ?? null; },
    async put(key: string, value: string) { healthValues.set(key, value); },
  } as unknown as KVNamespace,
};
const guard = new JaasQuotaGuard(state, env);

assert.equal(jaasMonthlyActiveUserLimit, 25);
assert.equal(jaasMonthlyCredentialLimit, 19);
for (let index = 1; index <= jaasMonthlyCredentialLimit; index += 1) {
  const response = await guard.fetch(new Request("https://internal/reserve", { method: "POST" }));
  assert.equal(response.status, 200);
  const result = await response.json() as { allowed: boolean; issued: number };
  assert.equal(result.allowed, true);
  assert.equal(result.issued, index);
}

const blocked = await guard.fetch(new Request("https://internal/reserve", { method: "POST" }));
assert.equal(blocked.status, 429);
assert.equal((await blocked.json() as { allowed: boolean }).allowed, false);
const health = JSON.parse(healthValues.get("routing:health:rtc:jaas") || "{}") as {
  usedPercent?: number;
  disabled?: boolean;
};
assert.equal(health.usedPercent, 76);
assert.equal(health.disabled, true);

durableValues.set("quota", { cycle: "2000-01", issued: jaasMonthlyCredentialLimit });
const newCycle = await guard.fetch(new Request("https://internal/reserve", { method: "POST" }));
assert.equal(newCycle.status, 200);
assert.equal((await newCycle.json() as { issued: number }).issued, 1);

console.log("JaaS quota guard tests passed: exact 19-credential monthly ceiling");
