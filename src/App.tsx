import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type {
  ChatMessage,
  ChatSnapshot,
  SessionSnapshot,
  UserProfile,
} from "./core/types";
import { roomSession } from "./services/roomSession";
import {
  startAutomaticUpdater,
  type UpdateActivity,
} from "./services/appUpdater";

const initial: SessionSnapshot = {
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
const emptyChat: ChatSnapshot = { messages: [], typing: [] };
const emojiList = [
  "😀",
  "😂",
  "🥹",
  "😍",
  "😎",
  "😭",
  "👍",
  "👎",
  "❤️",
  "🔥",
  "🎉",
  "🤝",
  "✅",
  "❌",
  "💯",
  "🚀",
  "👀",
  "🙏",
  "🎮",
  "☕",
  "🇮🇶",
  "🇹🇷",
  "🌙",
  "✨",
];

type InfoPage = "help" | "terms" | "privacy";

const infoPages: Record<InfoPage, { title: string; paragraphs: string[] }> = {
  help: {
    title: "Help Center",
    paragraphs: [
      "MHTalk is a desktop voice, video, screen-sharing and room-chat application. Use Main for public conversation and private-room invitations only with people you trust.",
      "Before sharing a screen, camera, microphone, file or recording, confirm that everyone affected has consented. Never expose passwords, payment details, private messages or other sensitive information.",
      "If audio becomes unstable, keep MHTalk open while it reconnects automatically. Check the selected microphone and speaker under Settings if sound does not return.",
      "MHTalk must not be used for harassment, threats, impersonation, piracy, sexual exploitation, malware distribution or any activity forbidden by local law. You are responsible for what you publish and record.",
    ],
  },
  terms: {
    title: "Terms of Service",
    paragraphs: [
      "By using MHTalk you agree to use it lawfully, respect other people and obtain any permission required before recording or redistributing their voice, image, screen or files.",
      "You must not bypass room protections, disrupt the service, distribute harmful files, infringe intellectual-property rights, or use MHTalk to abuse, exploit or endanger another person.",
      "Public-room moderation reduces obvious harmful text but cannot guarantee that every language, spelling or attachment is safe. Users remain responsible for their conduct and for deciding what they open or download.",
      "The software is provided as available. Network providers, devices and third-party infrastructure can affect quality. These terms do not remove any non-waivable rights granted by applicable law.",
    ],
  },
  privacy: {
    title: "Privacy Policy",
    paragraphs: [
      "Your profile is stored on your device and shared with people in the room when needed to display your name, avatar and bio. Room media and messages are transmitted through the configured communication service.",
      "MHTalk does not intentionally sell personal data. Files, recordings and recovered recording pieces remain on the device paths selected by you unless you deliberately send them.",
      "People in a room may capture or redistribute what they receive. Share only what you are comfortable revealing and use private invitations carefully.",
      "You can remove your profile photo, leave a room, delete local recordings and stop camera, microphone or screen sharing at any time from the application controls.",
    ],
  },
};

function statusLabel(state: SessionSnapshot["state"]) {
  if (state === "connected") return "Connected";
  if (state === "connecting") return "Connecting";
  // Transient recovery is intentionally not exposed as a disconnect to the user.
  if (state === "recovering") return "Connected";
  if (state === "failed") return "Connection unavailable";
  return "Not connected";
}

export function App() {
  const [session, setSession] = useState(initial);
  const [room, setRoom] = useState("Main");
  const [privateInvite, setPrivateInvite] = useState<string | null>(null);
  const [mainActiveCount, setMainActiveCount] = useState(0);
  const [privateDialogOpen, setPrivateDialogOpen] = useState(false);
  const [privateCode, setPrivateCode] = useState("");
  const [appError, setAppError] = useState("");
  const [updateActivity, setUpdateActivity] = useState<UpdateActivity | null>(null);
  const [chat, setChat] = useState(emptyChat);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [transferProgress, setTransferProgress] = useState<number | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<File | null>(null);
  const [pendingAttachmentUrl, setPendingAttachmentUrl] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [infoPage, setInfoPage] = useState<InfoPage | null>(null);
  const [viewProfile, setViewProfile] = useState<UserProfile | null>(null);
  const [viewImage, setViewImage] = useState<{
    url: string;
    name: string;
  } | null>(null);
  const [profile, setProfile] = useState<UserProfile>(() =>
    roomSession.getProfile(),
  );
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [remoteVolume, setRemoteVolume] = useState(() => {
    const stored = localStorage.getItem("mhtalk.output-volume");
    if (stored === null) return 100;
    const saved = Number(stored);
    return Number.isFinite(saved) && saved >= 0 && saved <= 100 ? saved : 100;
  });
  const [microphoneDevice, setMicrophoneDevice] = useState(
    () => localStorage.getItem("mhtalk.device.audioinput") || "",
  );
  const [cameraDevice, setCameraDevice] = useState(
    () => localStorage.getItem("mhtalk.device.videoinput") || "",
  );
  const [speakerDevice, setSpeakerDevice] = useState(
    () => localStorage.getItem("mhtalk.device.audiooutput") || "",
  );
  const [testingMicrophone, setTestingMicrophone] = useState(false);
  const [testingSpeaker, setTestingSpeaker] = useState(false);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [chatWidth, setChatWidth] = useState(350);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    message?: ChatMessage;
    composer?: boolean;
  } | null>(null);
  const [mediaMenu, setMediaMenu] = useState<{
    x: number;
    y: number;
    id: string;
    identity?: string;
    local?: boolean;
    source?: "camera" | "screen";
    voiceVolume: number;
    streamVolume: number;
  } | null>(null);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [cropImageSize, setCropImageSize] = useState({ width: 1, height: 1 });
  const avatarInput = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transferAbort = useRef<AbortController | null>(null);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const [bottomMessageLabel, setBottomMessageLabel] = useState("New message");
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const recorderStudioOpening = useRef(false);

  useEffect(() => roomSession.subscribe(setSession), []);
  useEffect(() => roomSession.subscribeChat(setChat), []);
  useEffect(() => roomSession.setRemoteVolume(remoteVolume / 100), []);
  useEffect(() => startAutomaticUpdater(setUpdateActivity), []);
  useEffect(() => {
    if (!viewImage) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewImage(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [viewImage]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const endpoint = import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT;
      if (!endpoint) return;
      try {
        const response = await fetch(new URL("/room-count", endpoint), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roomName: "Main" }),
        });
        const payload = (await response.json()) as { count?: unknown };
        if (!disposed && response.ok && typeof payload.count === "number")
          setMainActiveCount(Math.max(0, payload.count));
      } catch {
        if (!disposed && session.roomName === "Main")
          setMainActiveCount(session.participants.length + 1);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [session.roomName, session.participants.length]);
  useEffect(() => {
    if (!pendingAttachment) {
      setPendingAttachmentUrl("");
      return;
    }
    const url = URL.createObjectURL(pendingAttachment);
    setPendingAttachmentUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingAttachment]);
  useEffect(() => {
    const closeFromBackdrop = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.classList.contains("modal-backdrop")
      )
        return;
      target.querySelector<HTMLButtonElement>(".modal-close")?.click();
    };
    document.addEventListener("pointerdown", closeFromBackdrop);
    return () => document.removeEventListener("pointerdown", closeFromBackdrop);
  }, []);
  useEffect(() => {
    if (!settingsOpen) return;
    let disposed = false;
    const refreshDevices = async () => {
      let permissionStream: MediaStream | null = null;
      try {
        const initialDevices = await navigator.mediaDevices.enumerateDevices();
        const cameraNamesLocked = initialDevices.some(
          (device) => device.kind === "videoinput" && !device.label,
        );
        if (cameraNamesLocked) {
          permissionStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        }
      } catch {
        // Keep the settings usable even if Windows camera access was denied.
      } finally {
        permissionStream?.getTracks().forEach((track) => track.stop());
      }
      const nextDevices = await navigator.mediaDevices.enumerateDevices();
      if (!disposed) setDevices(nextDevices);
    };
    const handleDeviceChange = () => void refreshDevices();
    void refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, [settingsOpen]);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          x: number;
          y: number;
          id: string;
          identity?: string;
          local?: boolean;
          source?: "camera" | "screen";
        }>
      ).detail;
      const volumes = detail.identity
        ? roomSession.getParticipantVolumes(detail.identity)
        : { voice: 100, stream: 100 };
      setMediaMenu({
        ...detail,
        voiceVolume: volumes.voice,
        streamVolume: volumes.stream,
      });
    };
    const closeDetachedMedia = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail.id;
      setMediaMenu((current) => (current?.id === id ? null : current));
    };
    window.addEventListener("mhtalk-media-context", handler);
    window.addEventListener("mhtalk-media-detached", closeDetachedMedia);
    return () => {
      window.removeEventListener("mhtalk-media-context", handler);
      window.removeEventListener("mhtalk-media-detached", closeDetachedMedia);
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (disposed) return;
        if (event.payload.type === "leave") {
          setDragging(false);
          return;
        }
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
          return;
        }
        setDragging(false);
        for (const path of event.payload.paths) {
          const bytes = await invoke<number[]>("read_dropped_file", { path });
          const name = path.split(/[/\\]/).at(-1) || "attachment";
          await sendAttachment(
            new File([new Uint8Array(Array.from(bytes))], name, {
              type: mimeFromName(name),
            }),
          );
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    const host = messagesRef.current;
    if (!host) return;
    const atBottom =
      host.scrollHeight - host.scrollTop - host.clientHeight < 36;
    if (atBottom) {
      host.scrollTop = host.scrollHeight;
      setShowNewMessages(false);
    } else if (chat.messages.length) {
      setBottomMessageLabel(
        chat.messages.at(-1)?.mine ? "Your last message" : "New message",
      );
      setShowNewMessages(true);
    }
  }, [chat.messages.length]);
  const active =
    session.state === "connected" || session.state === "recovering";
  const roomTransitioning = session.state === "connecting";
  const visibleStatus =
    session.state === "recovering" ? "connected" : session.state;
  const displayRoomName = session.roomName?.startsWith("Private-")
    ? "Private channel"
    : (session.roomName ?? "Welcome to MHTalk");
  const enterRoom = async (roomName: string, invite?: string) => {
    if (active && session.roomName !== roomName) await roomSession.leave();
    await roomSession.join(roomName, invite);
  };
  const joinRoomInput = async () => {
    const value = room.trim();
    await enterRoom(value || "Main");
  };
  const createPrivateRoom = async () => {
    try {
      const privateRoom = await roomSession.createPrivateRoom();
      setPrivateInvite(privateRoom.code);
      setRoom(privateRoom.roomName);
      if (active) await roomSession.leave();
      await roomSession.join(privateRoom.roomName, privateRoom.code);
      setPrivateDialogOpen(false);
    } catch {
      // The current screen remains usable; a production implementation will add
      // a non-intrusive retry control here.
    }
  };
  const joinPrivateRoom = async () => {
    const code = privateCode.trim().toUpperCase();
    if (!/^MHTALK-[A-Z0-9]{5}$/.test(code)) return;
    if (active) await roomSession.leave();
    setPrivateInvite(code);
    await roomSession.join("Private room", code);
    setPrivateDialogOpen(false);
  };
  const sendMessage = async () => {
    const message = draft;
    const attachment = pendingAttachment;
    if (!message.trim() && !attachment) return;
    setDraft("");
    setPendingAttachment(null);
    if (attachment) await sendAttachment(attachment);
    if (editing && message.trim()) {
      await roomSession.editChatMessage(editing.id, message);
      setEditing(null);
    } else if (message.trim())
      await roomSession.sendChatMessage(
        message,
        reply
          ? { id: reply.id, sender: reply.sender, body: messagePreview(reply) }
          : undefined,
      );
    setReply(null);
    roomSession.setTyping(false);
  };
  const saveProfile = async () => {
    await roomSession.setProfile(profile);
    setProfileOpen(false);
  };
  const resizeChat = (event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = chatWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) =>
      setChatWidth(
        Math.max(290, Math.min(720, startWidth + startX - moveEvent.clientX)),
      );
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  const saveAttachment = async (message?: ChatMessage) => {
    if (!message?.attachment) return;
    const buffer = (await fetch(message.attachment.url).then((response) =>
      response.arrayBuffer(),
    )) as ArrayBuffer;
    const bytes = Array.from(new Uint8Array(buffer));
    await invoke("save_attachment", {
      defaultName: message.attachment.name,
      bytes,
    });
  };
  const openMediaFullscreen = () => {
    const video =
      mediaMenu &&
      document.querySelector<HTMLVideoElement>(
        `#${CSS.escape(mediaMenu.id)} video`,
      );
    void video?.requestFullscreen?.();
    setMediaMenu(null);
  };
  const openPictureInPicture = async () => {
    const video =
      mediaMenu &&
      document.querySelector<HTMLVideoElement>(
        `#${CSS.escape(mediaMenu.id)} video`,
      );
    if (video && document.pictureInPictureEnabled)
      await video.requestPictureInPicture();
    setMediaMenu(null);
  };
  const beginAvatarCrop = (file?: File) => {
    if (!file || !file.type.startsWith("image/")) return;
    if (
      file.type === "image/gif" ||
      file.type === "image/webp" ||
      file.type === "image/apng"
    ) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string")
          setProfile((current) => ({
            ...current,
            avatar: reader.result as string,
          }));
      };
      reader.readAsDataURL(file);
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setCropImageSize({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      setCropSource(url);
      setCropZoom(1);
      setCropX(0);
      setCropY(0);
    };
    image.src = url;
  };
  const saveAvatarCrop = async () => {
    if (!cropSource) return;
    const avatar = await cropAvatar(
      cropSource,
      cropZoom,
      cropX,
      cropY,
      cropImageSize,
    );
    URL.revokeObjectURL(cropSource);
    setCropSource(null);
    setProfile({ ...profile, avatar });
  };
  const sendAttachment = async (file?: File) => {
    if (!file) return;
    const controller = new AbortController();
    transferAbort.current = controller;
    setTransferProgress(0);
    try {
      await roomSession.sendFile(file, setTransferProgress, controller.signal);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") throw error;
    } finally {
      if (transferAbort.current === controller) transferAbort.current = null;
      setTransferProgress(null);
    }
  };
  const toggleVoiceMessage = async () => {
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneDevice
          ? { deviceId: { exact: microphoneDevice } }
          : true,
      });
      recordingChunks.current = [];
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : undefined,
      });
      recorder.current = mediaRecorder;
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunks.current.push(event.data);
      };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(recordingChunks.current, {
          type: mediaRecorder.mimeType || "audio/webm",
        });
        void sendAttachment(
          new File([blob], `voice-message-${Date.now()}.webm`, {
            type: blob.type,
          }),
        );
      };
      mediaRecorder.start(250);
      setRecording(true);
    } catch {
      setRecording(false);
    }
  };
  const openRecorderStudio = () => {
    if (recorderStudioOpening.current) return;
    recorderStudioOpening.current = true;
    void WebviewWindow.getByLabel("recorder-studio")
      .then((window) => {
        if (window) {
          recorderStudioOpening.current = false;
          void window.show();
          void window.setFocus();
          return;
        }
        const studio = new WebviewWindow("recorder-studio", {
          url: "/#recorder-studio",
          title: "MHTalk Studio",
          width: 1180,
          height: 760,
          minWidth: 900,
          minHeight: 620,
          center: true,
          resizable: true,
          decorations: false,
        });
        studio.once("tauri://created", () => {
          recorderStudioOpening.current = false;
          void invoke("apply_window_icon", { label: "recorder-studio" });
        });
        studio.once("tauri://error", (event) => {
          recorderStudioOpening.current = false;
          setAppError(
            `Could not open Recorder Studio: ${String(event.payload)}`,
          );
        });
      })
      .catch((error) => {
        recorderStudioOpening.current = false;
        setAppError(`Could not open Recorder Studio: ${String(error)}`);
      });
  };
  const testMicrophone = async () => {
    if (testingMicrophone) return;
    setTestingMicrophone(true);
    setMicrophoneLevel(0);
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let monitor: HTMLAudioElement | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: microphoneDevice
            ? { exact: microphoneDevice }
            : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      monitor = new Audio();
      monitor.srcObject = stream;
      monitor.volume = remoteVolume / 100;
      if (speakerDevice && "setSinkId" in monitor) {
        await (
          monitor as HTMLAudioElement & {
            setSinkId(deviceId: string): Promise<void>;
          }
        ).setSinkId(speakerDevice);
      }
      await monitor.play();
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      while (performance.now() - startedAt < 3000) {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const value = (sample - 128) / 128;
          sum += value * value;
        }
        setMicrophoneLevel(
          Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 320)),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 55));
      }
    } catch {
      setAppError(
        "Microphone test failed. Check Windows microphone permission.",
      );
    } finally {
      monitor?.pause();
      if (monitor) monitor.srcObject = null;
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close();
      setMicrophoneLevel(0);
      setTestingMicrophone(false);
      void navigator.mediaDevices.enumerateDevices().then(setDevices);
    }
  };

  const testSpeaker = async () => {
    if (testingSpeaker) return;
    setTestingSpeaker(true);
    let context: AudioContext | null = null;
    try {
      context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 620;
      gain.gain.value = Math.max(0.02, remoteVolume / 100) * 0.16;
      oscillator.connect(gain).connect(destination);
      const audio = new Audio();
      audio.srcObject = destination.stream;
      if (speakerDevice && "setSinkId" in audio) {
        await (
          audio as HTMLAudioElement & {
            setSinkId(deviceId: string): Promise<void>;
          }
        ).setSinkId(speakerDevice);
      }
      await audio.play();
      oscillator.start();
      oscillator.stop(context.currentTime + 0.8);
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      audio.pause();
      audio.srcObject = null;
    } catch {
      setAppError("Speaker test failed. Select another output device.");
    } finally {
      await context?.close();
      setTestingSpeaker(false);
    }
  };

  return (
    <main
      className="app-shell"
      style={{ "--chat-width": `${chatWidth}px` } as React.CSSProperties}
      onContextMenu={(event) => event.preventDefault()}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        void sendAttachment(event.dataTransfer.files[0]);
      }}
      onClick={() => {
        setContextMenu(null);
        setMediaMenu(null);
        setProfileMenuOpen(false);
        setHelpMenuOpen(false);
      }}
    >
      {updateActivity && (
        <div className="update-activity" aria-live="polite">
          <span>
            {updateActivity.phase === "installing"
              ? "Installing update…"
              : `Updating MHTalk${updateActivity.progress === null ? "" : ` · ${updateActivity.progress}%`}`}
          </span>
          {updateActivity.progress !== null && (
            <i style={{ width: `${updateActivity.progress}%` }} />
          )}
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <span><img src="/mhtalk-icon.png" alt="" /></span>
          <div>MHTalk</div>
        </div>
        <div className="section-label">Rooms</div>
        <button
          className={`room ${session.roomName === "Main" ? "active" : ""}`}
          onClick={() => {
            setPrivateInvite(null);
            setRoom("Main");
            void enterRoom("Main");
          }}
        >
          # Main channel
          <span className="main-active-count">
            {session.roomName === "Main"
              ? session.participants.length + 1
              : mainActiveCount}{" "}
            active
          </span>
        </button>
        <button
          className="room private-room"
          onClick={() => setPrivateDialogOpen(true)}
        >
          ＋ Private channel
        </button>
        {privateInvite && (
          <div className="invite">
            <strong>Private invite</strong>
            <code>{privateInvite}</code>
            <small>Share this complete code only with your friend.</small>
          </div>
        )}
        <div className="participants">
          <div className="section-label">
            In this room · {session.participants.length + (active ? 1 : 0)}
          </div>
          {active && (
            <button
              className={`participant ${session.microphoneEnabled ? "speaking" : ""}`}
              onClick={() => setViewProfile(profile)}
            >
              <Avatar value={profile.avatar} />
              <span>{profile.name}</span>
              <small>{session.microphoneEnabled ? "Mic on" : "Mic off"}</small>
            </button>
          )}
          {session.participants.map((participant) => (
            <button
              className={`participant ${participant.speaking ? "speaking" : ""}`}
              onClick={() =>
                setViewProfile({
                  name: participant.name || participant.identity.slice(0, 12),
                  bio: participant.bio || "",
                  avatar:
                    participant.avatar ||
                    participant.identity.slice(0, 1).toUpperCase(),
                })
              }
              key={participant.identity}
            >
              <Avatar
                value={
                  participant.avatar ||
                  participant.identity.slice(0, 1).toUpperCase()
                }
                remote
              />
              <span>
                {participant.name || participant.identity.slice(0, 12)}
              </span>
              <small>{participant.speaking ? "Speaking" : "Listening"}</small>
            </button>
          ))}
        </div>
        <div className="profile-area">
          <button className="profile" onClick={() => setViewProfile(profile)}>
            <Avatar value={profile.avatar} />
            <div>
              <strong>{profile.name}</strong>
              <small>{statusLabel(session.state)}</small>
            </div>
          </button>
          <button
            className="profile-more"
            aria-label="Open profile menu"
            title="Profile menu"
            onClick={(event) => {
              event.stopPropagation();
              setProfileMenuOpen((open) => !open);
              setHelpMenuOpen(false);
            }}
          >
            ⋯
          </button>
          {profileMenuOpen && (
            <div
              className="profile-menu"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                onClick={() => {
                  setProfileMenuOpen(false);
                  setProfileOpen(true);
                }}
              >
                <span>◉</span> Edit profile
              </button>
              <button
                onClick={() => {
                  setProfileMenuOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <span>⚙</span> Settings
              </button>
              <div className="menu-separator" />
              <button
                onClick={() => setHelpMenuOpen((open) => !open)}
                aria-expanded={helpMenuOpen}
              >
                <span>?</span> Help <b>›</b>
              </button>
              {helpMenuOpen && (
                <div className="help-submenu">
                  <button
                    onClick={() => {
                      setInfoPage("help");
                      setProfileMenuOpen(false);
                      setHelpMenuOpen(false);
                    }}
                  >
                    Help Center
                  </button>
                  <div className="menu-separator" />
                  <button
                    onClick={() => {
                      setInfoPage("terms");
                      setProfileMenuOpen(false);
                      setHelpMenuOpen(false);
                    }}
                  >
                    Terms of Service
                  </button>
                  <button
                    onClick={() => {
                      setInfoPage("privacy");
                      setProfileMenuOpen(false);
                      setHelpMenuOpen(false);
                    }}
                  >
                    Privacy Policy
                  </button>
                  <button
                    onClick={() => {
                      void invoke("open_report_bug");
                      setProfileMenuOpen(false);
                      setHelpMenuOpen(false);
                    }}
                  >
                    Report a bug
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      <section className="content">
        <header>
          <div>
            <h1>{displayRoomName}</h1>
          </div>
          <span className={`status ${visibleStatus}`}>
            {statusLabel(session.state)}
          </span>
        </header>

        <div className="stage">
          {active ? (
            <div
              id="media-stage"
              className="media-stage"
              aria-label="People, cameras and screen shares"
            >
              <ParticipantMediaCard
                identity="local"
                name={profile.name}
                avatar={profile.avatar}
                bio={profile.bio}
                speaking={session.localSpeaking}
                microphoneEnabled={session.microphoneEnabled}
                local
                onProfile={setViewProfile}
              />
              {session.participants.map((participant) => (
                <ParticipantMediaCard
                  key={participant.identity}
                  identity={participant.identity}
                  name={participant.name || participant.identity.slice(0, 12)}
                  avatar={
                    participant.avatar ||
                    participant.identity.slice(0, 1).toUpperCase()
                  }
                  bio={participant.bio || ""}
                  speaking={participant.speaking}
                  microphoneEnabled={participant.microphoneEnabled}
                  onProfile={setViewProfile}
                />
              ))}
            </div>
          ) : (
            <div className="voice-card">
              <div className={`signal ${session.state}`}>
                <span></span>
                <span></span>
                <span></span>
                <span></span>
              </div>
              <h2>Ready when you are</h2>
              <p>Join Main channel or create a private room.</p>
            </div>
          )}
        </div>

        <footer className="controls">
          <button
            className="control icon-control record-control"
            onClick={openRecorderStudio}
            title="Recorder Studio"
            aria-label="Recorder Studio"
          >
            ⏺️
          </button>
          <button
            className={`${session.microphoneEnabled ? "control enabled" : "control"} icon-control`}
            disabled={!active || roomTransitioning}
            onClick={() =>
              roomSession.setMicrophoneEnabled(!session.microphoneEnabled)
            }
            title={
              session.microphoneEnabled
                ? "Mute microphone"
                : "Enable microphone"
            }
            aria-label={
              session.microphoneEnabled
                ? "Mute microphone"
                : "Enable microphone"
            }
          >
            🎙️
          </button>
          <button
            className={`${session.cameraEnabled ? "control enabled" : "control"} icon-control`}
            disabled={!active || roomTransitioning}
            onClick={() => roomSession.setCameraEnabled(!session.cameraEnabled)}
            title={session.cameraEnabled ? "Turn camera off" : "Turn camera on"}
            aria-label={
              session.cameraEnabled ? "Turn camera off" : "Turn camera on"
            }
          >
            📷
          </button>
          <button
            className={`${session.screenShareEnabled ? "control enabled" : "control"} icon-control`}
            disabled={!active || roomTransitioning}
            onClick={() =>
              roomSession.setScreenShareEnabled(
                !session.screenShareEnabled,
                true,
              )
            }
            title={session.screenShareEnabled ? "Stop sharing" : "Share screen"}
            aria-label={
              session.screenShareEnabled ? "Stop sharing" : "Share screen"
            }
          >
            🖥️
          </button>
          <button
            className="danger icon-control"
            disabled={!active && !roomTransitioning}
            onClick={() => roomSession.leave()}
            title="Leave room"
            aria-label="Leave room"
          >
            📞
          </button>
        </footer>
      </section>
      <div className="chat-resizer" onPointerDown={resizeChat} />
      <aside className={`chat-panel ${dragging ? "dragging" : ""}`}>
        <div className="chat-header">
          <strong>Room chat</strong>
          <small>
            {session.roomName ? displayRoomName : "Join a room to chat"}
          </small>
        </div>
        <div
          ref={messagesRef}
          className="chat-messages"
          aria-live="polite"
          onScroll={(event) => {
            const target = event.currentTarget;
            if (
              target.scrollHeight - target.scrollTop - target.clientHeight <
              36
            )
              setShowNewMessages(false);
          }}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setDragging(false);
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            setDragging(false);
            void sendAttachment(event.dataTransfer.files[0]);
          }}
        >
          {chat.messages.length === 0 && (
            <div className="chat-empty">
              Messages, emojis, voice notes and attachments appear here.
            </div>
          )}
          {chat.messages.map((message) => (
            <article
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({ x: event.clientX, y: event.clientY, message });
              }}
              id={`message-${message.id}`}
              className={`chat-message ${message.mine ? "mine" : ""}`}
              key={message.id}
            >
              <div className="chat-author">
                {message.sender}
                <time>
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <button
                  onClick={() => {
                    setReply(message);
                    requestAnimationFrame(() => composerRef.current?.focus());
                  }}
                  title="Reply"
                >
                  ↩
                </button>
                {message.mine && (
                  <>
                    <button
                      onClick={() => {
                        setEditing(message);
                        setDraft(message.body || "");
                        requestAnimationFrame(() =>
                          composerRef.current?.focus(),
                        );
                      }}
                      title="Edit"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() =>
                        void roomSession.deleteChatMessage(message.id)
                      }
                      title="Delete"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
              {message.replyTo && (
                <button
                  className="reply-link"
                  onClick={() =>
                    document
                      .getElementById(`message-${message.replyTo?.id}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "center" })
                  }
                >
                  ↩ {message.replyTo.sender}: {message.replyTo.body}
                </button>
              )}
              {message.deleted ? (
                <p className="deleted">Message deleted</p>
              ) : (
                <>
                  {message.body && <p>{message.body}</p>}
                  {message.attachment && (
                    <Attachment
                      attachment={message.attachment}
                      onOpenImage={(url, name) => setViewImage({ url, name })}
                    />
                  )}
                </>
              )}
            </article>
          ))}
        </div>
        {showNewMessages && (
          <button
            className="new-messages"
            onClick={() => {
              const host = messagesRef.current;
              if (host) host.scrollTop = host.scrollHeight;
              setShowNewMessages(false);
            }}
          >
            ↓ {bottomMessageLabel}
          </button>
        )}
        {chat.typing.length > 0 && (
          <div className="typing">{chat.typing.join(", ")} typing…</div>
        )}
        {transferProgress !== null && (
          <div className="transfer">
            Sending attachment {Math.round(transferProgress * 100)}%{" "}
            <button onClick={() => transferAbort.current?.abort()}>Stop</button>
          </div>
        )}
        {(reply || editing) && (
          <div className="replying">
            {editing ? "Editing message" : `Replying to ${reply?.sender}`}{" "}
            <button
              onClick={() => {
                setReply(null);
                setEditing(null);
                setDraft("");
              }}
            >
              ×
            </button>
          </div>
        )}
        <div className="chat-compose">
          {pendingAttachment && (
            <div className="pending-attachment">
              {pendingAttachment.type.startsWith("image/") && (
                <img src={pendingAttachmentUrl} alt="Attachment preview" />
              )}
              {pendingAttachment.type.startsWith("video/") && (
                <video src={pendingAttachmentUrl} muted />
              )}
              <span>
                <strong>{pendingAttachment.name}</strong>
                <small>
                  {Math.max(1, Math.ceil(pendingAttachment.size / 1024))} KB
                </small>
              </span>
              <button
                title="Remove attachment"
                aria-label="Remove attachment"
                onClick={() => setPendingAttachment(null)}
              >
                ×
              </button>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(event) => {
              void sendAttachment(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button
            className="chat-icon"
            disabled={!active}
            onClick={() => fileInput.current?.click()}
            title="Send a file"
          >
            ＋
          </button>
          <button
            className="chat-icon"
            disabled={!active}
            onClick={() => setEmojiOpen(!emojiOpen)}
            title="Emoji"
          >
            ☺
          </button>
          <button
            className={`chat-icon ${recording ? "recording" : ""}`}
            disabled={!active}
            onClick={() => void toggleVoiceMessage()}
            title={recording ? "Stop voice message" : "Voice message"}
          >
            {recording ? "■" : "●"}
          </button>
          <textarea
            ref={composerRef}
            disabled={!active}
            value={draft}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                composer: true,
              });
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              roomSession.setTyping(Boolean(event.target.value));
            }}
            onPaste={(event) => {
              const item = [...event.clipboardData.items].find(
                (clipboardItem) =>
                  clipboardItem.kind === "file" &&
                  (clipboardItem.type.startsWith("image/") ||
                    clipboardItem.type.startsWith("video/")),
              );
              const file = item?.getAsFile();
              if (!file) return;
              event.preventDefault();
              const extension = file.type.split("/")[1]?.split("+")[0] || "bin";
              setPendingAttachment(
                new File([file], `clipboard-${Date.now()}.${extension}`, {
                  type: file.type,
                }),
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && pendingAttachment) {
                event.preventDefault();
                setPendingAttachment(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={active ? "Write a message" : "Join a room to chat"}
            aria-label="Chat message"
            rows={1}
          />
          <button
            className="send-message"
            disabled={!active || (!draft.trim() && !pendingAttachment)}
            onClick={() => void sendMessage()}
          >
            Send
          </button>
        </div>
        {emojiOpen && (
          <div className="emoji-picker">
            {emojiList.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  setDraft((value) => `${value}${emoji}`);
                  setEmojiOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </aside>
      {privateDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="private-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Private channel"
          >
            <button
              className="modal-close"
              onClick={() => setPrivateDialogOpen(false)}
            >
              ×
            </button>
            <h2>Private channel</h2>
            <p>Create a new private room or join with a friend’s code.</p>
            <button
              className="primary modal-create"
              onClick={() => void createPrivateRoom()}
            >
              Create private room
            </button>
            <div className="modal-divider">or join</div>
            <input
              value={privateCode}
              onChange={(event) =>
                setPrivateCode(event.target.value.toUpperCase())
              }
              placeholder="MHTALK-09H2Z"
              aria-label="Private room code"
            />
            <button
              className="control modal-join"
              onClick={() => void joinPrivateRoom()}
            >
              Join with code
            </button>
          </section>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop">
          <section className="private-modal settings-modal compact-settings">
            <button
              className="modal-close"
              onClick={() => setSettingsOpen(false)}
            >
              ×
            </button>
            <h2>Settings</h2>
            <label>
              Microphone
              <select
                value={microphoneDevice}
                onChange={(event) => {
                  setMicrophoneDevice(event.target.value);
                  void roomSession.setDevice("audioinput", event.target.value);
                }}
              >
                <option value="">Default microphone</option>
                {devices
                  .filter((device) => device.kind === "audioinput")
                  .map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || "Microphone"}
                    </option>
                  ))}
              </select>
            </label>
            <div className="device-test-row">
              <button
                className="control"
                disabled={testingMicrophone}
                onClick={() => void testMicrophone()}
              >
                {testingMicrophone ? "Testing microphone…" : "Test microphone"}
              </button>
              <div
                className="microphone-meter"
                aria-label={`Microphone level ${microphoneLevel}%`}
              >
                <i style={{ width: `${microphoneLevel}%` }} />
              </div>
            </div>
            <label>
              Camera
              <select
                value={cameraDevice}
                onChange={(event) => {
                  setCameraDevice(event.target.value);
                  void roomSession.setDevice("videoinput", event.target.value);
                }}
              >
                <option value="">Default camera</option>
                {devices
                  .filter((device) => device.kind === "videoinput")
                  .map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Speaker
              <select
                value={speakerDevice}
                onChange={(event) => {
                  setSpeakerDevice(event.target.value);
                  void roomSession.setDevice("audiooutput", event.target.value);
                }}
              >
                <option value="">Default speaker</option>
                {devices
                  .filter((device) => device.kind === "audiooutput")
                  .map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || "Speaker"}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Output level
              <div className="volume-setting">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={remoteVolume}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setRemoteVolume(value);
                    roomSession.setRemoteVolume(value / 100);
                    localStorage.setItem("mhtalk.output-volume", String(value));
                  }}
                />
                <span>{remoteVolume}%</span>
              </div>
            </label>
            <button
              className="control modal-join"
              disabled={testingSpeaker}
              onClick={() => void testSpeaker()}
            >
              {testingSpeaker ? "Playing test sound…" : "Test speaker"}
            </button>
          </section>
        </div>
      )}
      {profileOpen && (
        <div className="modal-backdrop">
          <section className="private-modal">
            <button
              className="modal-close"
              onClick={() => setProfileOpen(false)}
            >
              ×
            </button>
            <h2>Edit profile</h2>
            <input
              ref={avatarInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/apng"
              hidden
              onChange={(event) => {
                beginAvatarCrop(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            <button
              className="avatar-upload"
              onClick={() => avatarInput.current?.click()}
            >
              {profile.avatar.startsWith("data:") ? (
                <img src={profile.avatar} alt="Avatar preview" />
              ) : (
                profile.avatar
              )}
              <small>Choose photo</small>
            </button>
            {profile.avatar.startsWith("data:") && (
              <button
                className="remove-avatar"
                onClick={() =>
                  setProfile({
                    ...profile,
                    avatar: (profile.name.trim()[0] || "M").toUpperCase(),
                  })
                }
              >
                Remove photo
              </button>
            )}
            <label>
              Name
              <input
                maxLength={32}
                value={profile.name}
                onChange={(event) =>
                  setProfile({ ...profile, name: event.target.value })
                }
              />
            </label>
            <label>
              Bio
              <input
                maxLength={120}
                value={profile.bio}
                onChange={(event) =>
                  setProfile({ ...profile, bio: event.target.value })
                }
              />
            </label>
            <button
              className="primary modal-create"
              onClick={() => void saveProfile()}
            >
              Save profile
            </button>
          </section>
        </div>
      )}
      {infoPage && (
        <div className="modal-backdrop">
          <section
            className="private-modal info-modal"
            role="dialog"
            aria-modal="true"
            aria-label={infoPages[infoPage].title}
          >
            <button className="modal-close" onClick={() => setInfoPage(null)}>
              ×
            </button>
            <h2>{infoPages[infoPage].title}</h2>
            <div className="info-content">
              {infoPages[infoPage].paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </section>
        </div>
      )}
      {cropSource && (
        <CropDialog
          source={cropSource}
          imageSize={cropImageSize}
          zoom={cropZoom}
          moveX={cropX}
          moveY={cropY}
          onZoom={(value) => {
            setCropZoom(value);
            setCropX(0);
            setCropY(0);
          }}
          onMoveX={setCropX}
          onMoveY={setCropY}
          onCancel={() => {
            URL.revokeObjectURL(cropSource);
            setCropSource(null);
          }}
          onSave={() => void saveAvatarCrop()}
        />
      )}
      {viewProfile && (
        <div className="modal-backdrop">
          <section className="private-modal profile-modal">
            <button
              className="modal-close"
              onClick={() => setViewProfile(null)}
            >
              ×
            </button>
            <div className="big-avatar">
              <Avatar value={viewProfile.avatar} />
            </div>
            <h2>{viewProfile.name}</h2>
            <p>{viewProfile.bio || "No bio yet."}</p>
          </section>
        </div>
      )}
      {viewImage && (
        <div
          className="image-lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={viewImage.name}
          onPointerDown={(event) => {
            if (event.currentTarget === event.target) setViewImage(null);
          }}
        >
          <img src={viewImage.url} alt={viewImage.name} />
          <button
            className="image-lightbox-close"
            aria-label="Close image"
            title="Close"
            onClick={() => setViewImage(null)}
          >
            ×
          </button>
        </div>
      )}
      {appError && (
        <div className="recording-error">
          <span>{appError}</span>
          <button onClick={() => setAppError("")}>×</button>
        </div>
      )}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.message?.body && (
            <button
              onClick={() => {
                void navigator.clipboard.writeText(
                  contextMenu.message?.body || "",
                );
                setContextMenu(null);
              }}
            >
              Copy
            </button>
          )}
          {contextMenu.composer && (
            <button
              onClick={() => {
                void navigator.clipboard
                  .readText()
                  .then((text) => setDraft((current) => current + text));
                setContextMenu(null);
              }}
            >
              Paste
            </button>
          )}
          {contextMenu.message?.attachment && (
            <button
              onClick={() => {
                void saveAttachment(contextMenu.message);
                setContextMenu(null);
              }}
            >
              Save as
            </button>
          )}
        </div>
      )}
      {mediaMenu && (
        <div
          className="media-menu"
          style={{ left: mediaMenu.x, top: mediaMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {mediaMenu.identity && (
            <div className="media-volume-menu">
              <label>
                <span>
                  User volume <small>{mediaMenu.voiceVolume}%</small>
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={mediaMenu.voiceVolume}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    roomSession.setParticipantVoiceVolume(
                      mediaMenu.identity || "",
                      value,
                    );
                    setMediaMenu((current) =>
                      current ? { ...current, voiceVolume: value } : current,
                    );
                  }}
                />
              </label>
              {mediaMenu.source === "screen" && (
                <label>
                  <span>
                    Stream volume <small>{mediaMenu.streamVolume}%</small>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={mediaMenu.streamVolume}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      roomSession.setParticipantStreamVolume(
                        mediaMenu.identity || "",
                        value,
                      );
                      setMediaMenu((current) =>
                        current ? { ...current, streamVolume: value } : current,
                      );
                    }}
                  />
                </label>
              )}
            </div>
          )}
          {mediaMenu.local ? (
            <div className="media-note">
              Full screen is disabled for your own screen share to prevent
              visual feedback.
            </div>
          ) : (
            <button onClick={openMediaFullscreen}>Full screen</button>
          )}
          <button onClick={() => void openPictureInPicture()}>
            Picture in Picture
          </button>
        </div>
      )}
      {dragging && <div className="global-drop-overlay">Drop to send</div>}
    </main>
  );
}

function ParticipantMediaCard({
  identity,
  name,
  avatar,
  bio,
  speaking,
  microphoneEnabled,
  local = false,
  onProfile,
}: {
  identity: string;
  name: string;
  avatar: string;
  bio: string;
  speaking: boolean;
  microphoneEnabled: boolean;
  local?: boolean;
  onProfile: (profile: UserProfile) => void;
}) {
  const hostIdentity = encodeURIComponent(identity);
  return (
    <article className="participant-card">
      <button
        className={`participant-card-header ${speaking ? "speaking" : ""}`}
        onClick={() => onProfile({ name, avatar, bio })}
      >
        <Avatar value={avatar} remote={!local} />
        <span>
          <strong>{name}</strong>
          <small>
            {microphoneEnabled ? (speaking ? "Speaking" : "Mic on") : "Mic off"}
          </small>
        </span>
        <i aria-label={microphoneEnabled ? "Microphone on" : "Microphone off"}>
          {microphoneEnabled ? "🎙️" : "🔇"}
        </i>
      </button>
      <div
        id={`media-host-${hostIdentity}-camera`}
        className="participant-media-host"
      />
      <div
        id={`media-host-${hostIdentity}-screen`}
        className="participant-media-host"
      />
    </article>
  );
}

function Attachment({
  attachment,
  onOpenImage,
}: {
  attachment: ChatSnapshot["messages"][number]["attachment"];
  onOpenImage: (url: string, name: string) => void;
}) {
  if (!attachment) return null;
  if (attachment.kind === "image")
    return (
      <button
        type="button"
        className="attachment image"
        onClick={() => onOpenImage(attachment.url, attachment.name)}
        aria-label={`Open ${attachment.name}`}
      >
        <img src={attachment.url} alt={attachment.name} />
      </button>
    );
  if (attachment.kind === "video")
    return <video className="attachment video" src={attachment.url} controls />;
  if (attachment.kind === "audio")
    return <VoiceAttachment url={attachment.url} />;
  return (
    <a
      className="attachment file"
      href={attachment.url}
      download={attachment.name}
    >
      📎 {attachment.name} <small>{Math.ceil(attachment.size / 1024)} KB</small>
    </a>
  );
}

function Avatar({
  value,
  remote = false,
}: {
  value: string;
  remote?: boolean;
}) {
  const image =
    value.startsWith("data:image/") ||
    value.startsWith("https://") ||
    value.startsWith("http://");
  return (
    <div className={`avatar ${remote ? "remote" : ""}`}>
      {image ? <img src={value} alt="" /> : value.slice(0, 2)}
    </div>
  );
}

function messagePreview(message: ChatMessage) {
  if (message.body) return message.body;
  if (message.attachment?.kind === "audio") return "Voice message";
  if (message.attachment?.kind === "image") return "Image";
  if (message.attachment?.kind === "video") return "Video";
  return message.attachment?.name || "Attachment";
}

function VoiceAttachment({ url }: { url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const format = (value: number) =>
    `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  const updateDuration = () => {
    const value = audio.current?.duration ?? 0;
    if (Number.isFinite(value) && value > 0) setDuration(value);
  };
  return (
    <div className="attachment audio">
      <span>Voice message</span>
      <audio
        ref={audio}
        src={url}
        onLoadedMetadata={() => {
          updateDuration();
          if (!Number.isFinite(audio.current?.duration))
            audio.current!.currentTime = 1e6;
        }}
        onDurationChange={updateDuration}
        onTimeUpdate={() => setProgress(audio.current?.currentTime || 0)}
        onEnded={() => setPlaying(false)}
      />
      <div className="voice-ui">
        <button
          onClick={() => {
            if (!audio.current) return;
            if (audio.current.paused) {
              void audio.current.play();
              setPlaying(true);
            } else {
              audio.current.pause();
              setPlaying(false);
            }
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          disabled={!safeDuration}
          type="range"
          min="0"
          max={safeDuration || 1}
          step="0.01"
          value={Math.min(progress, safeDuration || 1)}
          onChange={(event) => {
            if (audio.current)
              audio.current.currentTime = Number(event.target.value);
            setProgress(Number(event.target.value));
          }}
        />
        <time>
          {format(progress)} / {safeDuration ? format(safeDuration) : "--:--"}
        </time>
      </div>
      <div className="audio-wave">
        {Array.from({ length: 30 }, (_, index) => (
          <i
            key={index}
            style={{
              height: `${20 + ((index * 19) % 70)}%`,
              opacity:
                index / 30 <= (safeDuration ? progress / safeDuration : 0)
                  ? 1
                  : 0.35,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function CropDialog({
  source,
  imageSize,
  zoom,
  moveX,
  moveY,
  onZoom,
  onMoveX,
  onMoveY,
  onCancel,
  onSave,
}: {
  source: string;
  imageSize: { width: number; height: number };
  zoom: number;
  moveX: number;
  moveY: number;
  onZoom: (value: number) => void;
  onMoveX: (value: number) => void;
  onMoveY: (value: number) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const crop = cropLayout(imageSize, zoom, 210);
  return (
    <div className="modal-backdrop">
      <section className="private-modal crop-modal">
        <button className="modal-close" onClick={onCancel}>
          ×
        </button>
        <h2>Crop profile photo</h2>
        <p>
          Move and zoom the image. The circle is exactly how your avatar will
          look.
        </p>
        <div className="crop-preview">
          <img
            src={source}
            alt="Crop preview"
            style={{
              width: crop.width,
              height: crop.height,
              left: crop.left + moveX,
              top: crop.top + moveY,
            }}
          />
        </div>
        <label>
          Zoom
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => onZoom(Number(event.target.value))}
          />
        </label>
        <label>
          Move left / right
          <input
            type="range"
            min={-crop.maxX}
            max={crop.maxX}
            value={moveX}
            onChange={(event) => onMoveX(Number(event.target.value))}
          />
        </label>
        <label>
          Move up / down
          <input
            type="range"
            min={-crop.maxY}
            max={crop.maxY}
            value={moveY}
            onChange={(event) => onMoveY(Number(event.target.value))}
          />
        </label>
        <button className="primary modal-create" onClick={onSave}>
          Use this photo
        </button>
      </section>
    </div>
  );
}

function cropLayout(
  size: { width: number; height: number },
  zoom: number,
  frame: number,
) {
  const ratio = size.width / size.height;
  const width = (ratio >= 1 ? frame * ratio : frame) * zoom;
  const height = (ratio >= 1 ? frame : frame / ratio) * zoom;
  return {
    width,
    height,
    left: (frame - width) / 2,
    top: (frame - height) / 2,
    maxX: Math.max(0, (width - frame) / 2),
    maxY: Math.max(0, (height - frame) / 2),
  };
}

async function cropAvatar(
  url: string,
  zoom: number,
  moveX: number,
  moveY: number,
  size: { width: number; height: number },
) {
  const source = await createImageBitmap(
    await fetch(url).then((response) => response.blob()),
  );
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Avatar canvas unavailable");
  const crop = cropLayout(size, zoom, 96);
  context.drawImage(
    source,
    crop.left + moveX * (96 / 210),
    crop.top + moveY * (96 / 210),
    crop.width,
    crop.height,
  );
  source.close();
  return canvas.toDataURL("image/jpeg", 0.62);
}

function mimeFromName(name: string) {
  const ext = name.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        mp4: "video/mp4",
        webm: "video/webm",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        pdf: "application/pdf",
      } as Record<string, string>
    )[ext || ""] || "application/octet-stream"
  );
}
