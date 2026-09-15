import assert from "node:assert/strict";
import { describeProviderStatus, serverDisplayName, publicConnectionMessage, type ProviderStatusPayload } from "../src/core/providerStatus";

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
assert.equal(describeProviderStatus("agora", "failed", payload, true).label, "Connection unavailable");
assert.equal(describeProviderStatus(null, "idle", payload, true).remaining, null);
payload.rtc[0].usedPercent = null;
assert.equal(describeProviderStatus("agora", "connected", payload, true).tone, "unknown");
payload.rtc = [{ provider: "cloudflare-realtime", ready: true, state: "healthy", usedPercent: 45 }];
payload.thresholds["cloudflare-realtime"] = { warningPercent: 45, stopNewRoomsPercent: 55, disablePercent: 60 };
assert.equal(describeProviderStatus("cloudflare-realtime", "connected", payload, true).tone, "warning");
assert.equal(describeProviderStatus("cloudflare-realtime", "connected", payload, true).remaining, 25);
assert.equal(describeProviderStatus("livekit", "connected", payload, true).tone, "unknown");
payload.rtc = [{ provider: "livekit", ready: true, state: "draining", usedPercent: 73.7 }];
payload.thresholds.livekit = { warningPercent: 60, stopNewRoomsPercent: 90, disablePercent: 90 };
assert.equal(describeProviderStatus("livekit", "connected", payload, true).tone, "warning");
assert.equal(describeProviderStatus("livekit", "connected", payload, true).remaining, 18);
payload.livekitPool = [{ serverId: 1, ready: true, usedPercent: 73.7 }, { serverId: 2, ready: true, usedPercent: 0.2 }];
payload.rtc[0].usedPercent = 0.2;
assert.equal(describeProviderStatus("livekit", "connected", payload, true, 1).remaining, 18, "show the connected account, not the least-used pool member");
assert.equal(describeProviderStatus("livekit", "connected", payload, true, 2).remaining, 99);
assert.equal(serverDisplayName(2), "Server 2");
assert.equal(serverDisplayName(null), "Server");
assert.equal(publicConnectionMessage("The agora connection failed: CAN_NOT_GET_GATEWAY_SERVER"), "Could not connect to the server. Please try joining again.");
assert.equal(publicConnectionMessage("Sign in is required"), "Sign in is required");
console.log("Provider indicator tests passed: actual provider, all thresholds, stale/missing status, failed connection");
