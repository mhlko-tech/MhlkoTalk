import assert from "node:assert/strict";
import type { StreamVideoParticipant } from "@stream-io/video-client";
import { StreamRtcSession } from "../src/services/streamRtcSession";

const participant = {
  userId: "friend",
  sessionId: "friend-session",
} as StreamVideoParticipant;
const calls: Array<{ sessionId: string; trackType: string }> = [];
const cleanup = () => undefined;
const fakeCall = {
  state: { remoteParticipants: [participant] },
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

console.log("Stream remote camera/screen binding behavior verified");
