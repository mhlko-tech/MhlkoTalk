import { Room, RoomEvent, TokenSource, Track } from "livekit-client";
import type {
  ChatListener,
  ChatMessage,
  ChatSnapshot,
  SessionListener,
  SessionSnapshot,
  UserProfile,
} from "../core/types";
import { moderateMainMessage } from "../core/moderation";

const initialSnapshot: SessionSnapshot = {
  state: "idle",
  roomName: null,
  microphoneEnabled: true,
  localSpeaking: false,
  cameraEnabled: false,
  screenShareEnabled: false,
  screenShareAudioEnabled: false,
  recoveryAttempt: 0,
  lastRecoveryMs: null,
  participants: [],
};

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
  private outputVolume = 1;
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

  async setScreenShareEnabled(enabled: boolean, includeSystemAudio = false) {
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
      await this.room.localParticipant.setScreenShareEnabled(true, {
        video: true,
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
      });
      this.attachLocalVideo(Track.Source.ScreenShare, "Screen share");
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
    this.profile = profile;
    localStorage.setItem("mhtalk.profile.name", profile.name);
    localStorage.setItem("mhtalk.profile.bio", profile.bio);
    localStorage.setItem("mhtalk.profile.avatar", profile.avatar);
    if (this.room)
      await this.room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: "profile", profile })),
        { reliable: true, topic: "mhtalk.chat" },
      );
  }

  getProfile() {
    return this.profile;
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
          (participant) => ({
            identity: participant.identity,
            speaking: participant.isSpeaking,
            microphoneEnabled: participant.isMicrophoneEnabled,
            cameraEnabled: participant.isCameraEnabled,
            screenShareEnabled: participant.isScreenShareEnabled,
            ...this.remoteProfiles.get(participant.identity),
          }),
        ),
      });
    };
    room.on(RoomEvent.ParticipantConnected, syncParticipants);
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.detachParticipantSource(participant.identity, "camera");
      this.detachParticipantSource(participant.identity, "screen");
      this.remoteVoiceAudio.delete(participant.identity);
      this.remoteStreamAudio.delete(participant.identity);
      syncParticipants();
    });
    room.on(RoomEvent.ActiveSpeakersChanged, syncParticipants);
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
      if (publication.kind !== Track.Kind.Video) return;
      this.detachMedia(`remote-${publication.trackSid}`);
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
        if (event.type === "profile" && event.profile) {
          this.remoteProfiles.set(participant.identity, event.profile);
          this.chat = {
            ...this.chat,
            messages: this.chat.messages.map((message) =>
              message.senderIdentity === participant.identity
                ? { ...message, sender: event.profile!.name }
                : message,
            ),
          };
          this.emitChat();
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
        autoSubscribe: true,
      });
    } else {
      const liveKitUrl = import.meta.env.VITE_LIVEKIT_URL;
      if (!liveKitUrl) throw new Error("LiveKit URL is missing");
      const credentials = await this.fetchToken(roomName);
      await room.connect(liveKitUrl, credentials.token, {
        autoSubscribe: true,
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
    if (this.snapshot.cameraEnabled)
      this.attachLocalVideo(Track.Source.Camera, "Camera");
    void this.setProfile(this.profile);
    syncParticipants();
  }

  private async fetchToken(roomName: string) {
    const endpoint = import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT;
    if (!endpoint) throw new Error("Token endpoint is missing");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
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

export const roomSession = new RoomSession();
