import assert from "node:assert/strict";
import type { StreamVideoParticipant } from "@stream-io/video-client";
import { StreamRtcSession } from "../src/services/streamRtcSession";

const participant = {
  userId: "friend",
  sessionId: "friend-session",
} as StreamVideoParticipant;
const calls: Array<{ sessionId: string; trackType: string }> = [];
const cleanup = () => undefined;
const screenActions: string[] = [];
const screenShare = {
  state: { audioEnabled: false },
  setSettings: () => screenActions.push("settings"),
  enableScreenShareAudio: () => {
    screenShare.state.audioEnabled = true;
    screenActions.push("audio-on");
  },
  disableScreenShareAudio: async () => {
    screenShare.state.audioEnabled = false;
    screenActions.push("audio-off");
  },
  enable: async () => screenActions.push("share-on"),
  disable: async () => screenActions.push("share-off"),
};
const fakeCall = {
  state: { remoteParticipants: [participant] },
  screenShare,
  bindVideoElement: (
    _element: HTMLVideoElement,
    sessionId: string,
    trackType: string,
  ) => {
    calls.push({ sessionId, trackType });
    return cleanup;
  },
};
const session = new StreamRtcSession({
  onParticipants: () => undefined,
  onCustomEvent: () => undefined,
  onCallingState: () => undefined,
});
(session as unknown as { callInstance: typeof fakeCall }).callInstance = fakeCall;
const element = {} as HTMLVideoElement;

assert.equal(session.bindParticipantVideoElement(element, "friend", "camera"), cleanup);
assert.equal(session.bindParticipantVideoElement(element, "friend", "screen"), cleanup);
assert.equal(session.bindParticipantVideoElement(element, "missing", "camera"), undefined);
assert.deepEqual(calls, [
  { sessionId: "friend-session", trackType: "videoTrack" },
  { sessionId: "friend-session", trackType: "screenShareTrack" },
]);
assert.equal(await session.setScreenShareEnabled(true, "medium"), true);
assert.equal(await session.setScreenShareEnabled(false, "medium"), false);
assert.deepEqual(screenActions, ["settings", "audio-on", "share-on", "share-off", "audio-off"]);

console.log("Stream remote binding and independent desktop screen-audio behavior verified");
