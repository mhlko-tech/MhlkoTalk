import type {
  ConnectionState,
  NetworkQuality,
  TRTC as TencentClient,
  TRTCStreamType,
} from "trtc-sdk-v5";
import type { MediaQuality } from "../core/types";
import type { RoomConnectionCredentials } from "./rtcAdapterRegistry";

export type TencentParticipant = {
  userId: string;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  speaking: boolean;
};

type TencentCallbacks = {
  onParticipants(participants: TencentParticipant[]): void;
  onCustomEvent(identity: string, event: Record<string, unknown>): void;
  onConnectionState(state: ConnectionState): void;
  onNetworkQuality(quality: NetworkQuality): void;
  onScreenShareStopped(): void;
};

type ParticipantState = TencentParticipant;

const cameraProfiles: Record<MediaQuality, "360p" | "720p" | "1080p"> = {
  low: "360p",
  medium: "720p",
  high: "1080p",
};

const screenProfiles: Record<MediaQuality, "480p_2" | "720p_2" | "1080p_2"> = {
  low: "480p_2",
  medium: "720p_2",
  high: "1080p_2",
};

/** Tencent TRTC transport isolated behind MHTalk's provider-neutral API. */
export class TencentRtcSession {
  private clientInstance: TencentClient | null = null;
  private sdk: (typeof import("trtc-sdk-v5"))["default"] | null = null;
  private credentials: RoomConnectionCredentials | null = null;
  private readonly participantState = new Map<string, ParticipantState>();
  private readonly watched = new Set<string>();
  private microphoneEnabled = false;
  private cameraEnabled = false;
  private screenEnabled = false;
  private microphoneId = "";
  private cameraId = "";

  constructor(private readonly callbacks: TencentCallbacks) {}

  get connected() {
    return Boolean(this.clientInstance);
  }

  get identity() {
    return this.credentials?.identity;
  }

  get participants() {
    return [...this.participantState.values()];
  }

  async connect(
    credentials: RoomConnectionCredentials,
    microphoneEnabled: boolean,
    noiseCancellationEnabled: boolean,
  ) {
    const sdkAppId = Number(credentials.routing.rtc.clientKey);
    if (!Number.isSafeInteger(sdkAppId) || sdkAppId <= 0) {
      throw new Error("Tencent SDK App ID is missing");
    }
    if (!credentials.identity) throw new Error("Tencent participant identity is missing");
    const sdk = await loadTencentRtc();
    const client = sdk.create();
    this.sdk = sdk;
    this.clientInstance = client;
    this.credentials = credentials;
    this.bind(client, sdk);
    await client.enterRoom({
      sdkAppId,
      userId: credentials.identity,
      userSig: credentials.token,
      strRoomId: credentials.roomName,
      scene: sdk.TYPE.SCENE_RTC,
      autoReceiveAudio: true,
      autoReceiveVideo: false,
    });
    client.enableAudioVolumeEvaluation(500, true);
    if (microphoneEnabled) {
      await client.startLocalAudio(localAudioConfig(noiseCancellationEnabled, this.microphoneId));
      this.microphoneEnabled = true;
    }
    this.emitParticipants();
  }

  async disconnect() {
    const client = this.clientInstance;
    this.clientInstance = null;
    this.sdk = null;
    this.credentials = null;
    this.participantState.clear();
    this.watched.clear();
    this.microphoneEnabled = false;
    this.cameraEnabled = false;
    this.screenEnabled = false;
    if (!client) return;
    // Tencent's declaration incorrectly requires a handler for the documented
    // `off("*")` overload, so keep the SDK cleanup call while containing the cast.
    (client.off as (event: "*") => TencentClient)("*");
    await Promise.allSettled([
      client.stopScreenShare(),
      client.stopLocalVideo(),
      client.stopLocalAudio(),
    ]);
    await client.exitRoom().catch(() => undefined);
    client.destroy();
  }

  async setMicrophoneEnabled(enabled: boolean, noiseCancellationEnabled: boolean) {
    const client = this.requiredClient();
    if (enabled === this.microphoneEnabled) return;
    if (enabled) await client.startLocalAudio(localAudioConfig(noiseCancellationEnabled, this.microphoneId));
    else await client.stopLocalAudio();
    this.microphoneEnabled = enabled;
  }

  async setNoiseCancellationEnabled(enabled: boolean) {
    const client = this.requiredClient();
    if (!this.microphoneEnabled) return;
    await client.updateLocalAudio(localAudioConfig(enabled, this.microphoneId));
  }

  async setCameraEnabled(enabled: boolean, quality: MediaQuality, cameraId?: string) {
    const client = this.requiredClient();
    if (cameraId) this.cameraId = cameraId;
    if (enabled === this.cameraEnabled) return;
    if (enabled) {
      await client.startLocalVideo({
        view: null,
        option: {
          profile: cameraProfiles[quality],
          ...(this.cameraId ? { cameraId: this.cameraId } : {}),
          fillMode: "contain",
          small: "360p",
        },
      });
    } else {
      await client.stopLocalVideo();
    }
    this.cameraEnabled = enabled;
  }

  async setScreenShareEnabled(enabled: boolean, quality: MediaQuality) {
    const client = this.requiredClient();
    if (enabled === this.screenEnabled) return;
    if (enabled) {
      await client.startScreenShare({
        view: null,
        option: {
          profile: screenProfiles[quality],
          fillMode: "contain",
          systemAudio: true,
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          qosPreference: this.sdk?.TYPE.QOS_PREFERENCE_CLEAR,
        },
      });
    } else {
      await client.stopScreenShare();
    }
    this.screenEnabled = enabled;
  }

  async selectDevice(kind: MediaDeviceKind, deviceId: string) {
    const client = this.requiredClient();
    if (!deviceId) return;
    if (kind === "audioinput") {
      this.microphoneId = deviceId;
      if (this.microphoneEnabled) await client.updateLocalAudio({ option: { microphoneId: deviceId } });
    }
    if (kind === "videoinput") {
      this.cameraId = deviceId;
      if (this.cameraEnabled) await client.updateLocalVideo({ option: { cameraId: deviceId } });
    }
    if (kind === "audiooutput") await this.sdk?.setCurrentSpeaker(deviceId);
  }

  async watch(identity: string, source: "camera" | "screen", quality: MediaQuality) {
    const client = this.requiredClient();
    const streamType = this.streamType(source);
    this.watched.add(`${identity}:${source}`);
    await client.startRemoteVideo({
      userId: identity,
      streamType,
      view: null,
      option: { small: source === "camera" && quality === "low", fillMode: "contain" },
    });
    return Boolean(client.getVideoTrack({ userId: identity, streamType }));
  }

  async unwatch(identity: string, source: "camera" | "screen") {
    this.watched.delete(`${identity}:${source}`);
    await this.clientInstance?.stopRemoteVideo({
      userId: identity,
      streamType: this.streamType(source),
    }).catch(() => undefined);
  }

  async setVideoQuality(identity: string, source: "camera" | "screen", quality: MediaQuality) {
    if (!this.clientInstance || !this.watched.has(`${identity}:${source}`)) return;
    await this.clientInstance.updateRemoteVideo({
      userId: identity,
      streamType: this.streamType(source),
      option: { small: source === "camera" && quality === "low", fillMode: "contain" },
    });
  }

  setParticipantVolume(identity: string, volume: number) {
    this.clientInstance?.setRemoteAudioVolume(identity, Math.max(0, Math.min(100, volume)));
  }

  mediaStream(identity: string | "local", source: "camera" | "screen") {
    const client = this.clientInstance;
    if (!client) return null;
    const track = client.getVideoTrack({
      ...(identity === "local" ? {} : { userId: identity }),
      streamType: this.streamType(source),
    });
    return track ? new MediaStream([track]) : null;
  }

  mediaHeight(identity: string, source: "camera" | "screen") {
    return this.clientInstance?.getVideoTrack({
      userId: identity,
      streamType: this.streamType(source),
    })?.getSettings().height;
  }

  sendCustomEvent(event: Record<string, unknown>) {
    const client = this.requiredClient();
    const data = new TextEncoder().encode(JSON.stringify(event));
    if (data.byteLength > 1_000) throw new Error("Tencent room event exceeds the 1 KB limit");
    client.sendCustomMessage({ cmdId: 1, data: data.buffer });
  }

  private bind(client: TencentClient, sdk: (typeof import("trtc-sdk-v5"))["default"]) {
    client.on(sdk.EVENT.REMOTE_USER_ENTER, ({ userId }) => {
      this.member(userId);
      this.emitParticipants();
    });
    client.on(sdk.EVENT.REMOTE_USER_EXIT, ({ userId }) => {
      this.participantState.delete(userId);
      this.emitParticipants();
    });
    client.on(sdk.EVENT.REMOTE_AUDIO_AVAILABLE, ({ userId }) => {
      this.member(userId).microphoneEnabled = true;
      this.emitParticipants();
    });
    client.on(sdk.EVENT.REMOTE_AUDIO_UNAVAILABLE, ({ userId }) => {
      this.member(userId).microphoneEnabled = false;
      this.emitParticipants();
    });
    client.on(sdk.EVENT.REMOTE_VIDEO_AVAILABLE, ({ userId, streamType }) => {
      const member = this.member(userId);
      if (streamType === sdk.TYPE.STREAM_TYPE_SUB) member.screenShareEnabled = true;
      else member.cameraEnabled = true;
      if (this.watched.has(`${userId}:${streamType === sdk.TYPE.STREAM_TYPE_SUB ? "screen" : "camera"}`)) {
        void this.watch(userId, streamType === sdk.TYPE.STREAM_TYPE_SUB ? "screen" : "camera", "medium");
      }
      this.emitParticipants();
    });
    client.on(sdk.EVENT.REMOTE_VIDEO_UNAVAILABLE, ({ userId, streamType }) => {
      const member = this.member(userId);
      if (streamType === sdk.TYPE.STREAM_TYPE_SUB) member.screenShareEnabled = false;
      else member.cameraEnabled = false;
      this.emitParticipants();
    });
    client.on(sdk.EVENT.AUDIO_VOLUME, ({ result }) => {
      const speaking = new Set(result.filter(({ userId, volume }) => userId && volume >= 8).map(({ userId }) => userId));
      this.participantState.forEach((member) => { member.speaking = speaking.has(member.userId); });
      this.emitParticipants();
    });
    client.on(sdk.EVENT.TRACK, () => this.emitParticipants());
    client.on(sdk.EVENT.CUSTOM_MESSAGE, ({ userId, data }) => {
      if (!userId || userId === this.identity) return;
      try {
        const event = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
        this.callbacks.onCustomEvent(userId, event);
      } catch {
        // Invalid vendor data never tears down the media connection.
      }
    });
    client.on(sdk.EVENT.CONNECTION_STATE_CHANGED, ({ state }) => this.callbacks.onConnectionState(state));
    client.on(sdk.EVENT.NETWORK_QUALITY, (quality) => this.callbacks.onNetworkQuality(quality));
    client.on(sdk.EVENT.SCREEN_SHARE_STOPPED, () => {
      this.screenEnabled = false;
      this.callbacks.onScreenShareStopped();
    });
  }

  private member(userId: string) {
    const current = this.participantState.get(userId);
    if (current) return current;
    const created: ParticipantState = {
      userId,
      microphoneEnabled: false,
      cameraEnabled: false,
      screenShareEnabled: false,
      speaking: false,
    };
    this.participantState.set(userId, created);
    return created;
  }

  private streamType(source: "camera" | "screen"): TRTCStreamType {
    if (!this.sdk) throw new Error("Tencent RTC is not connected");
    return source === "screen" ? this.sdk.TYPE.STREAM_TYPE_SUB : this.sdk.TYPE.STREAM_TYPE_MAIN;
  }

  private requiredClient() {
    if (!this.clientInstance) throw new Error("Tencent RTC is not connected");
    return this.clientInstance;
  }

  private emitParticipants() {
    this.callbacks.onParticipants(this.participants);
  }
}

function localAudioConfig(noiseCancellationEnabled: boolean, microphoneId: string) {
  return {
    option: {
      ...(microphoneId ? { microphoneId } : {}),
      profile: "high" as const,
      echoCancellation: noiseCancellationEnabled,
      autoGainControl: noiseCancellationEnabled,
      noiseSuppression: noiseCancellationEnabled,
    },
  };
}

let tencentRtcModule: Promise<(typeof import("trtc-sdk-v5"))["default"]> | null = null;

function loadTencentRtc() {
  tencentRtcModule ||= import("trtc-sdk-v5").then((module) => module.default);
  return tencentRtcModule;
}
