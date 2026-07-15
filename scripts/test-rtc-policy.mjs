import assert from 'node:assert/strict';
import { classifyRtcPressure, mediaBudgetFor } from '../src/services/rtcPolicy.ts';

assert.equal(classifyRtcPressure({ rttMs: 80, jitterMs: 8, packetLossPct: 0.5, availableOutgoingKbps: 3000 }), 'normal');
assert.equal(classifyRtcPressure({ rttMs: 280, jitterMs: 35, packetLossPct: 6 }), 'pressure');
assert.equal(classifyRtcPressure({ rttMs: 450, packetLossPct: 12 }), 'severe');
assert.equal(classifyRtcPressure({ eventLoopLagMs: 200 }), 'severe');
const severe = mediaBudgetFor('severe', 8_000_000, 60);
assert.equal(severe.voiceBitrate, 18_000);
assert.ok(severe.screenBitrate <= 700_000);
assert.ok(severe.fileHighWater < 128 * 1024);
const fourPeerNormal = mediaBudgetFor('normal', 5_500_000, 60, 4);
assert.ok(fourPeerNormal.screenBitrate <= 1_375_000);
assert.ok(fourPeerNormal.cameraBitrate <= 160_000);
assert.ok(fourPeerNormal.fileHighWater <= 256 * 1024);
const fourPeerSevere = mediaBudgetFor('severe', 5_500_000, 60, 4);
assert.ok(fourPeerSevere.screenBitrate <= 175_000);
assert.ok(fourPeerSevere.fileChunkDelayMs >= severe.fileChunkDelayMs);
console.log('RTC policy tests passed');
