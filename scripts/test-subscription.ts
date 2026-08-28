import assert from "node:assert/strict";
import {
  freeSubscriptionPlan,
  limitRecordingDimensions,
  limitMediaQuality,
  resolveSubscriptionPlan,
  subscriptionEntitlements,
} from "../src/core/subscription";
import { parseRoomServiceRouting } from "../src/core/serviceRouting";

assert.equal(freeSubscriptionPlan.entitlements.maxScreenShareQuality, "medium");
assert.equal(subscriptionEntitlements.free.maxAttachmentBytes, 20 * 1024 * 1024);
assert.equal(subscriptionEntitlements.plus.maxAttachmentBytes, 100 * 1024 * 1024);
assert.equal(limitMediaQuality("high", "medium"), "medium");
assert.equal(limitMediaQuality("low", "medium"), "low");
assert.equal(resolveSubscriptionPlan({ tier: "plus" }).tier, "plus");
assert.equal(
  resolveSubscriptionPlan({ tier: "plus", expiresAt: "2020-01-01T00:00:00Z" }).tier,
  "free",
);
assert.deepEqual(limitRecordingDimensions(1920, 1080, false), [1280, 720]);
assert.deepEqual(limitRecordingDimensions(1080, 1920, false), [720, 1280]);
assert.deepEqual(limitRecordingDimensions(2560, 1440, true), [2560, 1440]);

const routing = parseRoomServiceRouting(
  {
    routing: {
      rtc: { provider: "livekit", serverUrl: "wss://rtc.example" },
      messaging: { provider: "cloudflare-realtime" },
      files: { provider: "cloudflare-r2" },
    },
    subscription: { tier: "plus" },
  },
  "wss://fallback.example",
);
assert.equal(routing.rtc.serverUrl, "wss://rtc.example");
assert.equal(routing.messaging.provider, "cloudflare-realtime");
assert.equal(routing.files.provider, "cloudflare-r2");
assert.equal(routing.subscription.tier, "plus");

console.log("subscription and service-routing tests passed");
