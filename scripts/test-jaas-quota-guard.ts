import assert from "node:assert/strict";
import {
  JaasQuotaGuard,
  jaasMonthlyActiveUserLimit,
  jaasMonthlyCredentialLimit,
} from "../worker/src/managedRtcProviders";

const durableValues = new Map<string, unknown>();
let health: Record<string, { usedPercent: number; disabled: boolean; updatedAt: string }> = {};
const state = {
  storage: {
    async get<T>(key: string) { return durableValues.get(key) as T | undefined; },
    async put(key: string, value: unknown) { durableValues.set(key, value); },
  },
} as unknown as DurableObjectState;
const env = {
  PRESENCE: {
    idFromName() { return {} as DurableObjectId; },
    get() {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          if ((init?.method || "GET") === "POST") {
            const updates = (JSON.parse(String(init?.body || "{}")) as {
              updates?: Record<string, { usedPercent?: number; disabled?: boolean }>;
            }).updates || {};
            for (const [provider, update] of Object.entries(updates)) {
              const current = health[provider];
              health[provider] = {
                usedPercent: update.usedPercent ?? current?.usedPercent ?? 0,
                disabled: update.disabled ?? current?.disabled ?? false,
                updatedAt: new Date().toISOString(),
              };
            }
          }
          return Response.json(health);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace,
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
assert.equal(health.jaas?.usedPercent, 76);
assert.equal(health.jaas?.disabled, true);

durableValues.set("quota", { cycle: "2000-01", issued: jaasMonthlyCredentialLimit });
const newCycle = await guard.fetch(new Request("https://internal/reserve", { method: "POST" }));
assert.equal(newCycle.status, 200);
assert.equal((await newCycle.json() as { issued: number }).issued, 1);

console.log("JaaS quota guard tests passed: exact 19-credential monthly ceiling");
