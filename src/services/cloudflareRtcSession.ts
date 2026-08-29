import {
  PartyTracks,
  getCamera,
  getMic,
  getScreenshare,
  type MediaDevice,
  type Screenshare,
  type TrackMetadata,
} from "partytracks/client";
import { of, type Subscription } from "rxjs";
import type { MediaQuality, UserProfile } from "../core/types";
import { accountSession } from "./accountSession";
import type { RoomConnectionCredentials } from "./rtcAdapterRegistry";

export type CloudflareParticipant = {
  userId: string;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  speaking: boolean;
};

type CloudflareCallbacks = {
  onParticipants(participants: CloudflareParticipant[]): void;
  onCustomEvent(identity: string, event: Record<string, unknown>): void;
  onConnectionState(state: RTCPeerConnectionState | "connecting" | "closed"): void;
  onAudio(identity: string, source: "voice" | "screen", stream: MediaStream | null): void;
  onScreenShareStopped(): void;
};

type RemoteTrackKind = "audio" | "camera" | "screen" | "screenAudio";
type Member = CloudflareParticipant & {
  tracks: Partial<Record<RemoteTrackKind, TrackMetadata>>;
  profile?: Partial<UserProfile>;
};

const cameraConstraints: Record<MediaQuality, MediaTrackConstraints> = {
  low: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } },
  medium: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
  high: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
};

/** Browser/Tauri transport for Cloudflare Realtime SFU. Vendor secrets remain in the Worker. */
export class CloudflareRtcSession {
  private partyTracks: PartyTracks | null = null;
  private socket: WebSocket | null = null;
  private credentials: RoomConnectionCredentials | null = null;
  private mic: MediaDevice | null = null;
  private camera: MediaDevice | null = null;
  private screen: Screenshare | null = null;
  private readonly subscriptions = new Set<Subscription>();
  private readonly remoteSubscriptions = new Map<string, Subscription>();
  private readonly remoteStreams = new Map<string, MediaStream>();
  private readonly localStreams = new Map<"camera" | "screen", MediaStream>();
  private readonly members = new Map<string, Member>();
  private readonly watched = new Map<string, MediaQuality>();
  private localTracks: Partial<Record<RemoteTrackKind, TrackMetadata>> = {};
  private profile: Partial<UserProfile> = {};
  private microphoneEnabled = false;
  private cameraEnabled = false;
  private screenEnabled = false;
  private microphoneId = "";
  private cameraId = "";

  constructor(private readonly callbacks: CloudflareCallbacks) {}

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get identity() {
    return this.credentials?.identity;
  }

  get participants() {
    return [...this.members.values()];
  }

  async connect(credentials: RoomConnectionCredentials, microphoneEnabled: boolean) {
    if (!credentials.identity) throw new Error("Cloudflare participant identity is missing");
    const baseUrl = credentials.routing.rtc.serverUrl.replace(/\/$/, "");
    const accessToken = accountSession.getAccessToken();
    if (!accessToken) throw new Error("Sign in is required for Cloudflare Realtime");

    this.credentials = credentials;
    this.callbacks.onConnectionState("connecting");
    const headers = new Headers({ authorization: `Bearer ${accessToken}` });
    const partyTracks = new PartyTracks({ prefix: `${baseUrl}/partytracks`, headers });
    this.partyTracks = partyTracks;
    this.track(partyTracks.peerConnectionState$.subscribe((state) => this.callbacks.onConnectionState(state)));

    this.mic = getMic({ broadcasting: microphoneEnabled, retainIdleTrack: true });
    this.camera = getCamera({ broadcasting: false, constraints: cameraConstraints.medium });
    this.screen = getScreenshare({ audio: true });
    this.microphoneEnabled = microphoneEnabled;
    await this.applyPreferredDevice(this.mic, this.microphoneId);
    await this.applyPreferredDevice(this.camera, this.cameraId);

    this.track(partyTracks.push(this.mic.broadcastTrack$, {
      sendEncodings$: of([{ networkPriority: "high" }]),
    }).subscribe((metadata) => this.updateLocalTrack("audio", metadata)));
    this.track(partyTracks.push(this.camera.broadcastTrack$, {
      sendEncodings$: of([
        { rid: "h", maxBitrate: 1_500_000, maxFramerate: 30 },
        { rid: "l", maxBitrate: 350_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
      ]),
    }).subscribe((metadata) => this.updateLocalTrack("camera", metadata)));
    this.track(this.camera.broadcastTrack$.subscribe((track) => this.localStreams.set("camera", new MediaStream([track]))));
    this.track(partyTracks.push(this.screen.video.broadcastTrack$).subscribe((metadata) => this.updateLocalTrack("screen", metadata)));
    this.track(this.screen.video.broadcastTrack$.subscribe((track) => this.localStreams.set("screen", new MediaStream([track]))));
    this.track(partyTracks.push(this.screen.audio.broadcastTrack$).subscribe((metadata) => this.updateLocalTrack("screenAudio", metadata)));
    this.track(this.screen.isSourceEnabled$.subscribe((enabled) => {
      if (!enabled && this.screenEnabled) {
        this.screenEnabled = false;
        this.publish();
        this.callbacks.onScreenShareStopped();
      }
    }));

    const socketUrl = new URL(`${baseUrl}/room`);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("ticket", credentials.token);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(socketUrl);
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error("Cloudflare room signaling timed out")), 12_000);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.publish();
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Cloudflare room signaling failed"));
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        void this.disconnect();
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
    });
  }

  async disconnect() {
    this.socket?.close(1000, "Leaving room");
    this.socket = null;
    this.mic?.stopBroadcasting();
    this.camera?.stopBroadcasting();
    this.screen?.stopBroadcasting();
    this.mic?.disableSource();
    this.camera?.disableSource();
    this.screen?.disableSource();
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    for (const subscription of this.remoteSubscriptions.values()) subscription.unsubscribe();
    this.subscriptions.clear();
    this.remoteSubscriptions.clear();
    this.remoteStreams.clear();
    this.localStreams.clear();
    this.members.clear();
    this.watched.clear();
    this.localTracks = {};
    this.partyTracks = null;
    this.credentials = null;
    this.mic = null;
    this.camera = null;
    this.screen = null;
    this.callbacks.onConnectionState("closed");
  }

  async setMicrophoneEnabled(enabled: boolean) {
    if (!this.mic) throw new Error("Cloudflare Realtime is not connected");
    enabled ? this.mic.startBroadcasting() : this.mic.stopBroadcasting();
    this.microphoneEnabled = enabled;
    this.publish();
  }

  async setCameraEnabled(enabled: boolean, quality: MediaQuality, cameraId?: string) {
    if (!this.camera) throw new Error("Cloudflare Realtime is not connected");
    if (cameraId) {
      this.cameraId = cameraId;
      await this.applyPreferredDevice(this.camera, cameraId);
    }
    void quality;
    enabled ? this.camera.startBroadcasting() : this.camera.stopBroadcasting();
    this.cameraEnabled = enabled;
    this.publish();
  }

  async setScreenShareEnabled(enabled: boolean, _quality: MediaQuality) {
    if (!this.screen) throw new Error("Cloudflare Realtime is not connected");
    enabled ? this.screen.startBroadcasting() : this.screen.stopBroadcasting();
    this.screenEnabled = enabled;
    this.publish();
  }

  async selectDevice(kind: MediaDeviceKind, deviceId: string) {
    if (!deviceId) return;
    if (kind === "audioinput" && this.mic) {
      this.microphoneId = deviceId;
      await this.applyPreferredDevice(this.mic, deviceId);
    }
    if (kind === "videoinput" && this.camera) {
      this.cameraId = deviceId;
      await this.applyPreferredDevice(this.camera, deviceId);
    }
  }

  watch(identity: string, source: "camera" | "screen", quality: MediaQuality) {
    this.watched.set(`${identity}:${source}`, quality);
    this.pull(identity, source);
    return Promise.resolve(Boolean(this.remoteStreams.get(`${identity}:${source}`)));
  }

  unwatch(identity: string, source: "camera" | "screen") {
    const key = `${identity}:${source}`;
    this.watched.delete(key);
    this.remoteSubscriptions.get(key)?.unsubscribe();
    this.remoteSubscriptions.delete(key);
    this.remoteStreams.delete(key);
    return Promise.resolve();
  }

  setVideoQuality(identity: string, source: "camera" | "screen", quality: MediaQuality) {
    this.watched.set(`${identity}:${source}`, quality);
    this.pull(identity, source, true);
  }

  setParticipantVolume(identity: string, volume: number) {
    for (const source of ["voice", "screen"] as const) {
      const stream = this.remoteStreams.get(`${identity}:${source}`);
      for (const audio of document.querySelectorAll<HTMLAudioElement>(`audio[data-cloudflare-rtc=\"${CSS.escape(`${identity}:${source}`)}\"]`)) {
        audio.volume = Math.max(0, Math.min(1, volume / 100));
      }
      void stream;
    }
  }

  mediaStream(identity: string | "local", source: "camera" | "screen") {
    if (identity === "local") return this.localStreams.get(source) || null;
    return this.remoteStreams.get(`${identity}:${source}`) || null;
  }

  sendCustomEvent(event: Record<string, unknown>) {
    this.send({ type: "event", event });
  }

  setProfile(profile: Partial<UserProfile>) {
    this.profile = profile;
    this.publish();
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== "string") return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (message.type === "event" && typeof message.identity === "string" && message.event && typeof message.event === "object") {
      this.callbacks.onCustomEvent(message.identity, message.event as Record<string, unknown>);
      return;
    }
    if (message.type !== "snapshot" || !Array.isArray(message.members)) return;
    const next = new Map<string, Member>();
    for (const value of message.members) {
      if (!value || typeof value !== "object") continue;
      const member = value as Record<string, unknown>;
      if (typeof member.identity !== "string" || member.identity === this.identity) continue;
      const media = member.media && typeof member.media === "object" ? member.media as Record<string, unknown> : {};
      next.set(member.identity, {
        userId: member.identity,
        microphoneEnabled: media.microphoneEnabled === true,
        cameraEnabled: media.cameraEnabled === true,
        screenShareEnabled: media.screenShareEnabled === true,
        speaking: false,
        tracks: member.tracks && typeof member.tracks === "object" ? member.tracks as Member["tracks"] : {},
        profile: member.profile && typeof member.profile === "object" ? member.profile as Member["profile"] : undefined,
      });
    }
    for (const identity of this.members.keys()) {
      if (!next.has(identity)) this.removeRemote(identity);
    }
    this.members.clear();
    next.forEach((member, identity) => this.members.set(identity, member));
    next.forEach((member) => {
      this.pull(member.userId, "audio");
      this.pull(member.userId, "screenAudio");
      if (this.watched.has(`${member.userId}:camera`)) this.pull(member.userId, "camera");
      if (this.watched.has(`${member.userId}:screen`)) this.pull(member.userId, "screen");
    });
    this.callbacks.onParticipants([...next.values()]);
  }

  private pull(identity: string, kind: RemoteTrackKind | "camera" | "screen", force = false) {
    const partyTracks = this.partyTracks;
    const metadata = this.members.get(identity)?.tracks[kind as RemoteTrackKind];
    const source = kind === "audio" ? "voice" : kind === "screenAudio" ? "screen" : kind;
    const key = `${identity}:${source}`;
    if (!partyTracks || !metadata?.sessionId || !metadata.trackName) return;
    if (this.remoteSubscriptions.has(key) && !force) return;
    this.remoteSubscriptions.get(key)?.unsubscribe();
    const options = (kind === "camera" && this.watched.get(key) === "low")
      ? { simulcast: { preferredRid$: of("l") } }
      : kind === "camera" ? { simulcast: { preferredRid$: of("h") } } : undefined;
    const subscription = partyTracks.pull(of({ ...metadata, location: "remote" as const }), options).subscribe((track) => {
      const stream = new MediaStream([track]);
      this.remoteStreams.set(key, stream);
      if (source === "voice" || source === "screen") this.callbacks.onAudio(identity, source, stream);
    });
    this.remoteSubscriptions.set(key, subscription);
  }

  private removeRemote(identity: string) {
    for (const source of ["voice", "screen", "camera"] as const) {
      const key = `${identity}:${source}`;
      this.remoteSubscriptions.get(key)?.unsubscribe();
      this.remoteSubscriptions.delete(key);
      this.remoteStreams.delete(key);
      if (source === "voice" || source === "screen") this.callbacks.onAudio(identity, source, null);
    }
  }

  private updateLocalTrack(kind: RemoteTrackKind, metadata: TrackMetadata) {
    this.localTracks[kind] = metadata;
    this.publish();
  }

  private publish() {
    this.send({
      type: "publish",
      tracks: this.localTracks,
      media: {
        microphoneEnabled: this.microphoneEnabled,
        cameraEnabled: this.cameraEnabled,
        screenShareEnabled: this.screenEnabled,
      },
      profile: this.profile,
    });
  }

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private track(subscription: Subscription) {
    this.subscriptions.add(subscription);
  }

  private async applyPreferredDevice(device: MediaDevice, deviceId: string) {
    if (!deviceId) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const preferred = devices.find((item) => item.deviceId === deviceId);
    if (preferred) device.setPreferredDevice(preferred);
  }
}
