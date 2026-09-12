import assert from "node:assert/strict";
import { decideRoomRoute, updateRoomRouteMember, roomRouteLeaseMs, type RoomRouteRequest } from "../worker/src/roomRouting";

const now = 1_000_000;
const request: RoomRouteRequest = { subject: "one", eligible: ["agora", "livekit"], acceptingNewRooms: ["agora", "livekit"], excluded: [] };
const first = decideRoomRoute(undefined, request, now, "a");
assert.equal(first.selected, "agora");
assert.equal(first.route?.members.one, now + roomRouteLeaseMs);
// A different client preference must not split a room during concurrent joins.
const second = decideRoomRoute(first.route!, { ...request, subject: "two", acceptingNewRooms: ["livekit", "agora"] }, now + 1, "b");
assert.equal(second.selected, "agora");
const blocked = decideRoomRoute(second.route!, { ...request, excluded: ["agora"] }, now + 2, "c");
assert.equal(blocked.locked, true);
assert.equal(blocked.selected, null);
assert.equal(blocked.route?.members.one, undefined);
assert.ok(blocked.route?.members.two);
// Once everyone releases a failed provider, the next join establishes one alternative.
const released = updateRoomRouteMember(blocked.route!, "agora", "two", true, now + 3, "a");
const fallback = decideRoomRoute(released.route, { ...request, excluded: ["agora"] }, now + 4, "d");
assert.equal(fallback.selected, "livekit");
assert.equal(fallback.route?.id, "d");
const follow = decideRoomRoute(fallback.route!, { ...request, subject: "two", excluded: ["agora"] }, now + 5, "e");
assert.equal(follow.selected, "livekit");
assert.equal(follow.route?.id, "d");
// Delayed reports/releases cannot revive a previous transport or remove its replacement.
assert.equal(updateRoomRouteMember(follow.route!, "agora", "one", false, now + 6, "a").accepted, false);
assert.equal(updateRoomRouteMember(follow.route!, "livekit", "one", true, now + 6, "wrong-route").accepted, false);
const refreshed = updateRoomRouteMember(follow.route!, "livekit", "one", false, now + 50_000, "d");
assert.equal(refreshed.route?.members.one, now + 50_000 + roomRouteLeaseMs);
// A dead client's lease expires; a room is not pinned forever.
assert.equal(decideRoomRoute(second.route!, { ...request, excluded: ["agora"] }, now + roomRouteLeaseMs + 2, "f").selected, "livekit");
// Unsupported or unavailable pins block new members instead of silently splitting them.
assert.equal(decideRoomRoute(second.route!, { ...request, subject: "three", eligible: ["livekit"], acceptingNewRooms: ["livekit"] }, now + 10, "g").locked, true);
assert.equal(decideRoomRoute(undefined, { ...request, eligible: [], acceptingNewRooms: [] }, now, "h").selected, null);
assert.equal(decideRoomRoute(undefined, { ...request, acceptingNewRooms: [] }, now, "i").selected, null);
// Preserve pre-upgrade occupied rooms through the existing signed presence ledger.
assert.equal(decideRoomRoute(undefined, { ...request, subject: "new", legacyProvider: "agora", legacyMembers: { old: now + 60_000 }, excluded: ["agora"] }, now, "j").locked, true);
assert.equal(decideRoomRoute(undefined, { ...request, legacyProvider: "agora", legacyMembers: { old: now - 1 }, excluded: ["agora"] }, now, "k").selected, "livekit");
assert.equal(decideRoomRoute(undefined, { ...request, legacyMembers: { old: now + 60_000 } }, now, "l").locked, true);
const pending = decideRoomRoute(undefined, { ...request, connectionAware: true }, now, "pending");
assert.equal(pending.route?.expiresAt, now + 45_000);
assert.equal(decideRoomRoute(pending.route!, { ...request, subject: "other", excluded: ["agora"], connectionAware: true }, now + 45_001, "after-crash").selected, "livekit");
console.log("Room routing tests passed: serialized pins, failover, lease expiry, legacy clients, stale reports");
