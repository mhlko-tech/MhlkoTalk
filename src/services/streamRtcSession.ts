import {
  CallingState,
  SfuModels,
  StreamVideoClient,
  type Call,
  type CustomVideoEvent,
  type StreamVideoParticipant,
  type User,
} from "@stream-io/video-client";
import type { MediaQuality, UserProfile } from "../core/types";
import type { RoomConnectionCredentials } from "./rtcAdapterRegistry";

type StreamRtcCallbacks = {
  onParticipants(participants: StreamVideoParticipant[]): void;
  onCustomEvent(event: CustomVideoEvent): void;
  onCallingState(state: CallingState): void;
};

const videoDimensions: Record<MediaQuality, { width: number; height: number }> = {
  low: { width: 640, height: 360 },
  medium: { width: 1280, height: 720 },
  high: { width: 1920, height: 1080 },
};

/**
 * Owns Stream-specific resources without leaking them into the generic adapter
 * registry. MHTalk's existing UI continues to consume provider-neutral
 * snapshots from RoomSession.
 */
export class StreamRtcSession {
  private client: StreamVideoClient | null = null;
  private callInstance: Call | null = null;
  private cleanup: Array<() => void> = [];

  constructor(private readonly callbacks: StreamRtcCallbacks) {}

  get call() {
    return this.callInstance;
  }

  get participants() {
    return this.callInstance?.state.participants ?? [];
  }

  get remoteParticipants() {
    return this.callInstance?.state.remoteParticipants ?? [];
  }

  get localParticipant() {
    return this.callInstance?.state.localParticipant;
  }

  async connect(
    credentials: RoomConnectionCredentials,
    profile: UserProfile,
    microphoneEnabled: boolean,
    refreshToken: () => Promise<string>,
  ) {
    const apiKey = credentials.routing.rtc.clientKey;
    if (!apiKey) throw new Error("Stream client key is missing");
    const userId = userIdFromStreamToken(credentials.token);
    const user: User = {
      id: userId,
      name: profile.name,
      ...(safeRemoteImage(profile.avatar)
        ? { image: safeRemoteImage(profile.avatar) }
        : {}),
    };
    const client = new StreamVideoClient({
      apiKey,
      user,
      token: credentials.token,
      tokenProvider: refreshToken,
      options: {
        maxConnectUserRetries: 3,
        onConnectUserError: () => undefined,
      },
    });
    const call = client.call("default", credentials.roomName);
    this.client = client;
    this.callInstance = call;

    const participantSubscription = call.state.participants$.subscribe((participants) => {
      this.callbacks.onParticipants(participants);
    });
    const callingStateSubscription = call.state.callingState$.subscribe((state) => {
      this.callbacks.onCallingState(state);
    });
    this.cleanup.push(
      () => participantSubscription.unsubscribe(),
      () => callingStateSubscription.unsubscribe(),
      call.on("custom", (event) => this.callbacks.onCustomEvent(event)),
    );

    call.camera.setDefaultConstraints({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    });
    call.microphone.setDefaultConstraints(voiceCaptureConstraints(true));
    await call.camera.disable(true);
    if (microphoneEnabled) await call.microphone.enable();
    else await call.microphone.disable(true);
    await call.join({ create: true });
  }

  async disconnect() {
    const call = this.callInstance;
    const client = this.client;
    this.callInstance = null;
    this.client = null;
    this.cleanup.splice(0).forEach((dispose) => dispose());
    await call?.leave().catch(() => undefined);
    await client?.disconnectUser().catch(() => undefined);
  }

  async setMicrophoneEnabled(enabled: boolean) {
    if (enabled) await this.callInstance?.microphone.enable();
    else await this.callInstance?.microphone.disable(true);
  }

  async setNoiseCancellationEnabled(enabled: boolean) {
    const call = this.callInstance;
    if (!call) return;
    call.microphone.setDefaultConstraints(voiceCaptureConstraints(enabled));
    if (!call.microphone.enabled) return;
    await call.microphone.disable(true);
    await call.microphone.enable();
  }

  async setCameraEnabled(enabled: boolean, maximum: MediaQuality) {
    const call = this.callInstance;
    if (!call) return;
    const resolution = videoDimensions[maximum];
    call.camera.setDefaultConstraints({
      width: { ideal: resolution.width, max: resolution.width },
      height: { ideal: resolution.height, max: resolution.height },
      frameRate: { ideal: 30, max: 30 },
    });
    if (enabled) await call.camera.enable();
    else await call.camera.disable(true);
  }

  async setScreenShareEnabled(enabled: boolean, quality: MediaQuality) {
    const call = this.callInstance;
    if (!call) return false;
    if (!enabled) {
      await call.screenShare.disable(true);
      await call.screenShare.disableScreenShareAudio();
      return false;
    }
    const bitrate = quality === "high" ? 4_000_000 : quality === "medium" ? 2_500_000 : 1_000_000;
    call.screenShare.setSettings({
      maxFramerate: 15,
      maxBitrate: bitrate,
      contentHint: "detail",
    });
    // Stream keeps screen audio disabled unless it is requested before the
    // display picker opens. This is independent from call.microphone.
    call.screenShare.enableScreenShareAudio();
    await call.screenShare.enable();
    return call.screenShare.state.audioEnabled;
  }

  async selectDevice(kind: MediaDeviceKind, deviceId: string) {
    const call = this.callInstance;
    if (!call) return;
    if (kind === "audioinput") await call.microphone.select(deviceId || undefined);
    if (kind === "audiooutput") await call.speaker.select(deviceId || "default");
    if (kind === "videoinput") await call.camera.select(deviceId || undefined);
  }

  setParticipantVideoQuality(identity: string, quality?: MediaQuality) {
    const call = this.callInstance;
    const participant = this.remoteParticipants.find((item) => item.userId === identity);
    if (!call || !participant) return;
    call.setPreferredIncomingVideoResolution(
      quality ? videoDimensions[quality] : undefined,
      [participant.sessionId],
    );
  }

  bindParticipantVideoElement(
    element: HTMLVideoElement,
    identity: string,
    source: "camera" | "screen",
  ) {
    const call = this.callInstance;
    const participant = this.participant(identity);
    if (!call || !participant) return;
    return call.bindVideoElement(
      element,
      participant.sessionId,
      source === "camera" ? "videoTrack" : "screenShareTrack",
    );
  }

  async sendCustomEvent(payload: Record<string, unknown>) {
    await this.callInstance?.sendCustomEvent(payload);
  }

  participant(identity: string) {
    return this.remoteParticipants.find((item) => item.userId === identity);
  }
}

function voiceCaptureConstraints(noiseCancellationEnabled: boolean): MediaTrackConstraints {
  return {
    echoCancellation: noiseCancellationEnabled,
    noiseSuppression: noiseCancellationEnabled,
    autoGainControl: noiseCancellationEnabled,
    channelCount: 1,
  };
}

function userIdFromStreamToken(token: string) {
  try {
    const encoded = token.split(".")[1];
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as {
      user_id?: unknown;
    };
    if (typeof payload.user_id === "string" && payload.user_id) return payload.user_id;
  } catch {
    // The server response is rejected below without exposing the token.
  }
  throw new Error("Stream returned an invalid user token");
}

function safeRemoteImage(value: string) {
  const trimmed = value.trim();
  return /^https:\/\//i.test(trimmed) && trimmed.length <= 2_048 ? trimmed : undefined;
}

export function streamPublishes(participant: StreamVideoParticipant, track: SfuModels.TrackType) {
  return participant.publishedTracks.includes(track);
}

export const StreamTrackType = SfuModels.TrackType;
export { CallingState };
export type { StreamVideoParticipant, CustomVideoEvent };
