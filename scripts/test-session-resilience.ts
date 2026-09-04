import assert from "node:assert/strict";
import { isTerminalSessionFailure, sessionRetryDelay, withSessionTimeout } from "../src/services/sessionResilience";

for (const error of [
  new TypeError("Failed to fetch"),
  { status: 0, message: "network timeout" },
  { status: 408, message: "request timeout" },
  { status: 429, message: "rate limited" },
  { status: 503, message: "upstream unavailable" },
]) assert.equal(isTerminalSessionFailure(error), false);

for (const error of [
  { status: 400, message: "Invalid Refresh Token" },
  { status: 401, message: "Session not found" },
  { status: 403, message: "Session revoked" },
]) assert.equal(isTerminalSessionFailure(error), true);

assert.deepEqual([0, 1, 2, 3, 4, 20].map(sessionRetryDelay), [2_000, 5_000, 15_000, 30_000, 60_000, 60_000]);
assert.equal(await withSessionTimeout(Promise.resolve("restored"), 50), "restored");
await assert.rejects(
  withSessionTimeout(new Promise<never>(() => undefined), 10),
  /Secure session restoration timed out/,
);
await assert.rejects(
  withSessionTimeout(new Promise<never>(() => undefined), 10, "Custom timeout"),
  /Custom timeout/,
);
console.log("Session resilience tests passed: 17");
