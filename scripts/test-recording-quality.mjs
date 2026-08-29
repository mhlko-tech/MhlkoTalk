import assert from 'node:assert/strict';
import { recorderTargetLongEdge, supportedRecorderResolutions } from '../src/core/recordingQuality.ts';

assert.deepEqual(supportedRecorderResolutions(1920, 1080), ['auto', '1080p', '720p', '480p']);
assert.deepEqual(supportedRecorderResolutions(1280, 720), ['auto', '720p', '480p']);
assert.equal(recorderTargetLongEdge('4k', 1920, 1080, 32, false), 1920, 'must never upscale beyond the source');
assert.equal(recorderTargetLongEdge('auto', 3840, 2160, 4, false), 1280);
assert.equal(recorderTargetLongEdge('auto', 3840, 2160, 8, false), 1920);
assert.equal(recorderTargetLongEdge('auto', 3840, 2160, 16, false), 3840);
assert.equal(recorderTargetLongEdge('auto', 3840, 2160, 16, true), 1280);

console.log('Recording quality policy checks passed.');
