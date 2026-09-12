import type {
  ConnectionState,
  IAgoraRTCClient,
  IAgoraRTCRemoteUser,
  ICameraVideoTrack,
  ILocalAudioTrack,
  ILocalVideoTrack,
  IMicrophoneAudioTrack,
  UID,
} from "agora-rtc-sdk-ng";
import type { MediaQuality } from "../core/types";
import type { RoomConnectionCredentials } from "./rtcAdapterRegistry";
import { throwIfRtcJoinAborted } from "./rtcConnectionResilience";

export type AgoraParticipant = {
  userId: string;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  speaking: boolean;
};

type AgoraCallbacks = {
  onParticipants(participants: AgoraParticipant[]): void;
  onCustomEvent(identity: string, event: Record<string, unknown>): void;
  onConnectionState(state: ConnectionState, reason?: string): void;
  onAudio(identity: string, source: "voice" | "screen", stream: MediaStream | null): void;
};

type RefreshCredentials = () => Promise<RoomConnectionCredentials>;

const screenSuffix = ":screen";
const dimensions: Record<MediaQuality, { width: number; height: number; frameRate: number }> = {
  low: { width: 640, height: 360, frameRate: 15 },
  medium: { width: 1280, height: 720, frameRate: 30 },
  high: { width: 1920, height: 1080, frameRate: 30 },
};

/**
 * Agora transport isolated behind MHTalk's provider-neutral RoomSession API.
 * A second Agora identity publishes screen video/audio, allowing camera and
 * screen sharing to remain active together on providers that permit one video
 * track per connection.
 */
export class AgoraRtcSession {
  private clientInstance: IAgoraRTCClient | null = null;
  private screenClient: IAgoraRTCClient | null = null;
  private microphoneTrack: IMicrophoneAudioTrack | null = null;
  private cameraTrack: ICameraVideoTrack | null = null;
  private screenVideoTrack: ILocalVideoTrack | null = null;
  private screenAudioTrack: ILocalAudioTrack | null = null;
  private credentials: RoomConnectionCredentials | null = null;
  private refreshCredentials: RefreshCredentials | null = null;
  private watched = new Set<string>();
  private speaking = new Set<string>();
  private connectionGeneration = 0;

  constructor(
    private readonly callbacks: AgoraCallbacks,
    private readonly loadRtc = loadAgoraRtc,
  ) {}

  get connected() {
    return Boolean(this.clientInstance);
  }

  get identity() {
    return this.credentials?.identity;
  }

  get participants(): AgoraParticipant[] {
    const client = this.clientInstance;
    const ownIdentity = this.identity;
    if (!client) return [];
    const grouped = new Map<string, AgoraParticipant>();
    for (const user of client.remoteUsers) {
      const { identity, screen } = splitIdentity(user.uid);
      if (!identity || identity === ownIdentity) continue;
      const current = grouped.get(identity) || {
        userId: identity,
        microphoneEnabled: false,
        cameraEnabled: false,
        screenShareEnabled: false,
        speaking: false,
      };
      if (screen) {
        current.screenShareEnabled ||= user.hasVideo;
      } else {
        current.microphoneEnabled ||= user.hasAudio;
        current.cameraEnabled ||= user.hasVideo;
      }
      current.speaking ||= this.speaking.has(identity);
      grouped.set(identity, current);
    }
    return [...grouped.values()];
  }

  async connect(
    credentials: RoomConnectionCredentials,
    microphoneEnabled: boolean,
    noiseCancellationEnabled: boolean,
    refreshCredentials: RefreshCredentials,
    signal?: AbortSignal,
  ) {
    throwIfRtcJoinAborted(signal);
    const generation = ++this.connectionGeneration;
    const appId = credentials.routing.rtc.clientKey;
    if (!appId) throw new Error("Agora App ID is missing");
    if (!credentials.identity) throw new Error("Agora participant identity is missing");
    this.credentials = credentials;
    this.refreshCredentials = refreshCredentials;
    const AgoraRTC = await this.loadRtc();
    throwIfRtcJoinAborted(signal);
    if (generation !== this.connectionGeneration) throw new DOMException("Room join cancelled", "AbortError");
    const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    this.clientInstance = client;
    this.bindMainClient(client);
    const assertCurrent = () => {
      throwIfRtcJoinAborted(signal);
      if (generation !== this.connectionGeneration || this.clientInstance !== client) {
        throw new DOMException("Room join cancelled", "AbortError");
      }
    };
    const abort = () => { if (this.clientInstance === client) void this.disconnect().catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    let microphone: IMicrophoneAudioTrack | null = null;
    try {
      assertCurrent();
      await client.join(appId, credentials.roomName, credentials.token, credentials.identity, {
        autoSubscribe: false,
        autoReceiveAndPlayAudio: false,
      });
      assertCurrent();
      client.enableAudioVolumeIndicator();
      if (microphoneEnabled) {
        microphone = await AgoraRTC.createMicrophoneAudioTrack(voiceCaptureConfig(noiseCancellationEnabled));
        assertCurrent();
        this.microphoneTrack = microphone;
        await client.publish(microphone);
        assertCurrent();
      }
      this.emitParticipants();
    } catch (error) {
      microphone?.close();
      client.removeAllListeners?.();
      if (this.clientInstance === client) await this.disconnect();
      else await client.leave().catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async disconnect() {
    this.connectionGeneration += 1;
    const client = this.clientInstance;
    const screenClient = this.screenClient;
    this.clientInstance = null;
    this.screenClient = null;
    this.credentials = null;
    this.refreshCredentials = null;
    client?.removeAllListeners?.();
    screenClient?.removeAllListeners?.();
    this.watched.clear();
    this.speaking.clear();
    const tracks = [
      this.microphoneTrack,
      this.cameraTrack,
      this.screenVideoTrack,
      this.screenAudioTrack,
    ];
    this.microphoneTrack = null;
    this.cameraTrack = null;
    this.screenVideoTrack = null;
    this.screenAudioTrack = null;
    tracks.forEach((track) => track?.close());
    await Promise.allSettled([client?.leave(), screenClient?.leave()]);
  }

  async setMicrophoneEnabled(enabled: boolean, noiseCancellationEnabled: boolean) {
    const client = this.clientInstance;
    if (!client) return;
    if (!enabled) {
      if (this.microphoneTrack) await client.unpublish(this.microphoneTrack);
      this.microphoneTrack?.close();
      this.microphoneTrack = null;
      return;
    }
    if (this.microphoneTrack) return;
    const AgoraRTC = await this.loadRtc();
    this.microphoneTrack = await AgoraRTC.createMicrophoneAudioTrack(
      voiceCaptureConfig(noiseCancellationEnabled),
    );
    await client.publish(this.microphoneTrack);
  }

  async setNoiseCancellationEnabled(enabled: boolean) {
    if (!this.microphoneTrack) return;
    const deviceId = this.microphoneTrack.getTrackLabel();
    await this.setMicrophoneEnabled(false, enabled);
    await this.setMicrophoneEnabled(true, enabled);
    if (deviceId) {
      // Device selection is restored separately from the persisted preference.
    }
  }

  async setCameraEnabled(enabled: boolean, quality: MediaQuality, cameraId?: string) {
    const client = this.clientInstance;
    if (!client) return;
    if (!enabled) {
      if (this.cameraTrack) await client.unpublish(this.cameraTrack);
      this.cameraTrack?.close();
      this.cameraTrack = null;
      this.emitParticipants();
      return;
    }
    if (this.cameraTrack) return;
    const AgoraRTC = await this.loadRtc();
    this.cameraTrack = await AgoraRTC.createCameraVideoTrack({
      ...(cameraId ? { cameraId } : {}),
      encoderConfig: dimensions[quality],
      optimizationMode: "detail",
    });
    await client.publish(this.cameraTrack);
  }

  async setScreenShareEnabled(enabled: boolean, quality: MediaQuality) {
    if (!enabled) {
      const client = this.screenClient;
      const tracks = [this.screenVideoTrack, this.screenAudioTrack].filter(Boolean) as (ILocalVideoTrack | ILocalAudioTrack)[];
      if (client && tracks.length) await client.unpublish(tracks).catch(() => undefined);
      this.screenVideoTrack?.close();
      this.screenAudioTrack?.close();
      this.screenVideoTrack = null;
      this.screenAudioTrack = null;
      await client?.leave().catch(() => undefined);
      this.screenClient = null;
      return false;
    }
    if (this.screenClient) return Boolean(this.screenAudioTrack);
    let credentials = this.credentials;
    if (!credentials?.screenToken || !credentials.screenIdentity) {
      credentials = await this.refreshCredentials?.() || null;
    }
    const appId = credentials?.routing.rtc.clientKey;
    if (!credentials || !appId || !credentials.screenToken || !credentials.screenIdentity) {
      throw new Error("Agora screen-share credentials are missing");
    }
    this.credentials = credentials;
    const AgoraRTC = await this.loadRtc();
    const screenClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    this.screenClient = screenClient;
    this.bindTokenRefresh(screenClient, true);
    try {
      await screenClient.join(
        appId,
        credentials.roomName,
        credentials.screenToken,
        credentials.screenIdentity,
        { autoSubscribe: false, autoReceiveAndPlayAudio: false },
      );
      const created = await AgoraRTC.createScreenVideoTrack(
        { encoderConfig: dimensions[quality], optimizationMode: "detail" },
        // Capturing call playback would send viewers' voices back through the
        // shared screen. Exclude our own audio without filtering the media.
        { AEC: false, ANS: false, AGC: false, restrictOwnAudio: true },
      );
      const [video, capturedAudio] = Array.isArray(created) ? created : [created, null];
      this.screenVideoTrack = video;
      if (capturedAudio) {
        let mediaStreamTrack: MediaStreamTrack | undefined;
        try {
          // The screen helper has no audio encoder setting. Publish a clone with
          // the music preset so media is not reduced to the default 32 kbps mono.
          mediaStreamTrack = capturedAudio.getMediaStreamTrack().clone();
          // Capture already disabled all voice processing. SDK-generated tracks
          // may reject applyConstraints; the encoder sets stereo and sample rate.
          mediaStreamTrack.contentHint = "music";
          this.screenAudioTrack = AgoraRTC.createCustomAudioTrack({
            mediaStreamTrack,
            encoderConfig: "high_quality_stereo",
          });
        } catch (error) {
          mediaStreamTrack?.stop();
          throw error;
        } finally {
          capturedAudio.close();
        }
      }
      video.on("track-ended", () => void this.setScreenShareEnabled(false, quality));
      await screenClient.publish([video, ...(this.screenAudioTrack ? [this.screenAudioTrack] : [])]);
      return Boolean(this.screenAudioTrack);
    } catch (error) {
      await this.setScreenShareEnabled(false, quality);
      throw error;
    }
  }

  async selectDevice(kind: MediaDeviceKind, deviceId: string) {
    if (!deviceId) return;
    if (kind === "audioinput") await this.microphoneTrack?.setDevice(deviceId);
    if (kind === "videoinput") await this.cameraTrack?.setDevice(deviceId);
    if (kind === "audiooutput") {
      await Promise.all(this.remoteAudioTracks().map((track) => track.setPlaybackDevice(deviceId)));
    }
  }

  async watch(identity: string, source: "camera" | "screen", quality: MediaQuality) {
    const user = this.remoteUser(identity, source);
    if (!user?.hasVideo || !this.clientInstance) return false;
    const key = `${identity}:${source}`;
    this.watched.add(key);
    await this.clientInstance.setRemoteVideoStreamType(user.uid, quality === "low" ? 1 : 0).catch(() => undefined);
    if (!user.videoTrack) await this.clientInstance.subscribe(user, "video");
    if (source === "screen" && user.hasAudio && !user.audioTrack) {
      await this.clientInstance.subscribe(user, "audio");
      this.emitRemoteAudio(user);
    }
    this.emitParticipants();
    return Boolean(user.videoTrack);
  }

  async unwatch(identity: string, source: "camera" | "screen") {
    this.watched.delete(`${identity}:${source}`);
    const user = this.remoteUser(identity, source);
    if (!user || !this.clientInstance) return;
    if (user.videoTrack) await this.clientInstance.unsubscribe(user, "video").catch(() => undefined);
    if (source === "screen" && user.audioTrack) {
      await this.clientInstance.unsubscribe(user, "audio").catch(() => undefined);
      this.callbacks.onAudio(identity, "screen", null);
    }
  }

  async setVideoQuality(identity: string, source: "camera" | "screen", quality: MediaQuality) {
    const user = this.remoteUser(identity, source);
    if (user && this.clientInstance) {
      await this.clientInstance.setRemoteVideoStreamType(user.uid, quality === "low" ? 1 : 0);
    }
  }

  mediaStream(identity: string | "local", source: "camera" | "screen") {
    const track = identity === "local"
      ? source === "camera" ? this.cameraTrack : this.screenVideoTrack
      : this.remoteUser(identity, source)?.videoTrack;
    const mediaTrack = track?.getMediaStreamTrack();
    return mediaTrack ? new MediaStream([mediaTrack]) : null;
  }

  mediaHeight(identity: string, source: "camera" | "screen") {
    return this.remoteUser(identity, source)?.videoTrack
      ?.getMediaStreamTrack().getSettings().height;
  }

  async sendCustomEvent(event: Record<string, unknown>) {
    if (!this.clientInstance) return;
    const payload = new TextEncoder().encode(JSON.stringify(event));
    const client = this.clientInstance as IAgoraRTCClient & {
      sendStreamMessage(
        message: { payload: Uint8Array; syncWithAudio?: boolean },
        needRetry?: boolean,
      ): Promise<void>;
    };
    await client.sendStreamMessage({ payload }, true);
  }

  private bindMainClient(client: IAgoraRTCClient) {
    client.on("user-joined", () => this.emitParticipants());
    client.on("user-left", (user) => {
      const { identity, screen } = splitIdentity(user.uid);
      if (identity) this.callbacks.onAudio(identity, screen ? "screen" : "voice", null);
      this.emitParticipants();
    });
    client.on("user-published", async (user, mediaType) => {
      const { identity, screen } = splitIdentity(user.uid);
      if (!identity || identity === this.identity) return;
      if (mediaType === "audio" && (!screen || this.watched.has(`${identity}:screen`))) {
        await client.subscribe(user, "audio");
        this.emitRemoteAudio(user);
      }
      if (mediaType === "video" && this.watched.has(`${identity}:${screen ? "screen" : "camera"}`)) {
        await client.subscribe(user, "video");
      }
      this.emitParticipants();
    });
    client.on("user-unpublished", (user, mediaType) => {
      const { identity, screen } = splitIdentity(user.uid);
      if (identity && mediaType === "audio") {
        this.callbacks.onAudio(identity, screen ? "screen" : "voice", null);
      }
      this.emitParticipants();
    });
    client.on("stream-message", (uid, payload) => {
      const { identity, screen } = splitIdentity(uid);
      if (!identity || screen || identity === this.identity) return;
      try {
        const event = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
        this.callbacks.onCustomEvent(identity, event);
      } catch {
        // Invalid vendor data is isolated from the room connection.
      }
    });
    client.on("volume-indicator", (levels) => {
      this.speaking.clear();
      levels.forEach(({ uid, level }) => {
        const { identity, screen } = splitIdentity(uid);
        if (identity && !screen && level >= 8) this.speaking.add(identity);
      });
      this.emitParticipants();
    });
    client.on("connection-state-change", (state, _previousState, reason) => {
      if (this.clientInstance === client) this.callbacks.onConnectionState(state, reason);
    });
    this.bindTokenRefresh(client, false);
  }

  private bindTokenRefresh(client: IAgoraRTCClient, screen: boolean) {
    const renew = async () => {
      if ((screen ? this.screenClient : this.clientInstance) !== client) return;
      const credentials = await this.refreshCredentials?.();
      if ((screen ? this.screenClient : this.clientInstance) !== client) return;
      const token = screen ? credentials?.screenToken : credentials?.token;
      if (!credentials || !token) throw new Error("Agora token refresh failed");
      this.credentials = credentials;
      await client.renewToken(token);
    };
    client.on("token-privilege-will-expire", () => void renew().catch(() => undefined));
    client.on("token-privilege-did-expire", () => void renew().catch(() => undefined));
  }

  private remoteUser(identity: string, source: "camera" | "screen") {
    if (!identity || identity === this.identity) return undefined;
    return this.clientInstance?.remoteUsers.find((user) => {
      const parsed = splitIdentity(user.uid);
      return parsed.identity === identity && parsed.screen === (source === "screen");
    });
  }

  private emitRemoteAudio(user: IAgoraRTCRemoteUser) {
    const { identity, screen } = splitIdentity(user.uid);
    if (!identity || identity === this.identity) return;
    const track = user.audioTrack?.getMediaStreamTrack();
    if (track) {
      this.callbacks.onAudio(identity, screen ? "screen" : "voice", new MediaStream([track]));
    }
  }

  private remoteAudioTracks() {
    return this.clientInstance?.remoteUsers.flatMap((user) => user.audioTrack ? [user.audioTrack] : []) || [];
  }

  private emitParticipants() {
    this.callbacks.onParticipants(this.participants);
  }
}

function splitIdentity(uid: UID) {
  const value = String(uid);
  const screen = value.endsWith(screenSuffix);
  return { identity: screen ? value.slice(0, -screenSuffix.length) : value, screen };
}

function voiceCaptureConfig(enabled: boolean) {
  return {
    AEC: enabled,
    ANS: enabled,
    AGC: enabled,
    encoderConfig: "speech_standard" as const,
  };
}

let agoraRtcModule: Promise<(typeof import("agora-rtc-sdk-ng"))["default"]> | null = null;

function loadAgoraRtc() {
  agoraRtcModule ||= import("agora-rtc-sdk-ng").then((module) => module.default);
  return agoraRtcModule;
}
