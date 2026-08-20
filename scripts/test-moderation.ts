import assert from "node:assert/strict";
import {
  POLICY_REPLACEMENT,
  moderateMainMessage,
} from "../src/core/moderation";

const cases = [
  ["كس امك", "** امك"],
  ["f.u.c.k this", "******* this"],
  ["S1KT1R", "******"],
  ["hello class", "hello class"],
  ["مرحبا بالعالم", "مرحبا بالعالم"],
  ["https://example.com/porn/video", POLICY_REPLACEMENT],
] as const;

for (const [input, expected] of cases) {
  assert.equal(moderateMainMessage(input).text, expected, input);
}

console.log(`Moderation tests passed: ${cases.length}`);
