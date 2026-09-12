import assert from "node:assert/strict";
import { describeProviderStatus, type ProviderStatusPayload } from "../src/core/providerStatus";

const payload: ProviderStatusPayload = {
  rtc: [{ provider: "agora", ready: true, state: "healthy", usedPercent: 0 }],
  thresholds: { default: { warningPercent: 60, stopNewRoomsPercent: 70, disablePercent: 75 } },
};
assert.equal(describeProviderStatus("agora", "connected", payload, true).tone, "good");
payload.rtc[0].usedPercent = 60;
assert.equal(describeProviderStatus("agora", "connected", payload, true).tone, "warning");
payload.rtc[0].usedPercent = 70;
assert.equal(describeProviderStatus("agora", "connected", payload, true).tone, "critical");
assert.equal(describeProviderStatus("agora", "connected", payload, true).remaining, 6);
assert.equal(describeProviderStatus("agora", "connected", payload, false).tone, "unknown");
assert.equal(describeProviderStatus("agora", "failed", payload, true).label, "الاتصال متعذّر");
assert.equal(describeProviderStatus(null, "idle", payload, true).remaining, null);
payload.rtc[0].usedPercent = null;
assert.equal(describeProviderStatus("agora", "connected", payload, true).tone, "unknown");
payload.rtc = [{ provider: "cloudflare-realtime", ready: true, state: "healthy", usedPercent: 45 }];
payload.thresholds["cloudflare-realtime"] = { warningPercent: 45, stopNewRoomsPercent: 55, disablePercent: 60 };
assert.equal(describeProviderStatus("cloudflare-realtime", "connected", payload, true).tone, "warning");
assert.equal(describeProviderStatus("cloudflare-realtime", "connected", payload, true).remaining, 25);
assert.equal(describeProviderStatus("livekit", "connected", payload, true).tone, "unknown");
console.log("Provider indicator tests passed: actual provider, all thresholds, stale/missing status, failed connection");
