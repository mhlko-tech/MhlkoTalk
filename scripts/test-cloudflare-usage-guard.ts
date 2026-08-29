import assert from "node:assert/strict";
import {
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

console.log("Cloudflare Realtime usage guard tests passed: 6");
