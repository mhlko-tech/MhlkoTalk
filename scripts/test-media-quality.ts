import assert from "node:assert/strict";
import {
  availableQualities,
  mediaQualityLabels,
} from "../src/core/mediaQuality";

assert.deepEqual(availableQualities("low"), ["low"]);
assert.deepEqual(availableQualities("medium"), ["low", "medium"]);
assert.deepEqual(availableQualities("high"), ["low", "medium", "high"]);
assert.equal(mediaQualityLabels.high, "High · 1080p");

console.log("Media-quality tests passed: 4");
