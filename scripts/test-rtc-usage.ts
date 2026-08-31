import assert from "node:assert/strict";
import { monthlyUsageCycle, usageAmount } from "../worker/src/rtcUsage";

assert.deepEqual(monthlyUsageCycle(new Date("2026-12-31T23:59:59.000Z")), {
  start: "2026-12-01T00:00:00.000Z",
  end: "2027-01-01T00:00:00.000Z",
});
assert.equal(usageAmount("stream", 10), 12_000);
assert.equal(usageAmount("stream", 61), 24_000);
assert.equal(usageAmount("agora", 60), 1);
assert.equal(usageAmount("tencent", 61), 2);
assert.equal(usageAmount("whereby", 30), 1);
assert.equal(usageAmount("livekit", 90), 2);
assert.equal(usageAmount("cloudflare-realtime", 60), null);
assert.equal(usageAmount("daily", 60), null);

console.log("RTC usage metering tests passed: 9");
