import assert from "node:assert/strict";
import {
  availableRecordingFrameRates,
  availableRecordingResolutions,
  recordingDimensions,
  recordingPowerSupport,
} from "../src/core/recordingProfiles";

assert.deepEqual(recordingPowerSupport("h264_nvenc", 8), {
  maxHeight: 2160,
  maxFps: 120,
});
assert.deepEqual(recordingPowerSupport("libx264", 4), {
  maxHeight: 720,
  maxFps: 30,
});
assert.deepEqual(recordingDimensions(1920, 1080, 720), [1280, 720]);
assert.deepEqual(recordingDimensions(1080, 1920, 720), [720, 1280]);
assert.deepEqual(recordingDimensions(2560, 1080, 720), [1280, 720]);

const fullHdOptions = availableRecordingResolutions(1920, 1080, 2160);
assert.deepEqual(
  fullHdOptions.map(({ width, height }) => [width, height]),
  [[854, 480], [1280, 720], [1920, 1080]],
);
assert.equal(fullHdOptions.find((option) => option.height === 720)?.requiresPlus, false);
assert.equal(fullHdOptions.find((option) => option.height === 1080)?.requiresPlus, true);
assert.deepEqual(availableRecordingFrameRates(60), [30, 60]);
assert.deepEqual(availableRecordingFrameRates(120), [30, 60, 120]);

console.log("recording-profile tests passed");
