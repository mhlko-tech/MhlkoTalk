import { strict as assert } from "node:assert";
import { normalizeProfileAvatar, profileAvatarImageSource } from "../src/core/profileAvatar";

assert.equal(normalizeProfileAvatar("  https://cdn.example.com/a.png  "), "https://cdn.example.com/a.png");
assert.equal(profileAvatarImageSource("https://cdn.example.com/a.png"), "https://cdn.example.com/a.png");
assert.equal(normalizeProfileAvatar("محمد"), "");
assert.equal(normalizeProfileAvatar("م"), "م");
assert.equal(normalizeProfileAvatar("javascript:alert(1)"), "");
assert.equal(normalizeProfileAvatar(`data:image/png;base64,${"A".repeat(12_000)}`), "");

console.log("profile avatar tests passed");
