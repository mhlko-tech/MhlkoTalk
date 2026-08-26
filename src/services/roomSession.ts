import {
  ConnectionQuality,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  ScreenSharePresets,
  TokenSource,
  Track,
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
import { normalizeProfileAvatar } from "../core/profileAvatar";
import { moderateMainMessage } from "../core/moderation";
import { accountSession } from "./accountSession";

const initialSnapshot: SessionSnapshot = {
  state: "idle",
  roomName: null,
  microphoneEnabled: true,
  localSpeaking: false,
  cameraEnabled: false,
  screenShareEnabled: false,
  screenShareAudioEnabled: false,
  connectionQuality: "unknown",
  estimatedDropPercent: null,
  recoveryAttempt: 0,
  lastRecoveryMs: null,
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
  };
  private remoteProfiles = new Map<string, UserProfile>();
  private recoveryTimer: number | undefined;
  private recoveryStartedAt = 0;
  private room: Room | null = null;
  private attachedMediaElements = new Set<HTMLMediaElement>();
  private remoteVoiceAudio = new Map<string, Set<HTMLAudioElement>>();
  private remoteStreamAudio = new Map<string, Set<HTMLAudioElement>>();
  private remoteMediaQuality = new Map<
    string,
    Partial<Record<"camera" | "screen", MediaQuality>>
  >();
  private selectedRemoteQuality = new Map<string, MediaQuality>();
  private watchedMedia = new Set<string>();
  private outputVolume = 1;
  private toneContext: AudioContext | null = null;
  private inviteCode: string | undefined;
  private preferredDevices: Partial<Record<MediaDeviceKind, string>> = {
    audioinput: localStorage.getItem("mhtalk.device.audioinput") || "",
    audiooutput: localStorage.getItem("mhtalk.device.audiooutput") || "",
    videoinput: localStorage.getItem("mhtalk.device.videoinput") || "",
  };

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
    this.update({
      state: "connecting",
      roomName,
      recoveryAttempt: 0,
      lastRecoveryMs: null,
    });
    this.inviteCode = inviteCode;
    try {
      if (this.isLiveKitConfigured()) await this.joinLiveKit(roomName);
      else await this.joinSimulator();
    } catch {
      this.update({ state: "failed" });
    }
  }

  async createPrivateRoom() {
    const endpoint = import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT;
    if (!endpoint)
      throw new Error("Private rooms require the secure token service");
    const response = await fetch(new URL("/private-room", endpoint), {
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
    await this.room?.disconnect();
    this.room = null;
    this.inviteCode = undefined;
    this.remoteProfiles.clear();
    this.remoteMediaQuality.clear();
    this.selectedRemoteQuality.clear();
    this.watchedMedia.clear();
    this.detachMedia();
    this.clearChat();
    this.update({ ...initialSnapshot });
  }

  async setMicrophoneEnabled(microphoneEnabled: boolean) {
    this.update({ microphoneEnabled });
    if (this.room)
      await this.room.localParticipant.setMicrophoneEnabled(microphoneEnabled);
  }

  async setCameraEnabled(cameraEnabled: boolean) {
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
      await this.room.localParticipant.setCameraEnabled(
        true,
        deviceId ? { deviceId: { exact: deviceId } } : undefined,
      );
      this.update({ cameraEnabled: true });
      this.attachLocalVideo(Track.Source.Camera, "Camera");
    } catch {
      this.detachMedia("local-camera");
      this.update({ cameraEnabled: false });
    }
  }

  async setScreenShareEnabled(
    enabled: boolean,
    includeSystemAudio = false,
    quality: MediaQuality = "medium",
  ) {
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
          audio: includeSystemAudio
            ? {
                restrictOwnAudio: true,
                echoCancellation: true,
                noiseSuppression: true,
              }
            : false,
          systemAudio: includeSystemAudio ? "include" : "exclude",
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
      this.attachLocalVideo(Track.Source.ScreenShare, "Screen share");
      localStorage.setItem("mhtalk.share-quality", quality);
      await this.publishMediaQuality("screen", quality);
      this.update({
        screenShareEnabled: true,
        screenShareAudioEnabled: includeSystemAudio,
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
    if (!text || !this.room) return;
    const message = {
      id: crypto.randomUUID(),
      body: text,
      createdAt: Date.now(),
      replyTo,
    };
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "chat", ...message })),
      { reliable: true, topic: "mhtalk.chat" },
    );
    this.addChat({ ...message, sender: this.profile.name, mine: true });
  }

  async editChatMessage(id: string, body: string) {
    const text = await this.filterMainTextWithServer(body.trim());
    if (!text || !this.room) return;
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(
        JSON.stringify({ type: "edit", id, body: text }),
      ),
      { reliable: true, topic: "mhtalk.chat" },
    );
    this.patchChat(id, { body: text });
  }

  async deleteChatMessage(id: string) {
    if (!this.room) return;
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "delete", id })),
      { reliable: true, topic: "mhtalk.chat" },
    );
    this.patchChat(id, {
      deleted: true,
      body: undefined,
      attachment: undefined,
    });
  }

  async setProfile(profile: UserProfile) {
    this.profile = sanitizeProfile(profile);
    localStorage.setItem("mhtalk.profile.name", this.profile.name);
    localStorage.setItem("mhtalk.profile.bio", this.profile.bio);
    localStorage.setItem("mhtalk.profile.avatar", this.profile.avatar);
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
  }

  async watchParticipantMedia(
    identity: string,
    source: "camera" | "screen",
    requestedQuality: MediaQuality = "medium",
  ) {
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
    if (this.room)
      await this.room.switchActiveDevice(
        kind,
        deviceId || "default",
        Boolean(deviceId) || kind !== "videoinput",
      );
  }

  setRemoteVolume(volume: number) {
    this.outputVolume = Math.max(0, Math.min(1, volume));
    new Set([
      ...this.remoteVoiceAudio.keys(),
      ...this.remoteStreamAudio.keys(),
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
    if (!this.room) return;
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

  setTyping(typing: boolean) {
    if (!this.room) return;
    window.clearTimeout(this.typingTimer);
    void this.room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "typing", typing })),
      { reliable: false, topic: "mhtalk.chat" },
    );
    if (typing)
      this.typingTimer = window.setTimeout(() => this.setTyping(false), 1400);
  }

  /** Development-only fault injection. Real LiveKit reconnects use the same states. */
  simulateTransientDrop() {
    if (this.snapshot.state !== "connected" || this.room) return;
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

  private async joinLiveKit(roomName: string) {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.room = room;
    const syncParticipants = () => {
      this.update({
        localSpeaking: room.localParticipant.isSpeaking,
        participants: [...room.remoteParticipants.values()].map(
          (participant) => {
            const camera = participant.getTrackPublication(Track.Source.Camera);
            const screen = participant.getTrackPublication(
              Track.Source.ScreenShare,
            );
            return {
            identity: participant.identity,
            speaking: participant.isSpeaking,
            microphoneEnabled: participant.isMicrophoneEnabled,
            cameraEnabled: Boolean(camera && !camera.isMuted),
            screenShareEnabled: Boolean(screen && !screen.isMuted),
            cameraQuality: this.getParticipantMaximumQuality(
              participant.identity,
              "camera",
            ),
            screenShareQuality: this.getParticipantMaximumQuality(
              participant.identity,
              "screen",
            ),
            ...this.remoteProfiles.get(participant.identity),
            };
          },
        ),
      });
    };
    room.on(RoomEvent.ParticipantConnected, () => {
      this.playEventTone("join");
      syncParticipants();
      // A newcomer did not receive profile packets sent before they joined.
      // Re-announce the local profile so names, avatars and bios converge.
      void this.setProfile(this.profile);
      void this.requestProfiles();
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.playEventTone("leave");
      this.detachParticipantSource(participant.identity, "camera");
      this.detachParticipantSource(participant.identity, "screen");
      this.remoteVoiceAudio.delete(participant.identity);
      this.remoteStreamAudio.delete(participant.identity);
      this.remoteProfiles.delete(participant.identity);
      this.remoteMediaQuality.delete(participant.identity);
      syncParticipants();
    });
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
      if (
        publication.source === Track.Source.Camera ||
        publication.source === Track.Source.ScreenShare
      ) {
        this.playEventTone("media-start");
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
        this.playEventTone("media-stop");
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
      const details = await source.fetch({ roomName });
      await room.connect(details.serverUrl, details.participantToken, {
        autoSubscribe: false,
      });
    } else {
      const liveKitUrl = import.meta.env.VITE_LIVEKIT_URL;
      if (!liveKitUrl) throw new Error("LiveKit URL is missing");
      const credentials = await this.fetchToken(roomName);
      await room.connect(liveKitUrl, credentials.token, {
        autoSubscribe: false,
      });
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
    );
    if (this.snapshot.cameraEnabled) {
      const cameraId = this.preferredDevices.videoinput;
      await room.localParticipant.setCameraEnabled(
        true,
        cameraId ? { deviceId: { exact: cameraId } } : undefined,
      );
    }
    this.update({ state: "connected", roomName });
    this.subscribeToRemoteVoice();
    if (this.snapshot.cameraEnabled)
      this.attachLocalVideo(Track.Source.Camera, "Camera");
    void this.publishProfile();
    void this.requestProfiles();
    syncParticipants();
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
    if (!this.room) return;
    const safe = sanitizeProfile(this.profile);
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(
        JSON.stringify({ type: "profile", profile: safe }),
      ),
      { reliable: true, topic: "mhtalk.chat" },
    );
  }

  private async requestProfiles() {
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
    if (!this.room) return;
    await this.room.localParticipant.publishData(
      new TextEncoder().encode(
        JSON.stringify({ type: "media-quality", source, quality }),
      ),
      { reliable: true, topic: "mhtalk.chat" },
    );
  }

  private playEventTone(kind: "join" | "leave" | "media-start" | "media-stop") {
    const setting = kind === "join" || kind === "leave" ? "presence" : "media";
    if (!this.getEventSoundSettings()[setting]) return;
    try {
      const context = this.toneContext || new AudioContext();
      this.toneContext = context;
      void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + 0.01;
      const [from, to, duration] =
        kind === "join"
          ? [480, 720, 0.14]
          : kind === "leave"
            ? [620, 390, 0.16]
            : kind === "media-start"
              ? [720, 980, 0.11]
              : [520, 340, 0.13];
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(from, start);
      oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.045, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    } catch {
      /* Audio can be blocked until the first user gesture. */
    }
  }

  private async fetchToken(roomName: string) {
    const endpoint = import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT;
    if (!endpoint) throw new Error("Token endpoint is missing");
    const accountToken = accountSession.getAccessToken();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(accountToken ? { authorization: `Bearer ${accountToken}` } : {}),
      },
      body: JSON.stringify({ roomName, inviteCode: this.inviteCode }),
    });
    if (!response.ok) throw new Error("Token service unavailable");
    const payload = (await response.json()) as {
      token?: string;
      roomName?: string;
    };
    if (!payload.token || !payload.roomName)
      throw new Error("Invalid token response");
    return { token: payload.token, roomName: payload.roomName };
  }

  private isLiveKitConfigured() {
    return Boolean(
      import.meta.env.VITE_LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID ||
      (import.meta.env.VITE_LIVEKIT_URL &&
        import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT),
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
    const endpoint = import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT;
    if (!endpoint) return local;
    try {
      const response = await fetch(new URL("/moderate", endpoint), {
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
  return {
    name: name || fallbackIdentity.slice(0, 16) || "Member",
    bio,
    avatar: avatar || (name || fallbackIdentity || "M")[0].toUpperCase(),
  };
}

export const roomSession = new RoomSession();
