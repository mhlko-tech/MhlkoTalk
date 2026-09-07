import assert from "node:assert/strict";
import type { IAgoraRTC } from "agora-rtc-sdk-ng";
import { AgoraRtcSession } from "../src/services/agoraRtcSession";
import type { RoomConnectionCredentials } from "../src/services/rtcAdapterRegistry";

function fixture(failure?: "join" | "picker" | "constraints" | "encoder" | "publish", withAudio = true) {
  const publications: unknown[] = [];
  let captureConfig: unknown;
  let encodingConfig: { mediaStreamTrack: unknown; encoderConfig: string } | undefined;
  let appliedConstraints: MediaTrackConstraints | undefined;
  let leaves = 0;
  let videoClosed = 0;
  let capturedAudioClosed = 0;
  let encodedAudioClosed = 0;
  let cloneStopped = 0;
  let ended: (() => void) | undefined;
  const clone = {
    contentHint: "",
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      appliedConstraints = constraints;
      if (failure === "constraints") throw new Error("constraints");
    },
    stop: () => { cloneStopped++; },
  };
  const video = {
    on: (_event: string, callback: () => void) => { ended = callback; },
    close: () => { videoClosed++; },
  };
  const capturedAudio = {
    getMediaStreamTrack: () => ({ clone: () => clone }),
    close: () => { capturedAudioClosed++; },
  };
  const encodedAudio = { close: () => { encodedAudioClosed++; clone.stop(); } };
  const microphone = { close: () => undefined, getTrackLabel: () => "test-microphone" };
  const client = {
    on: () => undefined,
    join: async () => { if (failure === "join") throw new Error("join"); },
    publish: async (tracks: unknown) => {
      if (failure === "publish") throw new Error("publish");
      publications.push(tracks);
    },
    unpublish: async () => undefined,
    leave: async () => { leaves++; },
  };
  const sdk = {
    createClient: () => client,
    createMicrophoneAudioTrack: async () => microphone,
    createScreenVideoTrack: async (_video: unknown, audio: unknown) => {
      captureConfig = audio;
      if (failure === "picker") throw new Error("picker");
      return withAudio ? [video, capturedAudio] : video;
    },
    createCustomAudioTrack: (config: typeof encodingConfig) => {
      if (failure === "encoder") throw new Error("encoder");
      encodingConfig = config;
      return encodedAudio;
    },
  } as unknown as IAgoraRTC;
  const session = new AgoraRtcSession({
    onParticipants: () => undefined,
    onCustomEvent: () => undefined,
    onConnectionState: () => undefined,
    onAudio: () => undefined,
  }, async () => sdk);
  (session as unknown as { credentials: RoomConnectionCredentials }).credentials = {
    routing: { rtc: { clientKey: "test-app" } },
    roomName: "test-room",
    screenToken: "test-screen-token",
    screenIdentity: "test-user:screen",
  } as RoomConnectionCredentials;
  (session as unknown as { clientInstance: unknown }).clientInstance = { ...client, leave: async () => undefined };
  return {
    session, video, encodedAudio, clone, publications,
    end: () => ended?.(),
    get captureConfig() { return captureConfig; },
    get encodingConfig() { return encodingConfig; },
    get constraints() { return appliedConstraints; },
    get cleanup() { return { leaves, videoClosed, capturedAudioClosed, encodedAudioClosed, cloneStopped }; },
  };
}

const normal = fixture();
assert.equal(await normal.session.setScreenShareEnabled(true, "high"), true);
assert.deepEqual(normal.captureConfig, { AEC: false, ANS: false, AGC: false });
assert.equal(normal.constraints?.echoCancellation, false);
assert.equal(normal.constraints?.noiseSuppression, false);
assert.equal(normal.constraints?.autoGainControl, false);
assert.deepEqual(normal.constraints?.channelCount, { ideal: 2 });
assert.deepEqual(normal.constraints?.sampleRate, { ideal: 48_000 });
assert.equal(normal.clone.contentHint, "music");
assert.equal(normal.encodingConfig?.encoderConfig, "high_quality_stereo");
assert.equal(normal.encodingConfig?.mediaStreamTrack, normal.clone);
assert.deepEqual(normal.publications, [[normal.video, normal.encodedAudio]]);
assert.equal(normal.cleanup.capturedAudioClosed, 1);
assert.equal(normal.cleanup.cloneStopped, 0, "Closing the capture wrapper must not stop published audio");
assert.equal(await normal.session.setScreenShareEnabled(true, "high"), true);
assert.equal(normal.publications.length, 1, "Repeated enable must not republish");
await normal.session.setMicrophoneEnabled(true, true);
await normal.session.setNoiseCancellationEnabled(true);
await normal.session.setMicrophoneEnabled(false, true);
assert.equal(normal.cleanup.encodedAudioClosed, 0, "Mic controls must not close screen audio");
assert.equal(await normal.session.setScreenShareEnabled(false, "high"), false);
assert.deepEqual(normal.cleanup, { leaves: 1, videoClosed: 1, capturedAudioClosed: 1, encodedAudioClosed: 1, cloneStopped: 1 });
await normal.session.setScreenShareEnabled(false, "high");
assert.equal(normal.cleanup.leaves, 1, "Repeated disable must be safe");

const silent = fixture(undefined, false);
assert.equal(await silent.session.setScreenShareEnabled(true, "medium"), false);
assert.deepEqual(silent.publications, [[silent.video]], "A source without audio must still share video");
await silent.session.disconnect();
assert.equal(silent.cleanup.videoClosed, 1);
assert.equal(silent.cleanup.leaves, 1);

for (const failure of ["join", "picker", "constraints", "encoder", "publish"] as const) {
  const failed = fixture(failure);
  await assert.rejects(failed.session.setScreenShareEnabled(true, "medium"), new RegExp(failure));
  assert.equal(failed.cleanup.leaves, 1, `${failure}: release the screen client`);
  const captured = !["join", "picker"].includes(failure);
  assert.equal(failed.cleanup.videoClosed, captured ? 1 : 0, `${failure}: release video`);
  assert.equal(failed.cleanup.capturedAudioClosed, captured ? 1 : 0, `${failure}: release capture audio`);
  assert.equal(failed.cleanup.cloneStopped, captured ? 1 : 0, `${failure}: release cloned audio`);
}

const ended = fixture();
await ended.session.setScreenShareEnabled(true, "low");
ended.end();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(ended.cleanup.encodedAudioClosed, 1, "Picker stop must also stop screen audio");
assert.equal(ended.cleanup.leaves, 1);

console.log("Agora unprocessed stereo screen audio, independent microphone, silent sources and failure cleanup verified");
