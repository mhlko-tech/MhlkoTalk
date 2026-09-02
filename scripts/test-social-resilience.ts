import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  signPresenceTicket,
  signSocialInvite,
  verifyPresenceTicket,
  verifySocialInvite,
} from "../worker/src/socialTokens";

const secret = "test-only-social-signing-secret";
const now = 2_000_000_000;

const presence = await signPresenceTicket("user-a", secret, now);
assert.deepEqual(await verifyPresenceTicket(presence, secret, now), {
  userId: "user-a",
  expiresAt: now + 60,
});
assert.equal(await verifyPresenceTicket(presence, secret, now + 61), null);
assert.equal(await verifyPresenceTicket(`${presence}x`, secret, now), null);

const invite = await signSocialInvite({
  senderId: "user-a",
  targetId: "user-b",
  roomName: "Private-room",
  inviteCode: "MHTALK-ABCDE",
  createdAt: new Date(now * 1_000).toISOString(),
}, secret, now);
const verifiedInvite = await verifySocialInvite(invite, secret, now);
assert.equal(verifiedInvite?.targetId, "user-b");
assert.equal(verifiedInvite?.inviteCode, "MHTALK-ABCDE");
assert.equal(await verifySocialInvite(invite, secret, now + 601), null);
assert.equal(await verifySocialInvite(invite, "wrong-secret", now), null);

const workerSource = readFileSync(new URL("../worker/src/index.ts", import.meta.url), "utf8");
assert.doesNotMatch(workerSource, /PRIVATE_ROOMS\.put\(`presence-ticket:/);
assert.doesNotMatch(workerSource, /PRIVATE_ROOMS\.put\(`social-invite:/);

console.log("Stateless presence and social invitation tokens verified");
