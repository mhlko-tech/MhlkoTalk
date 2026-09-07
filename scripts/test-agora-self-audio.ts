import assert from "node:assert/strict";
import type { IAgoraRTC } from "agora-rtc-sdk-ng";
import { AgoraRtcSession } from "../src/services/agoraRtcSession";
import type { RoomConnectionCredentials } from "../src/services/rtcAdapterRegistry";
import { screenAudioConstraints } from "../src/core/screenAudio";

const captured = screenAudioConstraints();
assert.equal(captured.restrictOwnAudio, true, "Exclude call playback from screen audio");
assert.equal(captured.echoCancellation, false);
assert.equal(captured.noiseSuppression, false);
assert.equal(captured.autoGainControl, false);

const listeners = new Map<string, (...args: any[]) => any>();
const subscriptions: string[] = [];
const playback: string[] = [];
const remoteUsers = ["me", "me:screen", "friend", "friend:screen"].map((uid) => ({
  uid, hasAudio: true, hasVideo: true,
  audioTrack: undefined as undefined | { getMediaStreamTrack: () => object },
  videoTrack: undefined as undefined | object,
}));
const client = {
  remoteUsers,
  on(event: string, callback: (...args: any[]) => any) { listeners.set(event, callback); },
  async join() {},
  async leave() {},
  enableAudioVolumeIndicator() {},
  async setRemoteVideoStreamType() {},
  async subscribe(user: typeof remoteUsers[number], kind: string) {
    subscriptions.push(`${user.uid}/${kind}`);
    if (kind === "audio") user.audioTrack = { getMediaStreamTrack: () => ({}) };
    if (kind === "video") user.videoTrack = {};
  },
};
const credentials = {
  routing: { rtc: { clientKey: "test-app" } }, identity: "me", roomName: "test-room", token: "test-token",
} as RoomConnectionCredentials;
const session = new AgoraRtcSession({
  onParticipants() {}, onConnectionState() {}, onCustomEvent() {},
  onAudio(identity, source, stream) { if (stream) playback.push(`${identity}/${source}`); },
}, async () => ({ createClient: () => client }) as unknown as IAgoraRTC);

const originalMediaStream = globalThis.MediaStream;
globalThis.MediaStream = class { constructor(public tracks: unknown[]) {} } as unknown as typeof MediaStream;
try {
  await session.connect(credentials, false, true, async () => credentials);
  const publish = listeners.get("user-published")!;
  await publish(remoteUsers[0], "audio");
  await publish(remoteUsers[1], "audio");
  assert.deepEqual(subscriptions, [], "Never subscribe to our voice or screen identity");
  assert.equal(await session.watch("me", "screen", "high"), false);
  assert.deepEqual(subscriptions, [], "Watching our own screen must not enter remote playback");

  await publish(remoteUsers[2], "audio");
  assert.deepEqual(playback, ["friend/voice"], "The friend's microphone remains audible");
  await publish(remoteUsers[3], "audio");
  assert.deepEqual(playback, ["friend/voice"], "Unwatched streams remain silent");
  assert.equal(await session.watch("friend", "screen", "high"), true);
  assert.deepEqual(playback, ["friend/voice", "friend/screen"], "Watching still enables the friend's stream audio");
  assert.equal(session.participants.length, 1);
  assert.equal(session.participants[0].userId, "friend");
} finally {
  await session.disconnect();
  globalThis.MediaStream = originalMediaStream;
}

console.log("Screen capture excludes call audio; local voice/screen identities never enter remote playback");
