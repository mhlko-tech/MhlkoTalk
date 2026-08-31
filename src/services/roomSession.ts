import {
  ConnectionQuality,
  LocalAudioTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  ScreenSharePresets,
  TokenSource,
  Track,
  VideoPresets,
} from "livekit-client";
import type {
  ChatListener,
  ChatMessage,
  ChatSnapshot,
  SessionListener,
  SessionSnapshot,
  MediaQuality,
  UserProfile,
} from "../core/types";
import {
  normalizeProfileAvatar,
  profileAvatarImageSource,
} from "../core/profileAvatar";
import { moderateMainMessage } from "../core/moderation";
import { liveKitTokenEndpoint, liveKitUrl } from "../config/serviceConfig";
import { accountSession } from "./accountSession";
import {
  legacyRoomServiceRouting,
  parseRoomServiceRouting,
  type FileProviderId,
  type MessagingProviderId,
  type RoomServiceRouting,
} from "../core/serviceRouting";
import {
  formatAttachmentLimit,
  limitMediaQuality,
} from "../core/subscription";
import {
  RtcAdapterRegistry,
  type RoomConnectionCredentials,
} from "./rtcAdapterRegistry";
import {
  CallingState as StreamCallingState,
  StreamTrackType,
  StreamRtcSession,
  streamPublishes,
  type CustomVideoEvent,
  type StreamVideoParticipant,
} from "./streamRtcSession";
import {
  AgoraRtcSession,
  type AgoraParticipant,
} from "./agoraRtcSession";
import {
  TencentRtcSession,
  type TencentParticipant,
} from "./tencentRtcSession";
import {
  CloudflareRtcSession,
  type CloudflareParticipant,
} from "./cloudflareRtcSession";

const initialSnapshot: SessionSnapshot = {
  state: "idle",
  roomName: null,
  rtcProvider: null,
  embeddedCallUrl: null,
  microphoneEnabled: true,
  localSpeaking: false,
  cameraEnabled: false,
  screenShareEnabled: false,
  screenShareAudioEnabled: false,
  connectionQuality: "unknown",
  estimatedDropPercent: null,
  recoveryAttempt: 0,
  lastRecoveryMs: null,
  connectionMessage: null,
  participants: [],
};

export type EventSoundKind = "presence" | "media";
export type EventSoundSettings = Record<EventSoundKind, boolean>;

const qualityRank: Record<MediaQuality, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const qualityValue = {
  low: 0,
  medium: 1,
  high: 2,
} as const;

const supportedMessagingProviders: MessagingProviderId[] = [
  "stream-events",
  "agora-data",
  "tencent-data",
  "cloudflare-realtime",
  "daily-chat",
  "whereby-chat",
  "livekit-data",
  "supabase-realtime",
];

const supportedFileProviders: FileProviderId[] = [
  "supabase-storage",
  "daily-prebuilt",
  "whereby-prebuilt",
  "livekit-stream",
];

/** Owns the whole media lifecycle; React components only observe this class. */
export class RoomSession {
  private snapshot = initialSnapshot;
  private listeners = new Set<SessionListener>();
  private chatListeners = new Set<ChatListener>();
  private chat: ChatSnapshot = { messages: [], typing: [] };
  private typingTimer: number | undefined;
  private objectUrls = new Set<string>();
  private profile: UserProfile = {
    name: localStorage.getItem("mhtalk.profile.name") || "Me",
    bio: localStorage.getItem("mhtalk.profile.bio") || "",
    avatar: localStorage.getItem("mhtalk.profile.avatar") || "M",
    username: localStorage.getItem("mhtalk.profile.username") || undefined,
    usernameVisible: localStorage.getItem("mhtalk.profile.username-visible") !== "false",
  };
  private remoteProfiles = new Map<string, UserProfile>();
  private recoveryTimer: number | undefined;
  private recoveryStartedAt = 0;
  private room: Room | null = null;
  private readonly streamRtc = new StreamRtcSession({
    onParticipants: (participants) => this.syncStreamParticipants(participants),
    onCustomEvent: (event) => this.handleStreamCustomEvent(event),
    onCallingState: (state) => this.handleStreamCallingState(state),
  });
  private readonly agoraRtc = new AgoraRtcSession({
    onParticipants: (participants) => this.syncAgoraParticipants(participants),
    onCustomEvent: (identity, event) => this.handleProviderCustomEvent(identity, event),
    onConnectionState: (state) => this.handleAgoraConnectionState(state),
    onAudio: (identity, source, stream) => {
      if (stream) this.attachStreamAudio(stream, identity, source);
      else this.detachStreamAudio(identity, source);
    },
  });
  private readonly tencentRtc = new TencentRtcSession({
    onParticipants: (participants) => this.syncTencentParticipants(participants),
    onCustomEvent: (identity, event) => this.handleProviderCustomEvent(identity, event),
    onConnectionState: (state) => this.handleTencentConnectionState(state),
    onNetworkQuality: (quality) => {
      const local = quality.uplinkNetworkQuality;
      const remote = quality.downlinkNetworkQuality;
      const worst = Math.max(local, remote);
      this.update({
        connectionQuality: worst <= 1 ? "excellent" : worst <= 3 ? "good" : "poor",
        estimatedDropPercent: worst <= 1 ? 1 : worst <= 3 ? 6 : 24,
      });
    },
    onScreenShareStopped: () => {
      this.detachMedia("local-screen");
      this.update({ screenShareEnabled: false, screenShareAudioEnabled: false });
      void this.playEventTone("media-stop");
    },
  });
  private readonly cloudflareRtc = new CloudflareRtcSession({
    onParticipants: (participants) => this.syncCloudflareParticipants(participants),
    onCustomEvent: (identity, event) => this.handleProviderCustomEvent(identity, event),
    onConnectionState: (state) => this.handleCloudflareConnectionState(state),
    onAudio: (identity, source, stream) => {
      if (stream) this.attachStreamAudio(stream, identity, source);
      else this.detachStreamAudio(identity, source);
    },
    onScreenShareStopped: () => {
      this.detachMedia("local-screen");
      this.update({ screenShareEnabled: false, screenShareAudioEnabled: false });
      void this.playEventTone("media-stop");
    },
  });
  private streamParticipantIds = new Set<string>();
  private agoraParticipantIds = new Set<string>();
  private tencentParticipantIds = new Set<string>();
  private cloudflareParticipantIds = new Set<string>();
  private routing: RoomServiceRouting = legacyRoomServiceRouting(liveKitUrl);
  private attachmentAccessToken: string | undefined;
  private usageAccessToken: string | undefined;
  private usageWindowStartedAt: number | undefined;
  private usageReportTimer: number | undefined;
  private attachedMediaElements = new Set<HTMLMediaElement>();
  private remoteVoiceAudio = new Map<string, Set<HTMLAudioElement>>();
  private remoteStreamAudio = new Map<string, Set<HTMLAudioElement>>();
  private remoteMediaQuality = new Map<
    string,
    Partial<Record<"camera" | "screen", MediaQuality>>
  >();
  private selectedRemoteQuality = new Map<string, MediaQuality>();
  private watchedMedia = new Set<string>();
  private remoteMediaState = new Map<
    string,
    { camera: boolean; screen: boolean }
  >();
  private outputVolume = 1;
  private toneContext: AudioContext | null = null;
  private noiseCancellationEnabled =
    localStorage.getItem("mhtalk.audio.noise-cancellation") !== "false";
  private inviteCode: string | undefined;
  private preferredDevices: Partial<Record<MediaDeviceKind, string>> = {
    audioinput: localStorage.getItem("mhtalk.device.audioinput") || "",
    audiooutput: localStorage.getItem("mhtalk.device.audiooutput") || "",
    videoinput: localStorage.getItem("mhtalk.device.videoinput") || "",
  };
  private readonly rtcAdapters = new RtcAdapterRegistry([
    {
      provider: "stream",
      connect: (credentials) => this.joinStream(credentials),
    },
    {
      provider: "agora",
      connect: (credentials) => this.joinAgora(credentials),
    },
    {
      provider: "tencent",
      connect: (credentials) => this.joinTencent(credentials),
    },
    {
      provider: "cloudflare-realtime",
      connect: (credentials) => this.joinCloudflare(credentials),
    },
    {
      provider: "100ms",
      connect: (credentials) => this.joinEmbedded(credentials),
    },
    {
      provider: "cometchat",
      connect: (credentials) => this.joinEmbedded(credentials),
    },
    {
      provider: "whereby",
      connect: (credentials) => this.joinWhereby(credentials),
    },
    {
      provider: "jaas",
      connect: (credentials) => this.joinEmbedded(credentials),
    },
    {
      provider: "mirotalk",
      connect: (credentials) => this.joinEmbedded(credentials),
    },
    {
      provider: "videosdk",
      connect: (credentials) => this.joinEmbedded(credentials),
    },
    {
      provider: "daily",
      connect: (credentials) => this.joinDaily(credentials),
    },
    {
      provider: "livekit",
      connect: (credentials) =>
        this.joinLiveKit(credentials.roomName, credentials),
    },
  ]);

  subscribe(listener: SessionListener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeChat(listener: ChatListener) {
    this.chatListeners.add(listener);
    listener(this.chat);
    return () => {
      this.chatListeners.delete(listener);
    };
  }

  async join(roomName: string, inviteCode?: string) {
    if (
      this.snapshot.state === "connecting" ||
      this.snapshot.state === "connected" ||
      this.snapshot.state === "recovering"
    )
      return;
    // Creating/resuming the context while handling the user's click keeps
    // later participant events audible in WebViews with autoplay policies.
    void this.unlockEventAudio().catch(() => undefined);
    this.update({
      state: "connecting",
      roomName,
      recoveryAttempt: 0,
      lastRecoveryMs: null,
      connectionMessage: "Selecting the best available server…",
    });
    this.inviteCode = inviteCode;
    try {
      if (this.isLiveKitConfigured()) await this.joinRealtime(roomName);
      else await this.joinSimulator();
    } catch (error) {
      await this.stopUsageReporting(false);
      await this.room?.disconnect().catch(() => undefined);
      await this.streamRtc.disconnect();
      await this.agoraRtc.disconnect();
      await this.tencentRtc.disconnect();
      await this.cloudflareRtc.disconnect();
      this.room = null;
      this.update({
        state: "failed",
        connectionMessage: error instanceof Error
          ? error.message
          : "Could not connect to a realtime server",
      });
    }
  }

  async createPrivateRoom() {
    const response = await fetch(new URL("/private-room", liveKitTokenEndpoint), {
      method: "POST",
      headers: accountSession.getAccessToken()
        ? { authorization: `Bearer ${accountSession.getAccessToken()}` }
        : undefined,
    });
    const payload = (await response.json()) as {
      roomName?: string;
      code?: string;
    };
    if (!response.ok || !payload.roomName || !payload.code)
      throw new Error("Could not create private room");
    return { roomName: payload.roomName, code: payload.code };
  }

  async leave() {
    window.clearTimeout(this.recoveryTimer);
    await this.stopUsageReporting(true);
    await this.room?.disconnect();
    await this.streamRtc.disconnect();
    await this.agoraRtc.disconnect();
    await this.tencentRtc.disconnect();
    await this.cloudflareRtc.disconnect();
    this.room = null;
    this.inviteCode = undefined;
    this.attachmentAccessToken = undefined;
    this.remoteProfiles.clear();
    this.remoteMediaQuality.clear();
    this.remoteMediaState.clear();
    this.selectedRemoteQuality.clear();
    this.watchedMedia.clear();
    this.streamParticipantIds.clear();
    this.agoraParticipantIds.clear();
    this.tencentParticipantIds.clear();
    this.cloudflareParticipantIds.clear();
    this.detachMedia();
    this.clearChat();
    this.update({ ...initialSnapshot });
  }

  async setMicrophoneEnabled(microphoneEnabled: boolean) {
    this.update({ microphoneEnabled });
    if (this.cloudflareRtc.connected) {
      await this.cloudflareRtc.setMicrophoneEnabled(microphoneEnabled);
      return;
    }
    if (this.tencentRtc.connected) {
      await this.tencentRtc.setMicrophoneEnabled(
        microphoneEnabled,
        this.noiseCancellationEnabled,
      );
      return;
    }
    if (this.agoraRtc.connected) {
      await this.agoraRtc.setMicrophoneEnabled(
        microphoneEnabled,
        this.noiseCancellationEnabled,
      );
      return;
    }
    if (this.streamRtc.call) {
      await this.streamRtc.setMicrophoneEnabled(microphoneEnabled);
      return;
    }
    if (this.room) {
      await this.room.localParticipant.setMicrophoneEnabled(
        microphoneEnabled,
        microphoneEnabled ? this.microphoneCaptureOptions() : undefined,
      );
    }
  }

  getNoiseCancellationEnabled() {
    return this.noiseCancellationEnabled;
  }

  async setNoiseCancellationEnabled(enabled: boolean) {
    this.noiseCancellationEnabled = enabled;
    localStorage.setItem("mhtalk.audio.noise-cancellation", String(enabled));
    if (this.cloudflareRtc.connected) return;
    if (this.tencentRtc.connected) {
      await this.tencentRtc.setNoiseCancellationEnabled(enabled);
      return;
    }
    if (this.agoraRtc.connected) {
      await this.agoraRtc.setNoiseCancellationEnabled(enabled);
      return;
    }
    if (this.streamRtc.call) {
      await this.streamRtc.setNoiseCancellationEnabled(enabled);
      return;
    }
    if (!this.room || !this.snapshot.microphoneEnabled) return;
    const track = this.room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.track;
    if (track instanceof LocalAudioTrack) {
      await track.restartTrack(this.microphoneCaptureOptions());
    }
  }

  async setCameraEnabled(cameraEnabled: boolean) {
    if (this.cloudflareRtc.connected) {
      try {
        await this.cloudflareRtc.setCameraEnabled(
          cameraEnabled,
          this.routing.subscription.entitlements.maxCameraQuality,
          this.preferredDevices.videoinput,
        );
        if (!cameraEnabled) this.detachMedia("local-camera");
        this.update({ cameraEnabled });
      } catch {
        this.detachMedia("local-camera");
        this.update({ cameraEnabled: false });
      }
      return;
    }
    if (this.tencentRtc.connected) {
      try {
        await this.tencentRtc.setCameraEnabled(
          cameraEnabled,
          this.routing.subscription.entitlements.maxCameraQuality,
          this.preferredDevices.videoinput,
        );
        if (!cameraEnabled) this.detachMedia("local-camera");
        this.update({ cameraEnabled });
      } catch {
        this.detachMedia("local-camera");
        this.update({ cameraEnabled: false });
      }
      return;
    }
    if (this.agoraRtc.connected) {
      try {
        await this.agoraRtc.setCameraEnabled(
          cameraEnabled,
          this.routing.subscription.entitlements.maxCameraQuality,
          this.preferredDevices.videoinput,
        );
        if (!cameraEnabled) this.detachMedia("local-camera");
        this.update({ cameraEnabled });
      } catch {
        this.detachMedia("local-camera");
        this.update({ cameraEnabled: false });
      }
      return;
    }
    if (this.streamRtc.call) {
      try {
        await this.streamRtc.setCameraEnabled(
          cameraEnabled,
          this.routing.subscription.entitlements.maxCameraQuality,
        );
        if (!cameraEnabled) this.detachMedia("local-camera");
        this.update({ cameraEnabled });
      } catch {
        this.detachMedia("local-camera");
        this.update({ cameraEnabled: false });
      }
      return;
    }
    if (!this.room) {
      this.update({ cameraEnabled });
      return;
    }
    if (!cameraEnabled) {
      await this.room.localParticipant.setCameraEnabled(false);
      this.detachMedia("local-camera");
      this.update({ cameraEnabled: false });
      return;
    }
    try {
      const deviceId = this.preferredDevices.videoinput;
      const maximum = this.routing.subscription.entitlements.maxCameraQuality;
      const preset = maximum === "high" ? VideoPresets.h1080 : VideoPresets.h720;
      await this.room.localParticipant.setCameraEnabled(
        true,
        {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          resolution: preset.resolution,
        },
        {
          videoEncoding: preset.encoding,
          simulcast: true,
        },
      );
      this.update({ cameraEnabled: true });
    } catch {
      this.detachMedia("local-camera");
      this.update({ cameraEnabled: false });
    }
  }

  async setScreenShareEnabled(
    enabled: boolean,
    quality: MediaQuality = "medium",
  ) {
    if (this.cloudflareRtc.connected) {
      try {
        quality = limitMediaQuality(
          quality,
          this.routing.subscription.entitlements.maxScreenShareQuality,
        );
        await this.cloudflareRtc.setScreenShareEnabled(enabled, quality);
        if (!enabled) this.detachMedia("local-screen");
        if (enabled) localStorage.setItem("mhtalk.share-quality", quality);
        this.update({ screenShareEnabled: enabled, screenShareAudioEnabled: enabled });
        if (enabled) await this.publishMediaQuality("screen", quality);
      } catch {
        this.detachMedia("local-screen");
        this.update({ screenShareEnabled: false, screenShareAudioEnabled: false });
      }
      return;
    }
    if (this.tencentRtc.connected) {
      try {
        quality = limitMediaQuality(
          quality,
          this.routing.subscription.entitlements.maxScreenShareQuality,
        );
        await this.tencentRtc.setScreenShareEnabled(enabled, quality);
        if (!enabled) this.detachMedia("local-screen");
        if (enabled) localStorage.setItem("mhtalk.share-quality", quality);
        this.update({
          screenShareEnabled: enabled,
          screenShareAudioEnabled: enabled,
        });
        if (enabled) await this.publishMediaQuality("screen", quality);
      } catch {
        this.detachMedia("local-screen");
        this.update({ screenShareEnabled: false, screenShareAudioEnabled: false });
      }
      return;
    }
    if (this.agoraRtc.connected) {
      try {
        quality = limitMediaQuality(
          quality,
          this.routing.subscription.entitlements.maxScreenShareQuality,
        );
        await this.agoraRtc.setScreenShareEnabled(enabled, quality);
        if (!enabled) this.detachMedia("local-screen");
        if (enabled) localStorage.setItem("mhtalk.share-quality", quality);
        this.update({
          screenShareEnabled: enabled,
          screenShareAudioEnabled: enabled,
        });
        if (enabled) await this.publishMediaQuality("screen", quality);
      } catch {
        this.detachMedia("local-screen");
        this.update({ screenShareEnabled: false, screenShareAudioEnabled: false });
      }
      return;
    }
    if (this.streamRtc.call) {
      try {
        quality = limitMediaQuality(
          quality,
          this.routing.subscription.entitlements.maxScreenShareQuality,
        );
        await this.streamRtc.setScreenShareEnabled(enabled, quality);
        if (!enabled) this.detachMedia("local-screen");
        if (enabled) localStorage.setItem("mhtalk.share-quality", quality);
        this.update({
          screenShareEnabled: enabled,
          screenShareAudioEnabled: false,
        });
      } catch {
        this.detachMedia("local-screen");
        this.update({
          screenShareEnabled: false,
          screenShareAudioEnabled: false,
        });
      }
      return;
    }
    if (!this.room) return;
    if (!enabled) {
      await this.room.localParticipant.setScreenShareEnabled(false);
      this.detachMedia("local-screen");
      this.update({
        screenShareEnabled: false,
        screenShareAudioEnabled: false,
      });
      return;
    }
    try {
      quality = limitMediaQuality(
        quality,
        this.routing.subscription.entitlements.maxScreenShareQuality,
      );
      const preset =
        quality === "low"
          ? ScreenSharePresets.h360fps15
          : quality === "high"
            ? ScreenSharePresets.h1080fps30
            : ScreenSharePresets.h720fps15;
      const layers =
        quality === "high"
          ? [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps15]
          : quality === "medium"
            ? [ScreenSharePresets.h360fps15]
            : [];
      await this.room.localParticipant.setScreenShareEnabled(
        true,
        {
          video: true,
          resolution: preset.resolution,
          // The operating-system picker remains the source of truth for whether
          // computer audio is shared. Never run voice processing over media.
          audio: {
            restrictOwnAudio: true,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          systemAudio: "include",
          selfBrowserSurface: "exclude",
          suppressLocalAudioPlayback: true,
          contentHint: "detail",
        },
        {
          simulcast: layers.length > 0,
          screenShareEncoding: preset.encoding,
          screenShareSimulcastLayers: layers,
          degradationPreference: "maintain-resolution",
        },
      );
      localStorage.setItem("mhtalk.share-quality", quality);
      await this.publishMediaQuality("screen", quality);
      const screenAudio = this.room.localParticipant.getTrackPublication(
        Track.Source.ScreenShareAudio,
      );
      this.update({
        screenShareEnabled: true,
        screenShareAudioEnabled: Boolean(screenAudio && !screenAudio.isMuted),
      });
    } catch {
      this.update({
        screenShareEnabled: false,
        screenShareAudioEnabled: false,
      });
    }
  }

  async sendChatMessage(body: string, replyTo?: ChatMessage["replyTo"]) {
    const text = await this.filterMainTextWithServer(body.trim());
    if (!text || (!this.room && !this.streamRtc.call && !this.agoraRtc.connected && !this.tencentRtc.connected && !this.cloudflareRtc.connected)) return;
    const message = {
      id: crypto.randomUUID(),
      body: text,
      createdAt: Date.now(),
      replyTo,
    };
    await this.sendProviderEvent({ type: "chat", ...message }, true);
    this.addChat({ ...message, sender: this.profile.name, mine: true });
  }

  async editChatMessage(id: string, body: string) {
    const text = await this.filterMainTextWithServer(body.trim());
    if (!text || (!this.room && !this.streamRtc.call && !this.agoraRtc.connected && !this.tencentRtc.connected && !this.cloudflareRtc.connected)) return;
    await this.sendProviderEvent({ type: "edit", id, body: text }, true);
    this.patchChat(id, { body: text });
  }

  async deleteChatMessage(id: string) {
    if (!this.room && !this.streamRtc.call && !this.agoraRtc.connected && !this.tencentRtc.connected && !this.cloudflareRtc.connected) return;
    const storedAttachment = this.chat.messages.find((message) => message.id === id && message.mine)?.attachment?.storageId;
    await this.sendProviderEvent({ type: "delete", id }, true);
    this.patchChat(id, {
      deleted: true,
      body: undefined,
      attachment: undefined,
    });
    if (storedAttachment) {
      void this.attachmentApi("/attachments/delete", { attachmentId: storedAttachment }).catch(() => undefined);
    }
  }

  async setProfile(profile: UserProfile) {
    this.profile = sanitizeProfile(profile);
    localStorage.setItem("mhtalk.profile.name", this.profile.name);
    localStorage.setItem("mhtalk.profile.bio", this.profile.bio);
    localStorage.setItem("mhtalk.profile.avatar", this.profile.avatar);
    if (this.profile.username) localStorage.setItem("mhtalk.profile.username", this.profile.username);
    else localStorage.removeItem("mhtalk.profile.username");
    localStorage.setItem("mhtalk.profile.username-visible", String(this.profile.usernameVisible !== false));
    await this.publishProfile();
  }

  getProfile() {
    return this.profile;
  }

  getEventSoundSettings(): EventSoundSettings {
    return {
      presence: localStorage.getItem("mhtalk.sound.presence") !== "false",
      media: localStorage.getItem("mhtalk.sound.media") !== "false",
    };
  }

  setEventSoundEnabled(kind: EventSoundKind, enabled: boolean) {
    localStorage.setItem(`mhtalk.sound.${kind}`, String(enabled));
    if (enabled) {
      void this.playEventTone(kind === "presence" ? "join" : "media-start");
    }
  }

  showLocalMedia(source: "camera" | "screen") {
    if (this.cloudflareRtc.connected) {
      const stream = this.cloudflareRtc.mediaStream("local", source);
      if (!stream) return false;
      this.attachStreamVideo(
        stream,
        source === "camera" ? "local-camera" : "local-screen",
        source === "camera" ? "Your camera" : "Your stream",
        "local",
        source,
      );
      return true;
    }
    if (this.tencentRtc.connected) {
      const stream = this.tencentRtc.mediaStream("local", source);
      if (!stream) return false;
      this.attachStreamVideo(
        stream,
        source === "camera" ? "local-camera" : "local-screen",
        source === "camera" ? "Your camera" : "Your stream",
        "local",
        source,
      );
      return true;
    }
    if (this.agoraRtc.connected) {
      const stream = this.agoraRtc.mediaStream("local", source);
      if (!stream) return false;
      this.attachStreamVideo(
        stream,
        source === "camera" ? "local-camera" : "local-screen",
        source === "camera" ? "Your camera" : "Your stream",
        "local",
        source,
      );
      return true;
    }
    if (this.streamRtc.call) {
      const participant = this.streamRtc.localParticipant;
      const stream = source === "camera"
        ? participant?.videoStream
        : participant?.screenShareStream;
      if (!stream) return false;
      this.attachStreamVideo(
        stream,
        source === "camera" ? "local-camera" : "local-screen",
        source === "camera" ? "Your camera" : "Your stream",
        "local",
        source,
      );
      return true;
    }
    const trackSource =
      source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare;
    const publication = this.room?.localParticipant.getTrackPublication(trackSource);
    if (!publication?.track || publication.isMuted) return false;
    this.attachLocalVideo(
      trackSource,
      source === "camera" ? "Your camera" : "Your stream",
    );
    return true;
  }

  hideLocalMedia(source: "camera" | "screen") {
    this.detachMedia(source === "camera" ? "local-camera" : "local-screen");
  }

  async watchParticipantMedia(
    identity: string,
    source: "camera" | "screen",
    requestedQuality: MediaQuality = "medium",
  ) {
    if (this.cloudflareRtc.connected) {
      const maximum = this.getParticipantMaximumQuality(identity, source);
      const quality = capQuality(requestedQuality, maximum);
      this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
      this.watchedMedia.add(`${identity}:${source}`);
      const available = await this.cloudflareRtc.watch(identity, source, quality);
      const stream = this.cloudflareRtc.mediaStream(identity, source);
      if (stream) {
        this.attachStreamVideo(
          stream,
          `cloudflare-${source}-${identity}`,
          source === "camera" ? "Camera" : "Screen share",
          identity,
          source,
        );
      }
      return available;
    }
    if (this.tencentRtc.connected) {
      const maximum = this.getParticipantMaximumQuality(identity, source);
      const quality = capQuality(requestedQuality, maximum);
      this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
      this.watchedMedia.add(`${identity}:${source}`);
      const available = await this.tencentRtc.watch(identity, source, quality);
      const stream = this.tencentRtc.mediaStream(identity, source);
      if (stream) {
        this.attachStreamVideo(
          stream,
          `tencent-${source}-${identity}`,
          source === "camera" ? "Camera" : "Screen share",
          identity,
          source,
        );
      }
      return available;
    }
    if (this.agoraRtc.connected) {
      const maximum = this.getParticipantMaximumQuality(identity, source);
      const quality = capQuality(requestedQuality, maximum);
      this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
      this.watchedMedia.add(`${identity}:${source}`);
      const available = await this.agoraRtc.watch(identity, source, quality);
      const stream = this.agoraRtc.mediaStream(identity, source);
      if (stream) {
        this.attachStreamVideo(
          stream,
          `agora-${source}-${identity}`,
          source === "camera" ? "Camera" : "Screen share",
          identity,
          source,
        );
      }
      return available;
    }
    if (this.streamRtc.call) {
      const participant = this.streamRtc.participant(identity);
      if (!participant) return false;
      const maximum = this.getParticipantMaximumQuality(identity, source);
      const quality = capQuality(requestedQuality, maximum);
      this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
      this.watchedMedia.add(`${identity}:${source}`);
      this.streamRtc.setParticipantVideoQuality(identity, quality);
      this.syncStreamParticipants(this.streamRtc.participants);
      return source === "camera"
        ? streamPublishes(participant, StreamTrackType.VIDEO)
        : streamPublishes(participant, StreamTrackType.SCREEN_SHARE);
    }
    const participant = this.room?.remoteParticipants.get(identity);
    if (!participant) return false;
    const publication = participant.getTrackPublication(
      source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare,
    );
    if (!(publication instanceof RemoteTrackPublication)) return false;
    const maximum = this.getParticipantMaximumQuality(identity, source);
    const quality = capQuality(requestedQuality, maximum);
    this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
    this.watchedMedia.add(`${identity}:${source}`);
    publication.setVideoQuality(
      qualityValue[quality] as Parameters<
        RemoteTrackPublication["setVideoQuality"]
      >[0],
    );
    publication.setSubscribed(true);
    if (source === "screen") {
      const audio = participant.getTrackPublication(
        Track.Source.ScreenShareAudio,
      );
      if (audio instanceof RemoteTrackPublication) audio.setSubscribed(true);
    }
    return true;
  }

  stopWatchingParticipantMedia(
    identity: string,
    source: "camera" | "screen",
  ) {
    this.watchedMedia.delete(`${identity}:${source}`);
    if (this.cloudflareRtc.connected) {
      void this.cloudflareRtc.unwatch(identity, source);
      this.detachParticipantSource(identity, source);
      return;
    }
    if (this.tencentRtc.connected) {
      void this.tencentRtc.unwatch(identity, source);
      this.detachParticipantSource(identity, source);
      return;
    }
    if (this.agoraRtc.connected) {
      void this.agoraRtc.unwatch(identity, source);
      this.detachParticipantSource(identity, source);
      return;
    }
    if (this.streamRtc.call) {
      const stillWatching = (["camera", "screen"] as const).some((item) =>
        this.watchedMedia.has(`${identity}:${item}`),
      );
      if (!stillWatching) this.streamRtc.setParticipantVideoQuality(identity);
      this.detachParticipantSource(identity, source);
      return;
    }
    const participant = this.room?.remoteParticipants.get(identity);
    const publication = participant?.getTrackPublication(
      source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare,
    );
    if (publication instanceof RemoteTrackPublication)
      publication.setSubscribed(false);
    if (source === "screen") {
      const audio = participant?.getTrackPublication(
        Track.Source.ScreenShareAudio,
      );
      if (audio instanceof RemoteTrackPublication) audio.setSubscribed(false);
    }
    this.detachParticipantSource(identity, source);
  }

  setParticipantVideoQuality(
    identity: string,
    source: "camera" | "screen",
    requestedQuality: MediaQuality,
  ) {
    if (this.cloudflareRtc.connected) {
      const quality = capQuality(
        requestedQuality,
        this.getParticipantMaximumQuality(identity, source),
      );
      this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
      this.cloudflareRtc.setVideoQuality(identity, source, quality);
      return;
    }
    if (this.tencentRtc.connected) {
      const quality = capQuality(
        requestedQuality,
        this.getParticipantMaximumQuality(identity, source),
      );
      this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
      void this.tencentRtc.setVideoQuality(identity, source, quality);
      return;
    }
    if (this.agoraRtc.connected) {
      const quality = capQuality(
        requestedQuality,
        this.getParticipantMaximumQuality(identity, source),
      );
      this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
      void this.agoraRtc.setVideoQuality(identity, source, quality);
      return;
    }
    if (this.streamRtc.call) {
      const quality = capQuality(
        requestedQuality,
        this.getParticipantMaximumQuality(identity, source),
      );
      this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
      this.streamRtc.setParticipantVideoQuality(identity, quality);
      return;
    }
    const participant = this.room?.remoteParticipants.get(identity);
    const publication = participant?.getTrackPublication(
      source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare,
    );
    if (!(publication instanceof RemoteTrackPublication)) return;
    const quality = capQuality(
      requestedQuality,
      this.getParticipantMaximumQuality(identity, source),
    );
    this.selectedRemoteQuality.set(`${identity}:${source}`, quality);
    publication.setVideoQuality(
      qualityValue[quality] as Parameters<
        RemoteTrackPublication["setVideoQuality"]
      >[0],
    );
  }

  getParticipantMaximumQuality(
    identity: string,
    source: "camera" | "screen",
  ): MediaQuality {
    const announced = this.remoteMediaQuality.get(identity)?.[source];
    if (announced) return announced;
    if (this.cloudflareRtc.connected) return "high";
    if (this.tencentRtc.connected) {
      return inferQuality(this.tencentRtc.mediaHeight(identity, source));
    }
    if (this.agoraRtc.connected) {
      return inferQuality(this.agoraRtc.mediaHeight(identity, source));
    }
    if (this.streamRtc.call) {
      const participant = this.streamRtc.participant(identity);
      const stream = source === "camera"
        ? participant?.videoStream
        : participant?.screenShareStream;
      return inferQuality(stream?.getVideoTracks()[0]?.getSettings().height);
    }
    const participant = this.room?.remoteParticipants.get(identity);
    const publication = participant?.getTrackPublication(
      source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare,
    );
    return inferQuality(publication?.dimensions?.height);
  }

  async setDevice(kind: MediaDeviceKind, deviceId: string) {
    this.preferredDevices[kind] = deviceId;
    if (deviceId) localStorage.setItem(`mhtalk.device.${kind}`, deviceId);
    else localStorage.removeItem(`mhtalk.device.${kind}`);
    if (this.cloudflareRtc.connected) {
      await this.cloudflareRtc.selectDevice(kind, deviceId);
      return;
    }
    if (this.tencentRtc.connected) {
      await this.tencentRtc.selectDevice(kind, deviceId);
      return;
    }
    if (this.agoraRtc.connected) {
      await this.agoraRtc.selectDevice(kind, deviceId);
      return;
    }
    if (this.streamRtc.call) {
      await this.streamRtc.selectDevice(kind, deviceId);
      return;
    }
    if (this.room)
      await this.room.switchActiveDevice(
        kind,
        deviceId || "default",
        Boolean(deviceId) || kind !== "videoinput",
      );
    if (kind === "audioinput" && this.room && this.snapshot.microphoneEnabled) {
      const track = this.room.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      )?.track;
      if (track instanceof LocalAudioTrack) {
        await track.restartTrack(this.microphoneCaptureOptions());
      }
    }
  }

  setRemoteVolume(volume: number) {
    this.outputVolume = Math.max(0, Math.min(1, volume));
    new Set([
      ...this.remoteVoiceAudio.keys(),
      ...this.remoteStreamAudio.keys(),
      ...this.tencentParticipantIds,
      ...this.cloudflareParticipantIds,
    ]).forEach((identity) => this.applyParticipantVolumes(identity));
  }

  getParticipantVolumes(identity: string) {
    const voice = Number(
      localStorage.getItem(`mhtalk.volume.voice.${identity}`) ?? "100",
    );
    const stream = Number(
      localStorage.getItem(`mhtalk.volume.stream.${identity}`) ?? "100",
    );
    return {
      voice: Number.isFinite(voice) ? Math.max(0, Math.min(100, voice)) : 100,
      stream: Number.isFinite(stream)
        ? Math.max(0, Math.min(100, stream))
        : 100,
    };
  }

  setParticipantVoiceVolume(identity: string, volume: number) {
    localStorage.setItem(`mhtalk.volume.voice.${identity}`, String(volume));
    this.applyParticipantVolumes(identity);
  }

  setParticipantStreamVolume(identity: string, volume: number) {
    localStorage.setItem(`mhtalk.volume.stream.${identity}`, String(volume));
    this.applyParticipantVolumes(identity);
  }

  async sendFile(
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ) {
    if (this.routing.files.provider === "supabase-storage") {
      await this.sendStoredFile(file, onProgress, signal);
      return;
    }
    if (!this.room) return;
    const maximum = this.routing.subscription.entitlements.maxAttachmentBytes;
    if (file.size > maximum) {
      throw new Error(
        `${this.routing.subscription.tier === "plus" ? "MHTalk Plus" : "Free accounts"} can send files up to ${formatAttachmentLimit(maximum)}.`,
      );
    }
    const id = crypto.randomUUID();
    const kind = attachmentKind(file.type);
    const localUrl = URL.createObjectURL(file);
    this.objectUrls.add(localUrl);
    const writer = await this.room.localParticipant.streamBytes({
      streamId: id,
      name: file.name,
      topic: "mhtalk.file",
      mimeType: file.type || "application/octet-stream",
      totalSize: file.size,
    });
    const chunkSize = 32 * 1024;
    try {
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        if (signal?.aborted)
          throw new DOMException("Transfer cancelled", "AbortError");
        await writer.write(
          new Uint8Array(
            await file
              .slice(offset, Math.min(offset + chunkSize, file.size))
              .arrayBuffer(),
          ),
        );
        onProgress?.(Math.min(1, (offset + chunkSize) / file.size));
      }
      await writer.close();
      if (signal?.aborted)
        throw new DOMException("Transfer cancelled", "AbortError");
      this.addChat({
        id,
        sender: this.profile.name,
        createdAt: Date.now(),
        mine: true,
        attachment: {
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          url: localUrl,
          kind,
        },
      });
    } catch (error) {
      URL.revokeObjectURL(localUrl);
      this.objectUrls.delete(localUrl);
      throw error;
    }
  }

  private async attachmentApi<T>(path: string, value: Record<string, unknown>) {
    const accountToken = accountSession.getAccessToken();
    if (!accountToken || !this.attachmentAccessToken) {
      throw new Error("Rejoin the room before sending or opening attachments.");
    }
    const response = await fetch(new URL(path, liveKitTokenEndpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accountToken}`,
      },
      body: JSON.stringify({
        ...value,
        roomAccessToken: this.attachmentAccessToken,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Attachment service is unavailable");
    return payload;
  }

  private uploadSignedFile(
    uploadUrl: string,
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ) {
    return new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      const abort = () => request.abort();
      signal?.addEventListener("abort", abort, { once: true });
      request.open("PUT", uploadUrl);
      request.setRequestHeader("content-type", file.type || "application/octet-stream");
      request.setRequestHeader("x-upsert", "false");
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };
      request.onerror = () => reject(new Error("Attachment upload failed"));
      request.onabort = () => reject(new DOMException("Transfer cancelled", "AbortError"));
      request.onload = () => {
        signal?.removeEventListener("abort", abort);
        if (request.status >= 200 && request.status < 300) resolve();
        else reject(new Error("Attachment storage rejected the upload"));
      };
      request.send(file);
    });
  }

  private async sendStoredFile(
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
  ) {
    const maximum = this.routing.subscription.entitlements.maxAttachmentBytes;
    if (file.size > maximum) {
      throw new Error(
        `${this.routing.subscription.tier === "plus" ? "MHTalk Plus" : "Free accounts"} can send files up to ${formatAttachmentLimit(maximum)}.`,
      );
    }
    const ticket = await this.attachmentApi<{
      attachmentId: string;
      uploadUrl: string;
      fileName: string;
      mimeType: string;
      size: number;
      expiresAt: string;
    }>("/attachments/upload-ticket", {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    });
    await this.uploadSignedFile(ticket.uploadUrl, file, onProgress, signal);
    const attachment = await this.attachmentApi<{
      attachmentId: string;
      fileName: string;
      mimeType: string;
      size: number;
      expiresAt: string;
    }>("/attachments/complete", { attachmentId: ticket.attachmentId });
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    await this.sendProviderEvent({
      type: "attachment",
      id,
      createdAt,
      attachment: {
        id: attachment.attachmentId,
        name: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
      },
    }, true);
    const localUrl = URL.createObjectURL(file);
    this.objectUrls.add(localUrl);
    this.addChat({
      id,
      sender: this.profile.name,
      createdAt,
      mine: true,
      attachment: {
        storageId: attachment.attachmentId,
        name: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        url: localUrl,
        kind: attachmentKind(attachment.mimeType),
      },
    });
  }

  private async receiveStoredAttachment(
    identity: string,
    event: { id: string; createdAt: number; attachment: { id: string; name: string; mimeType: string; size: number } },
  ) {
    try {
      const download = await this.attachmentApi<{
        downloadUrl: string;
        fileName: string;
        mimeType: string;
        size: number;
      }>("/attachments/download-ticket", { attachmentId: event.attachment.id });
      this.addChat({
        id: event.id,
        sender: this.remoteProfiles.get(identity)?.name || identity.slice(0, 16),
        senderIdentity: identity,
        createdAt: event.createdAt,
        mine: false,
        attachment: {
          storageId: event.attachment.id,
          name: download.fileName,
          mimeType: download.mimeType,
          size: download.size,
          url: download.downloadUrl,
          kind: attachmentKind(download.mimeType),
        },
      });
    } catch {
      /* A failed or expired attachment must not disconnect the call. */
    }
  }

  setTyping(typing: boolean) {
    if (!this.room && !this.streamRtc.call && !this.agoraRtc.connected && !this.tencentRtc.connected && !this.cloudflareRtc.connected) return;
    window.clearTimeout(this.typingTimer);
    void this.sendProviderEvent({ type: "typing", typing }, false);
    if (typing)
      this.typingTimer = window.setTimeout(() => this.setTyping(false), 1400);
  }

  /** Development-only fault injection. Real LiveKit reconnects use the same states. */
  simulateTransientDrop() {
    if (this.snapshot.state !== "connected" || this.room || this.streamRtc.call || this.agoraRtc.connected || this.tencentRtc.connected || this.cloudflareRtc.connected) return;
    this.beginRecovery();
    this.recoveryTimer = window.setTimeout(
      () => this.finishRecovery(),
      500 + Math.round(Math.random() * 250),
    );
  }

  private async joinSimulator() {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
    this.update({ state: "connected" });
  }

  private async joinRealtime(roomName: string) {
    if (import.meta.env.VITE_LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID) {
      await this.joinLiveKit(roomName);
      return;
    }
    const credentials = await this.fetchToken(roomName);
    this.routing = credentials.routing;
    this.attachmentAccessToken = credentials.attachmentAccessToken;
    await this.rtcAdapters.connect(credentials);
    this.startUsageReporting(credentials.usageAccessToken);
  }

  private startUsageReporting(token?: string) {
    window.clearInterval(this.usageReportTimer);
    this.usageAccessToken = token;
    this.usageWindowStartedAt = token ? Date.now() : undefined;
    if (!token) return;
    this.usageReportTimer = window.setInterval(() => {
      void this.reportRtcUsage();
    }, 60_000);
  }

  private async stopUsageReporting(flush: boolean) {
    window.clearInterval(this.usageReportTimer);
    this.usageReportTimer = undefined;
    if (flush) await this.reportRtcUsage(true).catch(() => undefined);
    this.usageAccessToken = undefined;
    this.usageWindowStartedAt = undefined;
  }

  private async reportRtcUsage(leaving = false) {
    const usageAccessToken = this.usageAccessToken;
    const measuredFromMs = this.usageWindowStartedAt;
    const measuredToMs = Date.now();
    if (!usageAccessToken || !measuredFromMs || measuredToMs - measuredFromMs < 10_000) return;
    this.usageWindowStartedAt = measuredToMs;
    await fetch(new URL("/rtc/usage", liveKitTokenEndpoint), {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        usageAccessToken,
        reportId: crypto.randomUUID(),
        measuredFrom: new Date(measuredFromMs).toISOString(),
        measuredTo: new Date(measuredToMs).toISOString(),
        leaving,
      }),
    });
  }

  private async joinStream(credentials: RoomConnectionCredentials) {
    this.routing = credentials.routing;
    await this.streamRtc.connect(
      credentials,
      this.profile,
      this.snapshot.microphoneEnabled,
      async () => {
        const refreshed = await this.fetchToken(credentials.roomName, ["stream"]);
        if (refreshed.routing.rtc.provider !== "stream") {
          throw new Error("The active Stream room could not refresh its access token");
        }
        return refreshed.token;
      },
    );
    this.update({
      state: "connected",
      roomName: credentials.roomName,
      rtcProvider: "stream",
      embeddedCallUrl: null,
      connectionMessage: null,
    });
    await Promise.allSettled([this.publishProfile(), this.requestProfiles()]);
    this.syncStreamParticipants(this.streamRtc.participants);
  }

  private async joinAgora(credentials: RoomConnectionCredentials) {
    this.routing = credentials.routing;
    await this.agoraRtc.connect(
      credentials,
      this.snapshot.microphoneEnabled,
      this.noiseCancellationEnabled,
      async () => {
        const refreshed = await this.fetchToken(credentials.roomName, ["agora"]);
        if (refreshed.routing.rtc.provider !== "agora") {
          throw new Error("The active Agora room could not refresh its access token");
        }
        return refreshed;
      },
    );
    this.update({
      state: "connected",
      roomName: credentials.roomName,
      rtcProvider: "agora",
      embeddedCallUrl: null,
      connectionMessage: null,
    });
    await Promise.allSettled([this.publishProfile(), this.requestProfiles()]);
    this.syncAgoraParticipants(this.agoraRtc.participants);
  }

  private async joinTencent(credentials: RoomConnectionCredentials) {
    this.routing = credentials.routing;
    await this.tencentRtc.connect(
      credentials,
      this.snapshot.microphoneEnabled,
      this.noiseCancellationEnabled,
    );
    this.update({
      state: "connected",
      roomName: credentials.roomName,
      rtcProvider: "tencent",
      embeddedCallUrl: null,
      connectionMessage: null,
    });
    await Promise.allSettled([this.publishProfile(), this.requestProfiles()]);
    this.syncTencentParticipants(this.tencentRtc.participants);
  }

  private async joinCloudflare(credentials: RoomConnectionCredentials) {
    this.routing = credentials.routing;
    await this.cloudflareRtc.connect(credentials, this.snapshot.microphoneEnabled);
    this.update({
      state: "connected",
      roomName: credentials.roomName,
      rtcProvider: "cloudflare-realtime",
      embeddedCallUrl: null,
      connectionMessage: null,
    });
    await Promise.allSettled([this.publishProfile(), this.requestProfiles()]);
    this.syncCloudflareParticipants(this.cloudflareRtc.participants);
  }

  private async joinDaily(credentials: RoomConnectionCredentials) {
    this.routing = credentials.routing;
    this.attachmentAccessToken = credentials.attachmentAccessToken;
    const callUrl = new URL(credentials.routing.rtc.serverUrl);
    callUrl.searchParams.set("t", credentials.token);
    callUrl.searchParams.set("userName", this.profile.name);
    callUrl.searchParams.set("mhtalk", "1");
    this.update({
      state: "connected",
      roomName: credentials.roomName,
      rtcProvider: "daily",
      embeddedCallUrl: callUrl.toString(),
      connectionMessage: null,
    });
  }

  private async joinWhereby(credentials: RoomConnectionCredentials) {
    this.routing = credentials.routing;
    this.attachmentAccessToken = credentials.attachmentAccessToken;
    const callUrl = new URL(credentials.routing.rtc.serverUrl);
    callUrl.searchParams.set("displayName", this.profile.name);
    callUrl.searchParams.set("skipMediaPermissionPrompt", "on");
    callUrl.searchParams.set("precallCeremony", "off");
    callUrl.searchParams.set("video", "off");
    this.update({
      state: "connected",
      roomName: credentials.roomName,
      rtcProvider: "whereby",
      embeddedCallUrl: callUrl.toString(),
      connectionMessage: null,
    });
  }

  private async joinEmbedded(credentials: RoomConnectionCredentials) {
    this.routing = credentials.routing;
    this.attachmentAccessToken = credentials.attachmentAccessToken;
    this.update({
      state: "connected",
      roomName: credentials.roomName,
      rtcProvider: credentials.routing.rtc.provider,
      embeddedCallUrl: credentials.routing.rtc.serverUrl,
      connectionMessage: null,
    });
  }

  private async joinLiveKit(
    roomName: string,
    suppliedCredentials?: RoomConnectionCredentials,
  ) {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    const syncParticipants = () => {
      const participants = [...room.remoteParticipants.values()].map(
        (participant) => {
          const camera = participant.getTrackPublication(Track.Source.Camera);
          const screen = participant.getTrackPublication(
            Track.Source.ScreenShare,
          );
          const media = {
            camera: Boolean(camera && !camera.isMuted),
            screen: Boolean(screen && !screen.isMuted),
          };
          const previous = this.remoteMediaState.get(participant.identity);
          if (previous) {
            if (
              (!previous.camera && media.camera) ||
              (!previous.screen && media.screen)
            ) {
              void this.playEventTone("media-start");
            } else if (
              (previous.camera && !media.camera) ||
              (previous.screen && !media.screen)
            ) {
              void this.playEventTone("media-stop");
            }
          }
          this.remoteMediaState.set(participant.identity, media);
          const dataProfile = this.remoteProfiles.get(participant.identity);
          const metadataProfile = parseParticipantProfile(
            participant.metadata,
            participant.name || participant.identity,
          );
          const dataAvatar = normalizeProfileAvatar(dataProfile?.avatar);
          const metadataAvatar = normalizeProfileAvatar(metadataProfile.avatar);
          const avatar =
            profileAvatarImageSource(dataAvatar) !== null
              ? dataAvatar
              : profileAvatarImageSource(metadataAvatar) !== null
                ? metadataAvatar
                : dataAvatar ||
                  metadataAvatar ||
                  profileInitial(
                    dataProfile?.name ||
                      metadataProfile.name ||
                      participant.identity,
                  );
          return {
            identity: participant.identity,
            speaking: participant.isSpeaking,
            microphoneEnabled: participant.isMicrophoneEnabled,
            cameraEnabled: media.camera,
            screenShareEnabled: media.screen,
            cameraQuality: this.getParticipantMaximumQuality(
              participant.identity,
              "camera",
            ),
            screenShareQuality: this.getParticipantMaximumQuality(
              participant.identity,
              "screen",
            ),
            name:
              dataProfile?.name ||
              metadataProfile.name ||
              participant.name ||
              participant.identity,
            bio: dataProfile?.bio || metadataProfile.bio || "",
            avatar,
            username: dataProfile?.username || metadataProfile.username,
            usernameVisible:
              dataProfile?.usernameVisible ?? metadataProfile.usernameVisible,
          };
        },
      );
      const activeIdentities = new Set(
        participants.map((participant) => participant.identity),
      );
      [...this.remoteMediaState.keys()].forEach((identity) => {
        if (!activeIdentities.has(identity)) this.remoteMediaState.delete(identity);
      });
      this.update({
        localSpeaking: room.localParticipant.isSpeaking,
        participants,
      });
    };
    room.on(RoomEvent.ParticipantConnected, () => {
      void this.playEventTone("join");
      syncParticipants();
      // A newcomer did not receive profile packets sent before they joined.
      // Re-announce the local profile so names, avatars and bios converge.
      void this.setProfile(this.profile);
      void this.requestProfiles();
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      void this.playEventTone("leave");
      this.detachParticipantSource(participant.identity, "camera");
      this.detachParticipantSource(participant.identity, "screen");
      this.remoteVoiceAudio.delete(participant.identity);
      this.remoteStreamAudio.delete(participant.identity);
      this.remoteProfiles.delete(participant.identity);
      this.remoteMediaQuality.delete(participant.identity);
      this.remoteMediaState.delete(participant.identity);
      syncParticipants();
    });
    room.on(RoomEvent.ParticipantMetadataChanged, syncParticipants);
    room.on(RoomEvent.TrackPublished, (publication, participant) => {
      const source =
        publication.source === Track.Source.Camera
          ? "camera"
          : publication.source === Track.Source.ScreenShare ||
              publication.source === Track.Source.ScreenShareAudio
            ? "screen"
            : null;
      if (
        publication.source === Track.Source.Microphone ||
        (source && this.watchedMedia.has(`${participant.identity}:${source}`))
      ) {
        publication.setSubscribed(true);
      } else {
        publication.setSubscribed(false);
      }
      syncParticipants();
    });
    room.on(RoomEvent.ActiveSpeakersChanged, syncParticipants);
    room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant !== room.localParticipant) return;
      this.update({
        connectionQuality: quality,
        estimatedDropPercent: estimatedDropPercent(quality),
      });
    });
    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.Camera) {
        this.detachMedia("local-camera");
        this.update({ cameraEnabled: false });
      }
      if (publication.source === Track.Source.ScreenShare) {
        this.detachMedia("local-screen");
        this.update({
          screenShareEnabled: false,
          screenShareAudioEnabled: false,
        });
      }
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Video) {
        const source =
          publication.source === Track.Source.ScreenShare ? "screen" : "camera";
        this.attachVideo(
          track,
          `remote-${publication.trackSid}`,
          source === "screen" ? "Screen share" : "Camera",
          participant.identity,
          source,
        );
        syncParticipants();
        return;
      }
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach() as HTMLAudioElement;
      element.autoplay = true;
      document.body.appendChild(element);
      this.attachedMediaElements.add(element);
      const collection =
        publication.source === Track.Source.ScreenShareAudio
          ? this.remoteStreamAudio
          : this.remoteVoiceAudio;
      const list =
        collection.get(participant.identity) ?? new Set<HTMLAudioElement>();
      list.add(element);
      collection.set(participant.identity, list);
      this.applyParticipantVolumes(participant.identity);
      syncParticipants();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return;
      track.detach().forEach((element) => {
        element.remove();
        this.attachedMediaElements.delete(element);
        this.remoteVoiceAudio.forEach((items) =>
          items.delete(element as HTMLAudioElement),
        );
        this.remoteStreamAudio.forEach((items) =>
          items.delete(element as HTMLAudioElement),
        );
      });
      syncParticipants();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      if (track.kind !== Track.Kind.Video) return;
      track.detach().forEach((element) => {
        this.attachedMediaElements.delete(element);
        element.remove();
      });
      this.detachMedia(`remote-${publication.trackSid}`);
      syncParticipants();
    });
    room.on(RoomEvent.TrackUnpublished, (publication) => {
      if (publication.kind === Track.Kind.Video) {
        this.detachMedia(`remote-${publication.trackSid}`);
      }
      syncParticipants();
    });
    room.on(RoomEvent.TrackMuted, (publication, participant) => {
      if (publication.kind === Track.Kind.Video) {
        this.detachMedia(`remote-${publication.trackSid}`);
      }
      if (participant) syncParticipants();
    });
    room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      if (publication.kind === Track.Kind.Video && publication.track) {
        const source =
          publication.source === Track.Source.ScreenShare ? "screen" : "camera";
        this.attachVideo(
          publication.track,
          `remote-${publication.trackSid}`,
          source === "screen" ? "Screen share" : "Camera",
          participant.identity,
          source,
        );
      }
      syncParticipants();
    });
    room.on(RoomEvent.Reconnecting, () => this.beginRecovery());
    room.on(RoomEvent.Reconnected, () => this.finishRecovery());
    room.on(RoomEvent.Disconnected, () => {
      if (
        this.snapshot.state !== "idle" &&
        this.snapshot.state !== "recovering"
      )
        this.update({ state: "failed" });
    });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== "mhtalk.chat") return;
      if (!participant) return;
      try {
        const event = JSON.parse(new TextDecoder().decode(payload)) as {
          type?: string;
          id?: string;
          body?: string;
          createdAt?: number;
          typing?: boolean;
          profile?: UserProfile;
          source?: "camera" | "screen";
          quality?: MediaQuality;
          replyTo?: ChatMessage["replyTo"];
        };
        if (event.type === "chat" && event.id && event.body && event.createdAt)
          this.addChat({
            id: event.id,
            body: this.filterMainText(event.body),
            createdAt: event.createdAt,
            replyTo: event.replyTo,
            sender:
              this.remoteProfiles.get(participant.identity)?.name ||
              participant.identity.slice(0, 16),
            senderIdentity: participant.identity,
            mine: false,
          });
        if (event.type === "typing")
          this.setRemoteTyping(
            this.remoteProfiles.get(participant.identity)?.name ||
              participant.identity.slice(0, 16),
            Boolean(event.typing),
          );
        if (event.type === "edit" && event.id && event.body)
          this.patchChat(event.id, { body: this.filterMainText(event.body) });
        if (event.type === "delete" && event.id)
          this.patchChat(event.id, {
            deleted: true,
            body: undefined,
            attachment: undefined,
          });
        if (event.type === "profile-request") void this.publishProfile();
        if (event.type === "profile" && event.profile) {
          const remoteProfile = sanitizeProfile(event.profile, participant.identity);
          this.remoteProfiles.set(participant.identity, remoteProfile);
          this.chat = {
            ...this.chat,
            messages: this.chat.messages.map((message) =>
              message.senderIdentity === participant.identity
                ? { ...message, sender: remoteProfile.name }
                : message,
            ),
          };
          this.emitChat();
          syncParticipants();
        }
        if (
          event.type === "media-quality" &&
          (event.source === "camera" || event.source === "screen") &&
          isMediaQuality(event.quality)
        ) {
          const qualities = this.remoteMediaQuality.get(participant.identity) || {};
          qualities[event.source] = event.quality;
          this.remoteMediaQuality.set(participant.identity, qualities);
          syncParticipants();
        }
      } catch {
        /* ignore malformed room data */
      }
    });
    room.registerByteStreamHandler(
      "mhtalk.file",
      async (reader, participant) => {
        try {
          const chunks = await reader.readAll();
          const blob = new Blob(chunks, {
            type: reader.info.mimeType || "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          this.objectUrls.add(url);
          const mimeType = reader.info.mimeType || "application/octet-stream";
          this.addChat({
            id: reader.info.id,
            sender:
              this.remoteProfiles.get(participant.identity)?.name ||
              participant.identity.slice(0, 16),
            senderIdentity: participant.identity,
            createdAt: reader.info.timestamp,
            mine: false,
            attachment: {
              name: reader.info.name || "Attachment",
              mimeType,
              size: blob.size,
              url,
              kind: attachmentKind(mimeType),
            },
          });
        } catch {
          /* transfer failure is isolated from the voice connection */
        }
      },
    );
    const developmentServerId = import.meta.env
      .VITE_LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID;
    if (developmentServerId) {
      const source = TokenSource.developmentTokenServer(developmentServerId);
      const details = await withTimeout(
        source.fetch({ roomName }),
        12_000,
        "The development token service did not respond",
      );
      this.update({ connectionMessage: "Connecting to the realtime server…" });
      await withTimeout(room.connect(details.serverUrl, details.participantToken, {
        autoSubscribe: false,
      }), 18_000, "The realtime server took too long to respond");
    } else {
      const credentials = suppliedCredentials || await this.fetchToken(roomName);
      if (credentials.routing.rtc.provider !== "livekit") {
        throw new Error("The selected call provider is not supported by this app version");
      }
      this.routing = credentials.routing;
      this.update({ connectionMessage: `Connecting through ${credentials.routing.rtc.provider}…` });
      await withTimeout(room.connect(credentials.routing.rtc.serverUrl, credentials.token, {
        autoSubscribe: false,
      }), 18_000, "The selected realtime server took too long to respond");
      roomName = credentials.roomName;
    }
    for (const kind of [
      "audioinput",
      "audiooutput",
      "videoinput",
    ] as const) {
      const deviceId = this.preferredDevices[kind];
      if (deviceId) {
        try {
          await room.switchActiveDevice(kind, deviceId);
        } catch {
          this.preferredDevices[kind] = "";
          localStorage.removeItem(`mhtalk.device.${kind}`);
        }
      }
    }
    await room.localParticipant.setMicrophoneEnabled(
      this.snapshot.microphoneEnabled,
      this.snapshot.microphoneEnabled
        ? this.microphoneCaptureOptions()
        : undefined,
    );
    if (this.snapshot.cameraEnabled) {
      const cameraId = this.preferredDevices.videoinput;
      const maximum = this.routing.subscription.entitlements.maxCameraQuality;
      const preset = maximum === "high" ? VideoPresets.h1080 : VideoPresets.h720;
      await room.localParticipant.setCameraEnabled(
        true,
        {
          ...(cameraId ? { deviceId: { exact: cameraId } } : {}),
          resolution: preset.resolution,
        },
        { videoEncoding: preset.encoding, simulcast: true },
      );
    }
    this.update({
      state: "connected",
      roomName,
      rtcProvider: "livekit",
      embeddedCallUrl: null,
      connectionMessage: null,
    });
    this.subscribeToRemoteVoice();
    void this.publishProfile();
    void this.requestProfiles();
    syncParticipants();
  }

  private syncAgoraParticipants(participants: AgoraParticipant[]) {
    const activeIdentities = new Set(participants.map((participant) => participant.userId));
    if ([...activeIdentities].some((identity) => !this.agoraParticipantIds.has(identity))) {
      void this.playEventTone("join");
      void this.publishProfile();
      void this.requestProfiles();
    }
    if ([...this.agoraParticipantIds].some((identity) => !activeIdentities.has(identity))) {
      void this.playEventTone("leave");
    }
    this.agoraParticipantIds = activeIdentities;
    const mapped = participants.map((participant) => {
      const previous = this.remoteMediaState.get(participant.userId);
      const media = {
        camera: participant.cameraEnabled,
        screen: participant.screenShareEnabled,
      };
      if (previous) {
        if ((!previous.camera && media.camera) || (!previous.screen && media.screen)) {
          void this.playEventTone("media-start");
        } else if ((previous.camera && !media.camera) || (previous.screen && !media.screen)) {
          void this.playEventTone("media-stop");
        }
      }
      this.remoteMediaState.set(participant.userId, media);
      const profile = this.remoteProfiles.get(participant.userId);
      return {
        identity: participant.userId,
        speaking: participant.speaking,
        microphoneEnabled: participant.microphoneEnabled,
        cameraEnabled: participant.cameraEnabled,
        screenShareEnabled: participant.screenShareEnabled,
        cameraQuality: this.getParticipantMaximumQuality(participant.userId, "camera"),
        screenShareQuality: this.getParticipantMaximumQuality(participant.userId, "screen"),
        name: profile?.name || participant.userId.slice(0, 16),
        bio: profile?.bio || "",
        avatar: profile?.avatar || profileInitial(profile?.name || participant.userId),
        username: profile?.username,
        usernameVisible: profile?.usernameVisible,
      };
    });
    [...this.remoteMediaState.keys()].forEach((identity) => {
      if (!activeIdentities.has(identity)) {
        this.remoteMediaState.delete(identity);
        this.remoteProfiles.delete(identity);
        this.remoteMediaQuality.delete(identity);
        this.detachParticipantSource(identity, "camera");
        this.detachParticipantSource(identity, "screen");
        this.detachStreamAudio(identity, "voice");
        this.detachStreamAudio(identity, "screen");
      }
    });
    this.update({ participants: mapped });
  }

  private syncTencentParticipants(participants: TencentParticipant[]) {
    const activeIdentities = new Set(participants.map((participant) => participant.userId));
    if ([...activeIdentities].some((identity) => !this.tencentParticipantIds.has(identity))) {
      void this.playEventTone("join");
      void this.publishProfile();
      void this.requestProfiles();
    }
    if ([...this.tencentParticipantIds].some((identity) => !activeIdentities.has(identity))) {
      void this.playEventTone("leave");
    }
    this.tencentParticipantIds = activeIdentities;
    const mapped = participants.map((participant) => {
      const previous = this.remoteMediaState.get(participant.userId);
      const media = {
        camera: participant.cameraEnabled,
        screen: participant.screenShareEnabled,
      };
      if (previous) {
        if ((!previous.camera && media.camera) || (!previous.screen && media.screen)) {
          void this.playEventTone("media-start");
        } else if ((previous.camera && !media.camera) || (previous.screen && !media.screen)) {
          void this.playEventTone("media-stop");
        }
      }
      this.remoteMediaState.set(participant.userId, media);
      const profile = this.remoteProfiles.get(participant.userId);
      return {
        identity: participant.userId,
        speaking: participant.speaking,
        microphoneEnabled: participant.microphoneEnabled,
        cameraEnabled: participant.cameraEnabled,
        screenShareEnabled: participant.screenShareEnabled,
        cameraQuality: this.getParticipantMaximumQuality(participant.userId, "camera"),
        screenShareQuality: this.getParticipantMaximumQuality(participant.userId, "screen"),
        name: profile?.name || participant.userId.slice(0, 16),
        bio: profile?.bio || "",
        avatar: profile?.avatar || profileInitial(profile?.name || participant.userId),
        username: profile?.username,
        usernameVisible: profile?.usernameVisible,
      };
    });
    [...this.remoteMediaState.keys()].forEach((identity) => {
      if (!activeIdentities.has(identity)) {
        this.remoteMediaState.delete(identity);
        this.remoteProfiles.delete(identity);
        this.remoteMediaQuality.delete(identity);
        this.detachParticipantSource(identity, "camera");
        this.detachParticipantSource(identity, "screen");
      }
    });
    activeIdentities.forEach((identity) => this.applyParticipantVolumes(identity));
    this.update({ participants: mapped });
  }

  private syncCloudflareParticipants(participants: CloudflareParticipant[]) {
    const activeIdentities = new Set(participants.map((participant) => participant.userId));
    if ([...activeIdentities].some((identity) => !this.cloudflareParticipantIds.has(identity))) {
      void this.playEventTone("join");
      void this.publishProfile();
      void this.requestProfiles();
    }
    if ([...this.cloudflareParticipantIds].some((identity) => !activeIdentities.has(identity))) {
      void this.playEventTone("leave");
    }
    this.cloudflareParticipantIds = activeIdentities;
    const mapped = participants.map((participant) => {
      const previous = this.remoteMediaState.get(participant.userId);
      const media = { camera: participant.cameraEnabled, screen: participant.screenShareEnabled };
      if (previous) {
        if ((!previous.camera && media.camera) || (!previous.screen && media.screen)) {
          void this.playEventTone("media-start");
        } else if ((previous.camera && !media.camera) || (previous.screen && !media.screen)) {
          void this.playEventTone("media-stop");
        }
      }
      this.remoteMediaState.set(participant.userId, media);
      const profile = this.remoteProfiles.get(participant.userId);
      return {
        identity: participant.userId,
        speaking: participant.speaking,
        microphoneEnabled: participant.microphoneEnabled,
        cameraEnabled: participant.cameraEnabled,
        screenShareEnabled: participant.screenShareEnabled,
        cameraQuality: this.getParticipantMaximumQuality(participant.userId, "camera"),
        screenShareQuality: this.getParticipantMaximumQuality(participant.userId, "screen"),
        name: profile?.name || participant.userId.slice(0, 16),
        bio: profile?.bio || "",
        avatar: profile?.avatar || profileInitial(profile?.name || participant.userId),
        username: profile?.username,
        usernameVisible: profile?.usernameVisible,
      };
    });
    [...this.remoteMediaState.keys()].forEach((identity) => {
      if (!activeIdentities.has(identity)) {
        this.remoteMediaState.delete(identity);
        this.remoteProfiles.delete(identity);
        this.remoteMediaQuality.delete(identity);
        this.detachParticipantSource(identity, "camera");
        this.detachParticipantSource(identity, "screen");
        this.detachStreamAudio(identity, "voice");
        this.detachStreamAudio(identity, "screen");
      }
    });
    activeIdentities.forEach((identity) => this.applyParticipantVolumes(identity));
    this.update({ participants: mapped });
  }

  private handleProviderCustomEvent(
    identity: string,
    event: Record<string, unknown>,
  ) {
    if (
      !identity ||
      identity === this.agoraRtc.identity ||
      identity === this.tencentRtc.identity ||
      identity === this.cloudflareRtc.identity
    ) return;
    const sender = this.remoteProfiles.get(identity)?.name || identity.slice(0, 16);
    if (
      event.type === "chat" &&
      typeof event.id === "string" &&
      typeof event.body === "string" &&
      typeof event.createdAt === "number"
    ) {
      this.addChat({
        id: event.id,
        body: this.filterMainText(event.body),
        createdAt: event.createdAt,
        replyTo: isChatReply(event.replyTo) ? event.replyTo : undefined,
        sender,
        senderIdentity: identity,
        mine: false,
      });
    }
    if (event.type === "typing") this.setRemoteTyping(sender, Boolean(event.typing));
    if (event.type === "edit" && typeof event.id === "string" && typeof event.body === "string") {
      this.patchChat(event.id, { body: this.filterMainText(event.body) });
    }
    if (event.type === "delete" && typeof event.id === "string") {
      this.patchChat(event.id, { deleted: true, body: undefined, attachment: undefined });
    }
    if (isStoredAttachmentEvent(event)) {
      void this.receiveStoredAttachment(identity, event);
    }
    if (event.type === "profile" && event.profile && typeof event.profile === "object") {
      const value = event.profile as Partial<UserProfile>;
      this.remoteProfiles.set(identity, sanitizeProfile({
        name: typeof value.name === "string" ? value.name : sender,
        bio: typeof value.bio === "string" ? value.bio : "",
        avatar: typeof value.avatar === "string" ? value.avatar : "",
        username: typeof value.username === "string" ? value.username : undefined,
        usernameVisible: value.usernameVisible !== false,
      }, identity));
      this.syncActiveProviderParticipants();
    }
    if (event.type === "profile-request") void this.publishProfile();
    if (
      event.type === "media-quality" &&
      (event.source === "camera" || event.source === "screen") &&
      isMediaQuality(event.quality)
    ) {
      this.remoteMediaQuality.set(identity, {
        ...this.remoteMediaQuality.get(identity),
        [event.source]: event.quality,
      });
      this.syncActiveProviderParticipants();
    }
  }

  private syncActiveProviderParticipants() {
    if (this.cloudflareRtc.connected) {
      this.syncCloudflareParticipants(this.cloudflareRtc.participants);
      return;
    }
    if (this.tencentRtc.connected) {
      this.syncTencentParticipants(this.tencentRtc.participants);
      return;
    }
    if (this.agoraRtc.connected) this.syncAgoraParticipants(this.agoraRtc.participants);
  }

  private handleAgoraConnectionState(state: string) {
    if (state === "RECONNECTING") this.beginRecovery();
    if (state === "CONNECTED" && this.snapshot.state === "recovering") this.finishRecovery();
    if (state === "DISCONNECTED" && this.snapshot.state !== "idle") {
      this.update({ state: "failed", connectionMessage: "The Agora call disconnected" });
    }
  }

  private handleTencentConnectionState(state: string) {
    if (state === "RECONNECTING") this.beginRecovery();
    if (state === "CONNECTED" && this.snapshot.state === "recovering") this.finishRecovery();
    if (state === "DISCONNECTED" && this.snapshot.state !== "idle") {
      this.update({ state: "failed", connectionMessage: "The Tencent call disconnected" });
    }
  }

  private handleCloudflareConnectionState(state: string) {
    if (state === "disconnected") this.beginRecovery();
    if (state === "connected" && this.snapshot.state === "recovering") this.finishRecovery();
    if ((state === "failed" || state === "closed") && this.snapshot.state !== "idle") {
      this.update({ state: "failed", connectionMessage: "The Cloudflare call disconnected" });
    }
  }

  private syncStreamParticipants(participants: StreamVideoParticipant[]) {
    const local = participants.find((participant) => participant.isLocalParticipant);
    const remote = participants.filter((participant) => !participant.isLocalParticipant);
    const activeIdentities = new Set(remote.map((participant) => participant.userId));
    if ([...activeIdentities].some((identity) => !this.streamParticipantIds.has(identity))) {
      void this.playEventTone("join");
      void this.publishProfile();
      void this.requestProfiles();
    }
    if ([...this.streamParticipantIds].some((identity) => !activeIdentities.has(identity))) {
      void this.playEventTone("leave");
    }
    this.streamParticipantIds = activeIdentities;

    const mapped = remote.map((participant) => {
      const camera = streamPublishes(participant, StreamTrackType.VIDEO);
      const screen = streamPublishes(participant, StreamTrackType.SCREEN_SHARE);
      const previous = this.remoteMediaState.get(participant.userId);
      if (previous) {
        if ((!previous.camera && camera) || (!previous.screen && screen)) {
          void this.playEventTone("media-start");
        } else if ((previous.camera && !camera) || (previous.screen && !screen)) {
          void this.playEventTone("media-stop");
        }
      }
      this.remoteMediaState.set(participant.userId, { camera, screen });

      if (streamPublishes(participant, StreamTrackType.AUDIO) && participant.audioStream) {
        this.attachStreamAudio(participant.audioStream, participant.userId, "voice");
      } else {
        this.detachStreamAudio(participant.userId, "voice");
      }
      if (
        this.watchedMedia.has(`${participant.userId}:screen`) &&
        streamPublishes(participant, StreamTrackType.SCREEN_SHARE_AUDIO) &&
        participant.screenShareAudioStream
      ) {
        this.attachStreamAudio(participant.screenShareAudioStream, participant.userId, "screen");
      } else {
        this.detachStreamAudio(participant.userId, "screen");
      }
      if (this.watchedMedia.has(`${participant.userId}:camera`) && participant.videoStream) {
        this.attachStreamVideo(
          participant.videoStream,
          `stream-camera-${participant.sessionId}`,
          "Camera",
          participant.userId,
          "camera",
        );
      }
      if (this.watchedMedia.has(`${participant.userId}:screen`) && participant.screenShareStream) {
        this.attachStreamVideo(
          participant.screenShareStream,
          `stream-screen-${participant.sessionId}`,
          "Screen share",
          participant.userId,
          "screen",
        );
      }

      const dataProfile = this.remoteProfiles.get(participant.userId);
      const avatar = dataProfile?.avatar || participant.image || profileInitial(
        dataProfile?.name || participant.name || participant.userId,
      );
      return {
        identity: participant.userId,
        speaking: participant.isSpeaking,
        microphoneEnabled: streamPublishes(participant, StreamTrackType.AUDIO),
        cameraEnabled: camera,
        screenShareEnabled: screen,
        cameraQuality: this.getParticipantMaximumQuality(participant.userId, "camera"),
        screenShareQuality: this.getParticipantMaximumQuality(participant.userId, "screen"),
        name: dataProfile?.name || participant.name || participant.userId,
        bio: dataProfile?.bio || "",
        avatar,
        username: dataProfile?.username,
        usernameVisible: dataProfile?.usernameVisible,
      };
    });

    [...this.remoteMediaState.keys()].forEach((identity) => {
      if (!activeIdentities.has(identity)) {
        this.remoteMediaState.delete(identity);
        this.remoteProfiles.delete(identity);
        this.remoteMediaQuality.delete(identity);
        this.detachParticipantSource(identity, "camera");
        this.detachParticipantSource(identity, "screen");
        this.detachStreamAudio(identity, "voice");
        this.detachStreamAudio(identity, "screen");
      }
    });
    const quality = local?.connectionQuality ?? 0;
    this.update({
      localSpeaking: local?.isSpeaking ?? false,
      connectionQuality: quality >= 3 ? "excellent" : quality === 2 ? "good" : quality === 1 ? "poor" : "unknown",
      estimatedDropPercent: quality >= 3 ? 1 : quality === 2 ? 5 : quality === 1 ? 24 : null,
      participants: mapped,
    });
  }

  private handleStreamCustomEvent(received: CustomVideoEvent) {
    const identity = received.user.id;
    if (!identity || identity === this.streamRtc.localParticipant?.userId) return;
    const event = received.custom as {
      type?: unknown;
      id?: unknown;
      body?: unknown;
      createdAt?: unknown;
      typing?: unknown;
      profile?: unknown;
      source?: unknown;
      quality?: unknown;
      replyTo?: unknown;
      attachment?: unknown;
    };
    const sender = this.remoteProfiles.get(identity)?.name || received.user.name || identity.slice(0, 16);
    if (
      event.type === "chat" &&
      typeof event.id === "string" &&
      typeof event.body === "string" &&
      typeof event.createdAt === "number"
    ) {
      this.addChat({
        id: event.id,
        body: this.filterMainText(event.body),
        createdAt: event.createdAt,
        replyTo: isChatReply(event.replyTo) ? event.replyTo : undefined,
        sender,
        senderIdentity: identity,
        mine: false,
      });
    }
    if (event.type === "typing") this.setRemoteTyping(sender, Boolean(event.typing));
    if (event.type === "edit" && typeof event.id === "string" && typeof event.body === "string") {
      this.patchChat(event.id, { body: this.filterMainText(event.body) });
    }
    if (event.type === "delete" && typeof event.id === "string") {
      this.patchChat(event.id, { deleted: true, body: undefined, attachment: undefined });
    }
    if (isStoredAttachmentEvent(event)) {
      void this.receiveStoredAttachment(identity, event);
    }
    if (event.type === "profile" && event.profile && typeof event.profile === "object") {
      const value = event.profile as Partial<UserProfile>;
      this.remoteProfiles.set(identity, sanitizeProfile({
        name: typeof value.name === "string" ? value.name : sender,
        bio: typeof value.bio === "string" ? value.bio : "",
        avatar: typeof value.avatar === "string" ? value.avatar : received.user.image || "",
        username: typeof value.username === "string" ? value.username : undefined,
        usernameVisible: value.usernameVisible !== false,
      }, identity));
      this.syncStreamParticipants(this.streamRtc.participants);
    }
    if (event.type === "profile-request") void this.publishProfile();
    if (
      event.type === "media-quality" &&
      (event.source === "camera" || event.source === "screen") &&
      isMediaQuality(event.quality)
    ) {
      this.remoteMediaQuality.set(identity, {
        ...this.remoteMediaQuality.get(identity),
        [event.source]: event.quality,
      });
      this.syncStreamParticipants(this.streamRtc.participants);
    }
  }

  private handleStreamCallingState(state: StreamCallingState) {
    if (
      state === StreamCallingState.RECONNECTING ||
      state === StreamCallingState.MIGRATING ||
      state === StreamCallingState.OFFLINE
    ) {
      this.beginRecovery();
    } else if (state === StreamCallingState.JOINED && this.snapshot.state === "recovering") {
      this.finishRecovery();
    } else if (state === StreamCallingState.RECONNECTING_FAILED) {
      this.update({ state: "failed", connectionMessage: "The Stream call could not reconnect" });
    }
  }

  private subscribeToRemoteVoice() {
    this.room?.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (!(publication instanceof RemoteTrackPublication)) return;
        publication.setSubscribed(publication.source === Track.Source.Microphone);
      });
    });
  }

  private async publishProfile() {
    const profile = sanitizeProfile(this.profile);
    const safe: UserProfile = profile.usernameVisible === false
      ? { ...profile, username: undefined }
      : profile;
    if (this.cloudflareRtc.connected) {
      const cloudflareSafe = {
        ...safe,
        avatar: safe.avatar.length <= 600 ? safe.avatar : profileInitial(safe.name),
      };
      this.cloudflareRtc.setProfile(cloudflareSafe);
      await this.cloudflareRtc.sendCustomEvent({ type: "profile", profile: cloudflareSafe });
      return;
    }
    if (this.tencentRtc.connected) {
      const tencentSafe = {
        ...safe,
        avatar: safe.avatar.length <= 600 ? safe.avatar : profileInitial(safe.name),
      };
      await this.tencentRtc.sendCustomEvent({ type: "profile", profile: tencentSafe });
      return;
    }
    if (this.agoraRtc.connected) {
      const agoraSafe = {
        ...safe,
        avatar: safe.avatar.length <= 600 ? safe.avatar : profileInitial(safe.name),
      };
      await this.agoraRtc.sendCustomEvent({ type: "profile", profile: agoraSafe });
      return;
    }
    if (this.streamRtc.call) {
      const streamSafe = {
        ...safe,
        avatar: safe.avatar.length <= 2_500 ? safe.avatar : profileInitial(safe.name),
      };
      await this.streamRtc.sendCustomEvent({ type: "profile", profile: streamSafe });
      return;
    }
    if (!this.room) return;
    const metadata = JSON.stringify(safe);
    await Promise.allSettled([
      this.room.localParticipant.publishData(
        new TextEncoder().encode(
          JSON.stringify({ type: "profile", profile: safe }),
        ),
        { reliable: true, topic: "mhtalk.chat" },
      ),
      this.room.localParticipant.setMetadata(metadata),
    ]);
  }

  private async requestProfiles() {
    if (this.cloudflareRtc.connected) {
      await this.cloudflareRtc.sendCustomEvent({ type: "profile-request" });
      return;
    }
    if (this.tencentRtc.connected) {
      await this.tencentRtc.sendCustomEvent({ type: "profile-request" });
      return;
    }
    if (this.agoraRtc.connected) {
      await this.agoraRtc.sendCustomEvent({ type: "profile-request" });
      return;
    }
    if (this.streamRtc.call) {
      await this.streamRtc.sendCustomEvent({ type: "profile-request" });
      return;
    }
    if (!this.room) return;
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "profile-request" })),
      { reliable: true, topic: "mhtalk.chat" },
    );
  }

  private async publishMediaQuality(
    source: "camera" | "screen",
    quality: MediaQuality,
  ) {
    if (this.cloudflareRtc.connected) {
      await this.cloudflareRtc.sendCustomEvent({ type: "media-quality", source, quality });
      return;
    }
    if (this.tencentRtc.connected) {
      await this.tencentRtc.sendCustomEvent({ type: "media-quality", source, quality });
      return;
    }
    if (this.agoraRtc.connected) {
      await this.agoraRtc.sendCustomEvent({ type: "media-quality", source, quality });
      return;
    }
    if (this.streamRtc.call) {
      await this.streamRtc.sendCustomEvent({ type: "media-quality", source, quality });
      return;
    }
    if (!this.room) return;
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(
        JSON.stringify({ type: "media-quality", source, quality }),
      ),
      { reliable: true, topic: "mhtalk.chat" },
    );
  }

  private async sendProviderEvent(
    event: Record<string, unknown>,
    reliable: boolean,
  ) {
    if (this.cloudflareRtc.connected) {
      await this.cloudflareRtc.sendCustomEvent(event);
      return;
    }
    if (this.tencentRtc.connected) {
      await this.tencentRtc.sendCustomEvent(event);
      return;
    }
    if (this.agoraRtc.connected) {
      await this.agoraRtc.sendCustomEvent(event);
      return;
    }
    if (this.streamRtc.call) {
      await this.streamRtc.sendCustomEvent(event);
      return;
    }
    if (!this.room) return;
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify(event)),
      { reliable, topic: "mhtalk.chat" },
    );
  }

  private async unlockEventAudio() {
    const context = this.toneContext || new AudioContext();
    this.toneContext = context;
    const outputDevice = this.preferredDevices.audiooutput;
    const sinkContext = context as AudioContext & {
      setSinkId?: (deviceId: string) => Promise<void>;
    };
    if (outputDevice && typeof sinkContext.setSinkId === "function") {
      try {
        await sinkContext.setSinkId(outputDevice);
      } catch {
        // Fall back to the operating system's default speaker.
      }
    }
    if (context.state === "suspended") await context.resume();
    return context;
  }

  private microphoneCaptureOptions() {
    const deviceId = this.preferredDevices.audioinput;
    return {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: this.noiseCancellationEnabled,
      autoGainControl: true,
    };
  }

  private async playEventTone(
    kind: "join" | "leave" | "media-start" | "media-stop",
  ) {
    const setting = kind === "join" || kind === "leave" ? "presence" : "media";
    if (!this.getEventSoundSettings()[setting]) return;
    try {
      const context = await this.unlockEventAudio();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + 0.01;
      const [from, to, duration] =
        kind === "join"
          ? [460, 760, 0.22]
          : kind === "leave"
            ? [660, 360, 0.24]
            : kind === "media-start"
              ? [700, 1020, 0.18]
              : [560, 320, 0.2];
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(from, start);
      oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, 0.1 * this.outputVolume),
        start + 0.024,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    } catch {
      /* Audio can be blocked until the first user gesture. */
    }
  }

  private async fetchToken(
    roomName: string,
    supportedRtcProviders = this.rtcAdapters.supportedProviders(),
  ) {
    const accountToken = accountSession.getAccessToken();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    const response = await fetch(liveKitTokenEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(accountToken ? { authorization: `Bearer ${accountToken}` } : {}),
      },
      body: JSON.stringify({
        roomName,
        inviteCode: this.inviteCode,
        clientPlatform: "windows",
        capabilitiesVersion: 2,
        supportedRtcProviders,
        supportedMessagingProviders,
        supportedFileProviders,
      }),
    }).finally(() => window.clearTimeout(timer));
    const payload = (await response.json().catch(() => ({}))) as {
      token?: string;
      attachmentAccessToken?: string;
      usageAccessToken?: string;
      identity?: string;
      screenToken?: string;
      screenIdentity?: string;
      roomName?: string;
      error?: string;
    };
    if (!response.ok)
      throw new Error(payload.error || "Realtime account service is unavailable");
    if (!payload.token || !payload.roomName)
      throw new Error("Invalid token response");
    return {
      token: payload.token,
      ...(payload.attachmentAccessToken ? { attachmentAccessToken: payload.attachmentAccessToken } : {}),
      ...(payload.usageAccessToken ? { usageAccessToken: payload.usageAccessToken } : {}),
      ...(payload.identity ? { identity: payload.identity } : {}),
      ...(payload.screenToken ? { screenToken: payload.screenToken } : {}),
      ...(payload.screenIdentity ? { screenIdentity: payload.screenIdentity } : {}),
      roomName: payload.roomName,
      routing: parseRoomServiceRouting(payload, liveKitUrl),
    };
  }

  private isLiveKitConfigured() {
    return Boolean(
      import.meta.env.VITE_LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID ||
      (liveKitUrl && liveKitTokenEndpoint),
    );
  }

  private filterMainText(value: string) {
    return this.snapshot.roomName?.toLocaleLowerCase() === "main"
      ? moderateMainMessage(value).text
      : value;
  }

  private async filterMainTextWithServer(value: string) {
    const local = this.filterMainText(value);
    if (this.snapshot.roomName?.toLocaleLowerCase() !== "main") return local;
    try {
      const response = await fetch(new URL("/moderate", liveKitTokenEndpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: value, roomName: "Main" }),
      });
      const payload = (await response.json()) as { text?: unknown };
      return response.ok && typeof payload.text === "string"
        ? payload.text
        : local;
    } catch {
      return local;
    }
  }

  private beginRecovery() {
    if (this.snapshot.state === "recovering") return;
    this.recoveryStartedAt = performance.now();
    this.update({
      state: "recovering",
      recoveryAttempt: this.snapshot.recoveryAttempt + 1,
    });
  }

  private finishRecovery() {
    this.update({
      state: "connected",
      recoveryAttempt: 0,
      lastRecoveryMs: Math.round(performance.now() - this.recoveryStartedAt),
      connectionMessage: null,
    });
  }

  private update(change: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private attachLocalVideo(source: Track.Source, label: string) {
    const publication = this.room?.localParticipant.getTrackPublication(source);
    if (publication?.videoTrack)
      this.attachVideo(
        publication.videoTrack,
        source === Track.Source.Camera ? "local-camera" : "local-screen",
        label,
        "local",
        source === Track.Source.Camera ? "camera" : "screen",
      );
  }

  private attachVideo(
    track: Track,
    id: string,
    label: string,
    participantIdentity: string,
    source: "camera" | "screen",
  ) {
    this.detachMedia(id);
    const hostId = `media-host-${encodeURIComponent(participantIdentity)}-${source}`;
    const host = document.getElementById(hostId);
    if (!host) {
      window.setTimeout(
        () => this.attachVideo(track, id, label, participantIdentity, source),
        40,
      );
      return;
    }
    this.detachParticipantSource(participantIdentity, source);
    const item = document.createElement("div");
    item.id = id;
    item.className = "media-item";
    item.dataset.participantIdentity = participantIdentity;
    item.dataset.mediaSource = source;
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent("mhtalk-media-context", {
          detail: {
            x: event.clientX,
            y: event.clientY,
            id,
            identity:
              participantIdentity === "local" ? undefined : participantIdentity,
            local: id.startsWith("local-"),
            source,
          },
        }),
      );
    });
    const video = track.attach() as HTMLVideoElement;
    video.autoplay = true;
    video.playsInline = true;
    if (id.startsWith("local-")) video.muted = true;
    track.mediaStreamTrack.addEventListener(
      "ended",
      () => this.detachMedia(id),
      { once: true },
    );
    const caption = document.createElement("div");
    caption.className = "media-label";
    caption.textContent = label;
    item.append(video, caption);
    host.appendChild(item);
    this.attachedMediaElements.add(video);
  }

  private attachStreamVideo(
    stream: MediaStream,
    id: string,
    label: string,
    participantIdentity: string,
    source: "camera" | "screen",
  ) {
    const current = document.getElementById(id)?.querySelector("video");
    if (current?.srcObject === stream) return;
    this.detachMedia(id);
    const hostId = `media-host-${encodeURIComponent(participantIdentity)}-${source}`;
    const host = document.getElementById(hostId);
    if (!host) {
      window.setTimeout(
        () => this.attachStreamVideo(stream, id, label, participantIdentity, source),
        40,
      );
      return;
    }
    this.detachParticipantSource(participantIdentity, source);
    const item = document.createElement("div");
    item.id = id;
    item.className = "media-item";
    item.dataset.participantIdentity = participantIdentity;
    item.dataset.mediaSource = source;
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent("mhtalk-media-context", {
          detail: {
            x: event.clientX,
            y: event.clientY,
            id,
            identity: participantIdentity === "local" ? undefined : participantIdentity,
            local: id.startsWith("local-"),
            source,
          },
        }),
      );
    });
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.muted = participantIdentity === "local";
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => this.detachMedia(id), { once: true });
    });
    const caption = document.createElement("div");
    caption.className = "media-label";
    caption.textContent = label;
    item.append(video, caption);
    host.appendChild(item);
    this.attachedMediaElements.add(video);
    void video.play().catch(() => undefined);
  }

  private attachStreamAudio(
    stream: MediaStream,
    identity: string,
    source: "voice" | "screen",
  ) {
    const collection = source === "voice" ? this.remoteVoiceAudio : this.remoteStreamAudio;
    const existing = collection.get(identity) ?? new Set<HTMLAudioElement>();
    if ([...existing].some((element) => element.srcObject === stream)) return;
    existing.forEach((element) => {
      this.attachedMediaElements.delete(element);
      element.remove();
    });
    existing.clear();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = stream;
    document.body.appendChild(audio);
    existing.add(audio);
    collection.set(identity, existing);
    this.attachedMediaElements.add(audio);
    this.applyParticipantVolumes(identity);
    void audio.play().catch(() => undefined);
  }

  private detachStreamAudio(identity: string, source: "voice" | "screen") {
    const collection = source === "voice" ? this.remoteVoiceAudio : this.remoteStreamAudio;
    collection.get(identity)?.forEach((element) => {
      this.attachedMediaElements.delete(element);
      element.remove();
    });
    collection.delete(identity);
  }

  private detachMedia(id?: string) {
    if (id) {
      const item = document.getElementById(id);
      if (item)
        window.dispatchEvent(
          new CustomEvent("mhtalk-media-detached", { detail: { id } }),
        );
      item
        ?.querySelectorAll("video")
        .forEach((video) => this.attachedMediaElements.delete(video));
      item?.remove();
      return;
    }
    this.attachedMediaElements.forEach((element) => element.remove());
    document
      .querySelectorAll("#media-stage .media-item")
      .forEach((item) => item.remove());
    this.attachedMediaElements.clear();
    this.remoteVoiceAudio.clear();
    this.remoteStreamAudio.clear();
  }

  private detachParticipantSource(
    participantIdentity: string,
    source: "camera" | "screen",
  ) {
    const host = document.getElementById(
      `media-host-${encodeURIComponent(participantIdentity)}-${source}`,
    );
    host
      ?.querySelectorAll<HTMLMediaElement>("video, audio")
      .forEach((element) => {
        this.attachedMediaElements.delete(element);
        element.remove();
      });
    host?.querySelectorAll<HTMLElement>(".media-item").forEach((item) => {
      window.dispatchEvent(
        new CustomEvent("mhtalk-media-detached", {
          detail: { id: item.id },
        }),
      );
      item.remove();
    });
  }

  private applyParticipantVolumes(identity: string) {
    const volumes = this.getParticipantVolumes(identity);
    if (this.cloudflareRtc.connected) {
      this.cloudflareRtc.setParticipantVolume(
        identity,
        Math.round(this.outputVolume * volumes.voice),
      );
    }
    if (this.tencentRtc.connected) {
      // TRTC exposes one mixed remote-audio volume per participant, so the
      // participant voice slider controls the combined remote audio output.
      this.tencentRtc.setParticipantVolume(
        identity,
        Math.round(this.outputVolume * volumes.voice),
      );
    }
    this.remoteVoiceAudio.get(identity)?.forEach((element) => {
      element.volume = this.outputVolume * (volumes.voice / 100);
    });
    this.remoteStreamAudio.get(identity)?.forEach((element) => {
      element.volume = this.outputVolume * (volumes.stream / 100);
    });
  }

  private addChat(message: ChatMessage) {
    if (this.chat.messages.some((item) => item.id === message.id)) return;
    this.chat = {
      ...this.chat,
      messages: [...this.chat.messages, message].slice(-250),
    };
    this.emitChat();
  }

  private patchChat(id: string, change: Partial<ChatMessage>) {
    this.chat = {
      ...this.chat,
      messages: this.chat.messages.map((message) =>
        message.id === id ? { ...message, ...change } : message,
      ),
    };
    this.emitChat();
  }

  private setRemoteTyping(name: string, typing: boolean) {
    const names = typing
      ? [...new Set([...this.chat.typing, name])]
      : this.chat.typing.filter((item) => item !== name);
    this.chat = { ...this.chat, typing: names };
    this.emitChat();
    if (typing)
      window.setTimeout(() => this.setRemoteTyping(name, false), 1800);
  }

  private clearChat() {
    window.clearTimeout(this.typingTimer);
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls.clear();
    this.chat = { messages: [], typing: [] };
    this.emitChat();
  }

  private emitChat() {
    this.chatListeners.forEach((listener) => listener(this.chat));
  }
}

function attachmentKind(
  mimeType: string,
): "image" | "video" | "audio" | "file" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function isMediaQuality(value: unknown): value is MediaQuality {
  return value === "low" || value === "medium" || value === "high";
}

function isChatReply(value: unknown): value is NonNullable<ChatMessage["replyTo"]> {
  if (!value || typeof value !== "object") return false;
  const reply = value as Record<string, unknown>;
  return typeof reply.id === "string" &&
    typeof reply.sender === "string" &&
    typeof reply.body === "string";
}

function isStoredAttachmentEvent(value: Record<string, unknown>): value is {
  type: "attachment";
  id: string;
  createdAt: number;
  attachment: { id: string; name: string; mimeType: string; size: number };
} {
  if (value.type !== "attachment" || typeof value.id !== "string" || typeof value.createdAt !== "number") return false;
  if (!value.attachment || typeof value.attachment !== "object") return false;
  const attachment = value.attachment as Record<string, unknown>;
  return typeof attachment.id === "string" &&
    typeof attachment.name === "string" &&
    typeof attachment.mimeType === "string" &&
    typeof attachment.size === "number";
}

function capQuality(requested: MediaQuality, maximum: MediaQuality) {
  return qualityRank[requested] <= qualityRank[maximum] ? requested : maximum;
}

function inferQuality(height?: number): MediaQuality {
  if (!height) return "high";
  if (height <= 480) return "low";
  if (height <= 900) return "medium";
  return "high";
}

function estimatedDropPercent(quality: ConnectionQuality) {
  if (quality === ConnectionQuality.Excellent) return 1;
  if (quality === ConnectionQuality.Good) return 5;
  if (quality === ConnectionQuality.Poor) return 24;
  if (quality === ConnectionQuality.Lost) return 100;
  return null;
}

function parseParticipantProfile(
  metadata: string | undefined,
  fallbackIdentity: string,
): UserProfile {
  try {
    const value = JSON.parse(metadata || "{}") as Partial<UserProfile> & {
      username?: unknown;
      avatar_url?: unknown;
    };
    const rawName =
      typeof value.name === "string"
        ? value.name
        : typeof value.username === "string"
          ? value.username
          : fallbackIdentity;
    return sanitizeProfile(
      {
        name: rawName,
        bio: typeof value.bio === "string" ? value.bio : "",
        avatar:
          typeof value.avatar === "string"
            ? value.avatar
            : typeof value.avatar_url === "string"
              ? value.avatar_url
              : "",
        username: typeof value.username === "string" ? value.username : undefined,
        usernameVisible: value.usernameVisible !== false,
      },
      fallbackIdentity,
    );
  } catch {
    return sanitizeProfile(
      { name: fallbackIdentity, bio: "", avatar: "" },
      fallbackIdentity,
    );
  }
}

function profileInitial(value: string) {
  return Array.from(value.trim())[0]?.toUpperCase() || "M";
}

function sanitizeProfile(
  profile: UserProfile,
  fallbackIdentity = "Me",
): UserProfile {
  const name =
    typeof profile?.name === "string"
      ? profile.name.trim().slice(0, 60)
      : "";
  const bio =
    typeof profile?.bio === "string" ? profile.bio.trim().slice(0, 240) : "";
  const avatar = normalizeProfileAvatar(profile?.avatar);
  const username = typeof profile?.username === "string"
    ? profile.username.trim().slice(0, 32)
    : undefined;
  return {
    name: name || fallbackIdentity.slice(0, 16) || "Member",
    bio,
    avatar: avatar || (name || fallbackIdentity || "M")[0].toUpperCase(),
    username,
    usernameVisible: profile?.usernameVisible !== false,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export const roomSession = new RoomSession();
