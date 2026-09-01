import assert from "node:assert/strict";
import {
  CloudflareRtcUsage,
  cloudflareRtcDisableAtPercent,
  cloudflareRtcTelemetryMaxAgeMs,
  evaluateCloudflareRtcUsageHealth,
} from "../worker/src/cloudflareRtc";

const now = Date.parse("2026-08-29T12:00:00.000Z");
const fresh = (usedPercent: number, disabled = false) => ({
  usedPercent,
  disabled,
  updatedAt: new Date(now - 60_000).toISOString(),
});

assert.equal(evaluateCloudflareRtcUsageHealth(null, now).allowed, false);
assert.equal(evaluateCloudflareRtcUsageHealth({
  usedPercent: 1,
  updatedAt: new Date(now - cloudflareRtcTelemetryMaxAgeMs - 1).toISOString(),
}, now).allowed, false);
assert.equal(evaluateCloudflareRtcUsageHealth({ usedPercent: "invalid", updatedAt: new Date(now).toISOString() }, now).allowed, false);
assert.equal(evaluateCloudflareRtcUsageHealth(fresh(1, true), now).allowed, false);
assert.equal(evaluateCloudflareRtcUsageHealth(fresh(cloudflareRtcDisableAtPercent - 0.01), now).allowed, true);
assert.equal(evaluateCloudflareRtcUsageHealth(fresh(cloudflareRtcDisableAtPercent), now).allowed, false);

const durableValues = new Map<string, unknown>();
let kvWrites = 0;
const usageState = {
  storage: {
    async get<T>(key: string) { return durableValues.get(key) as T | undefined; },
    async put(key: string, value: unknown) { durableValues.set(key, value); },
  },
  async blockConcurrencyWhile<T>(callback: () => Promise<T>) { return callback(); },
} as unknown as DurableObjectState;
const usage = new CloudflareRtcUsage(usageState, {
  PRIVATE_ROOMS: {
    async get() { return null; },
    async put() { kvWrites += 1; },
  } as unknown as KVNamespace,
} as never);
assert.equal((await usage.fetch(new Request("https://internal/usage/add", {
  method: "POST",
  body: JSON.stringify({ bytes: 1_000 }),
}))).status, 200);
assert.equal(kvWrites, 0, "per-room accounting must not spend a KV write");
assert.equal((await usage.fetch(new Request("https://internal/usage/refresh", { method: "POST" }))).status, 200);
assert.equal(kvWrites, 1, "scheduled accounting refresh writes one guarded KV record");

console.log("Cloudflare Realtime usage guard tests passed: 9");
