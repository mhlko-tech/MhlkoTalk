import assert from "node:assert/strict";
import { cropLayout } from "../src/features/profile/ProfileCropDialog";

const landscape = cropLayout({ width: 1600, height: 800 }, 1, 0, 280);
assert.equal(landscape.height, 280);
assert.equal(landscape.width, 560);
assert.equal(landscape.maxX, 140);
assert.equal(landscape.maxY, 0);

const portrait = cropLayout({ width: 800, height: 1600 }, 1, 0, 280);
assert.equal(portrait.width, 280);
assert.equal(portrait.height, 560);
assert.equal(portrait.maxX, 0);
assert.equal(portrait.maxY, 140);

const rotated = cropLayout({ width: 1600, height: 800 }, 1, 90, 280);
assert.equal(rotated.width, 560);
assert.equal(rotated.height, 280);
assert.equal(rotated.maxX, 0);
assert.equal(rotated.maxY, 140);

const zoomed = cropLayout({ width: 800, height: 800 }, 2, 0, 280);
assert.equal(zoomed.width, 560);
assert.equal(zoomed.maxX, 140);

console.log("Profile crop tests passed: 4");
