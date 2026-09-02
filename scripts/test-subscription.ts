import assert from "node:assert/strict";
import {
  freeSubscriptionPlan,
  hasMembershipBadge,
  isPaidSubscription,
  limitRecordingDimensions,
  limitMediaQuality,
  resolveSubscriptionPlan,
  subscriptionEntitlements,
} from "../src/core/subscription";
import { parseRoomServiceRouting } from "../src/core/serviceRouting";

assert.equal(freeSubscriptionPlan.entitlements.maxScreenShareQuality, "medium");
assert.equal(subscriptionEntitlements.free.maxAttachmentBytes, 20 * 1024 * 1024);
assert.equal(subscriptionEntitlements.plus.maxAttachmentBytes, 100 * 1024 * 1024);
assert.deepEqual(subscriptionEntitlements.pro, subscriptionEntitlements.plus);
assert.deepEqual(subscriptionEntitlements.ultimate, subscriptionEntitlements.free);
assert.deepEqual(subscriptionEntitlements.max_supporter, subscriptionEntitlements.free);
assert.equal(isPaidSubscription("plus"), true);
assert.equal(isPaidSubscription("pro"), true);
assert.equal(isPaidSubscription("ultimate"), false);
assert.equal(isPaidSubscription("max_supporter"), false);
assert.equal(hasMembershipBadge("ultimate"), true);
assert.equal(limitMediaQuality("high", "medium"), "medium");
assert.equal(limitMediaQuality("low", "medium"), "low");
assert.equal(resolveSubscriptionPlan({ tier: "plus" }).tier, "plus");
assert.equal(resolveSubscriptionPlan({ tier: "pro" }).tier, "pro");
assert.equal(resolveSubscriptionPlan({ tier: "ultimate" }).tier, "ultimate");
assert.equal(resolveSubscriptionPlan({ tier: "max_supporter" }).tier, "max_supporter");
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
      messaging: { provider: "livekit-data" },
      files: { provider: "livekit-stream" },
    },
    subscription: { tier: "plus" },
  },
  "wss://fallback.example",
);
assert.equal(routing.rtc.serverUrl, "wss://rtc.example");
assert.equal(routing.messaging.provider, "livekit-data");
assert.equal(routing.files.provider, "livekit-stream");
assert.equal(routing.subscription.tier, "plus");

const agoraRouting = parseRoomServiceRouting(
  {
    routing: {
      rtc: { provider: "agora", serverUrl: "", clientKey: "public-app-id" },
      messaging: { provider: "agora-data" },
      files: { provider: "supabase-storage" },
    },
  },
  "wss://fallback.example",
);
assert.equal(agoraRouting.rtc.provider, "agora");
assert.equal(agoraRouting.rtc.clientKey, "public-app-id");
assert.equal(agoraRouting.messaging.provider, "agora-data");

assert.throws(() => parseRoomServiceRouting({
  routing: {
    rtc: { provider: "stream" },
    messaging: { provider: "livekit-data" },
    files: { provider: "livekit-stream" },
  },
}, "wss://fallback.example"), /incompatible room service route/);

console.log("subscription and service-routing tests passed");
