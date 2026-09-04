import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import appPackage from "../package.json";
import { Avatar } from "./components/Avatar";
import { MembershipBadge } from "./components/MembershipBadge";
import { DisplayNameField } from "./components/DisplayNameField";
import { AuthenticationGate } from "./features/auth/AuthenticationGate";
import { ParticipantMediaCard } from "./features/room/ParticipantMediaCard";
import {
  CropDialog,
  cropAvatar,
} from "./features/profile/ProfileCropDialog";
import {
  Attachment,
  messagePreview,
  mimeFromName,
} from "./features/chat/ChatAttachments";
import type {
  ChatMessage,
  ChatSnapshot,
  MediaQuality,
  SessionSnapshot,
  UserProfile,
} from "./core/types";
import { mediaQualityLabels, mediaQualityOrder } from "./core/mediaQuality";
import {
  formatAttachmentLimit,
  freeSubscriptionPlan,
  isPaidSubscription,
  hasMembershipBadge,
  limitMediaQuality,
  subscriptionLabels,
} from "./core/subscription";
import { profileAvatarImageSource } from "./core/profileAvatar";
import { usernameError } from "./core/authRules";
import { isEmbeddedRtcProvider } from "./core/rtcProviders";
import { liveKitTokenEndpoint } from "./config/serviceConfig";
import { roomSession } from "./services/roomSession";
import {
  accountSession,
  type AccountState,
  type SearchProfile,
  type SocialState,
} from "./services/accountSession";
import {
  retryStartupUpdater,
  subscribeStartupUpdater,
  type UpdateActivity,
} from "./services/appUpdater";
import { isKeyboardLanguageShortcut, switchKeyboardLanguage } from "./services/inputLanguage";
import { disconnectMembership, linkExistingLavaMembership, startLavaMembership, startPatreonMembership, syncLavaMembership, type MembershipPlanId, type MembershipSync } from "./services/membershipService";

const initial: SessionSnapshot = {
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
const emptyChat: ChatSnapshot = { messages: [], typing: [] };
const appVersion = appPackage.version;
const patreonMembershipUrl = "https://www.patreon.com/cw/MhlkoVD/membership";
const mvDownloaderUrl = "https://github.com/mhlko-tech/MVDownloader/releases/latest";
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
type MemberMenuState = {
  x: number;
  y: number;
  identity?: string;
  profile: UserProfile;
  voiceVolume: number;
  streamVolume: number;
};

const usernameCooldownMs = 30 * 24 * 60 * 60 * 1000;

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
      "Your account identifier, username, email address, profile, friend relationships, blocks and notification tokens are hosted by Supabase. Passwords are processed and hashed by Supabase Auth and are never stored by MHTalk. Google supplies basic account information only when you choose Google sign-in.",
      "MHTalk does not sell personal data. Live room media and messages are transmitted through the active realtime provider, currently Daily or LiveKit. Files, recordings and recovered recording pieces remain on the device paths selected by you unless you deliberately send them.",
      "People in a room may capture or redistribute what they receive. Share only what you are comfortable revealing and use private invitations carefully.",
      "You can sign out, remove your profile photo, leave a room, delete local recordings and stop camera, microphone or screen sharing at any time. Contact MHTalk to request account deletion.",
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

function StartupUpdateGate({
  activity,
  onRetry,
}: {
  activity: UpdateActivity | null;
  onRetry: () => void;
}) {
  const phase = activity?.phase || "checking";
  const label =
    phase === "downloading"
      ? "Downloading update"
      : phase === "installing"
        ? "Installing update"
        : phase === "error"
          ? "Update check failed"
          : "Checking for updates";
  const progress = activity?.progress;
  const phaseIndex = phase === "installing" ? 2 : phase === "downloading" ? 1 : 0;
  return (
    <main className="startup-update-gate" aria-live="polite">
      <section className="startup-update-card">
        <header>
          <img src="/mhtalk-icon.png" alt="MHTalk" />
          <div><h1>MHTalk <span className="beta-badge">Beta</span></h1><small>Secure desktop · v{appVersion}</small></div>
        </header>
        <div className="startup-update-copy">
          <strong>{label}</strong>
          <span>{phase === "checking" ? "Making sure you have the newest secure version." : phase === "downloading" ? "Downloading the verified update from MHTalk." : phase === "installing" ? "Update verified. MHTalk will restart automatically." : "MHTalk could not reach the update service."}</span>
        </div>
        <div className="startup-stages" aria-hidden="true">
          {["Check", "Download", "Open"].map((step, index) => (
            <div className={index < phaseIndex ? "done" : index === phaseIndex && phase !== "error" ? "active" : ""} key={step}>
              <i>{index < phaseIndex ? "✓" : index + 1}</i><span>{step}</span>
            </div>
          ))}
        </div>
        <div
          className={`startup-progress ${progress === null || progress === undefined ? "indeterminate" : ""}`}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
        >
          <i style={progress === null || progress === undefined ? undefined : { width: `${progress}%` }} />
        </div>
        <div className="startup-update-meta">
          <small>{phase === "downloading" && progress !== null ? `${progress}%` : phase === "installing" ? "Restarting MHTalk…" : phase === "error" ? "Connection required" : "Usually takes a few seconds"}</small>
          <small>Signed update</small>
        </div>
        {activity?.phase === "error" && (
          <div className="startup-update-error">
            <p>{activity.message}</p>
            <button onClick={onRetry}>Try again</button>
          </div>
        )}
      </section>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState(initial);
  const [privateInvite, setPrivateInvite] = useState<string | null>(null);
  const [mainActiveCount, setMainActiveCount] = useState(0);
  const [privateDialogOpen, setPrivateDialogOpen] = useState(false);
  const [privateCode, setPrivateCode] = useState("");
  const [appError, setAppError] = useState("");
  const [updateActivity, setUpdateActivity] = useState<UpdateActivity | null>({
    phase: "checking",
    progress: null,
  });
  const [startupReady, setStartupReady] = useState(false);
  const [chat, setChat] = useState(emptyChat);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [transferProgress, setTransferProgress] = useState<number | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<File | null>(null);
  const [pendingAttachmentUrl, setPendingAttachmentUrl] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareQuality, setShareQuality] = useState<MediaQuality>(() => {
    const stored = localStorage.getItem("mhtalk.share-quality");
    return stored === "low" || stored === "high" ? stored : "medium";
  });
  const [noiseCancellation, setNoiseCancellation] = useState(() =>
    roomSession.getNoiseCancellationEnabled(),
  );
  const [eventSounds, setEventSounds] = useState(() =>
    roomSession.getEventSoundSettings(),
  );
  const [accountState, setAccountState] = useState<AccountState>(() =>
    accountSession.getState(),
  );
  const subscription = accountState.status === "signed-in"
    ? accountState.account.subscription
    : freeSubscriptionPlan;
  const [socialState, setSocialState] = useState<SocialState>(() =>
    accountSession.getSocialState(),
  );
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [lavaBusy, setLavaBusy] = useState(false);
  const [membershipPlan, setMembershipPlan] = useState<MembershipPlanId>("plus");
  const [membershipMessage, setMembershipMessage] = useState("");
  const [membershipDetails, setMembershipDetails] = useState<MembershipSync | null>(null);
  const [membershipCode, setMembershipCode] = useState("");
  const [friendSearch, setFriendSearch] = useState("");
  const [friendResults, setFriendResults] = useState<SearchProfile[]>([]);
  const [socialBusy, setSocialBusy] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [memberMenu, setMemberMenu] = useState<MemberMenuState | null>(null);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [privateInviteCopied, setPrivateInviteCopied] = useState(false);
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
  const [cropRotation, setCropRotation] = useState(0);
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
  const profileSaveTimer = useRef<number | null>(null);
  const profileSaveChain = useRef<Promise<void>>(Promise.resolve());
  const lastPersistedProfile = useRef(JSON.stringify(profile));

  useEffect(() => roomSession.subscribe(setSession), []);
  useEffect(() => roomSession.subscribeChat(setChat), []);
  useEffect(() => accountSession.subscribe(setAccountState), []);
  useEffect(() => accountSession.subscribeSocial(setSocialState), []);
  useEffect(() => { void accountSession.initialize(); }, []);
  useEffect(() => {
    localStorage.setItem("mhtalk.subscription-tier", subscription.tier);
  }, [subscription.tier]);
  useEffect(() => {
    if (accountState.status !== "signed-in") return;
    void syncLavaMembership().then((result) => { if (result) setMembershipDetails(result); }).catch(() => undefined);
  }, [accountState.status]);
  useEffect(() => {
    const allowed = limitMediaQuality(
      shareQuality,
      subscription.entitlements.maxScreenShareQuality,
    );
    if (allowed !== shareQuality) setShareQuality(allowed);
  }, [shareQuality, subscription.entitlements.maxScreenShareQuality]);
  useEffect(() => {
    const handleKeyboardLanguage = (event: KeyboardEvent) => {
      if (!isKeyboardLanguageShortcut(event)) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      event.preventDefault();
      void switchKeyboardLanguage();
    };
    window.addEventListener("keydown", handleKeyboardLanguage, true);
    return () => window.removeEventListener("keydown", handleKeyboardLanguage, true);
  }, []);
  useEffect(() => {
    if (accountState.status !== "signed-in" && session.state !== "idle") void roomSession.leave();
  }, [accountState.status, session.state]);
  useEffect(() => {
    if (accountState.status !== "signed-in") return;
    if (profileOpen) return;
    const accountProfile = {
      name: accountState.account.displayName,
      bio: accountState.account.bio || "",
      avatar: accountState.account.avatarUrl || accountState.account.displayName.slice(0, 1).toUpperCase(),
      username: accountState.account.username,
      usernameVisible: accountState.account.usernameVisible,
      subscriptionTier: accountState.account.subscription.tier,
    };
    lastPersistedProfile.current = JSON.stringify(accountProfile);
    setUsernameDraft(accountState.account.username);
    setProfile(accountProfile);
    roomSession.setProfile(accountProfile);
  }, [accountState, profileOpen]);
  useEffect(() => {
    if (accountState.status !== "signed-in") return;
    const refresh = () => void accountSession.refreshSocial();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [accountState.status]);
  useEffect(() => roomSession.setRemoteVolume(remoteVolume / 100), []);
  useEffect(
    () => subscribeStartupUpdater(setUpdateActivity, () => setStartupReady(true)),
    [],
  );
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
      try {
        const response = await fetch(new URL("/room-count", liveKitTokenEndpoint), {
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
    if (!("__TAURI_INTERNALS__" in window)) return;
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
  const usernameNextChangeAt = accountState.status === "signed-in" && accountState.account.usernameChangedAt
    ? new Date(new Date(accountState.account.usernameChangedAt).getTime() + usernameCooldownMs)
    : null;
  const usernameChangeLocked = Boolean(usernameNextChangeAt && usernameNextChangeAt.getTime() > Date.now());
  const enterRoom = async (roomName: string, invite?: string) => {
    if (active && session.roomName !== roomName) await roomSession.leave();
    await roomSession.join(roomName, invite);
  };
  const createPrivateRoom = async () => {
    try {
      const privateRoom = await roomSession.createPrivateRoom();
      setPrivateInvite(privateRoom.code);
      if (active) await roomSession.leave();
      await roomSession.join(privateRoom.roomName, privateRoom.code);
      setPrivateDialogOpen(false);
    } catch (error) {
      setAppError(
        error instanceof Error
          ? error.message
          : "Could not create the private room",
      );
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
  const searchFriends = async () => {
    if (friendSearch.trim().length < 2) return;
    setSocialBusy("search");
    try {
      setFriendResults(await accountSession.searchProfiles(friendSearch.trim()));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Could not search profiles");
    } finally {
      setSocialBusy("");
    }
  };
  const inviteFriend = async (friendId: string) => {
    setSocialBusy(friendId);
    try {
      const invite = await accountSession.inviteFriend(friendId, true);
      setPrivateInvite(invite.inviteCode || null);
      await enterRoom(invite.roomName, invite.inviteCode);
      setFriendsOpen(false);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Could not send invitation");
    } finally {
      setSocialBusy("");
    }
  };
  const openMemberMenu = (
    event: React.MouseEvent<HTMLElement>,
    memberProfile: UserProfile,
    identity?: string,
  ) => {
    event.stopPropagation();
    const volumes = identity
      ? roomSession.getParticipantVolumes(identity)
      : { voice: 100, stream: 100 };
    setContextMenu(null);
    setMediaMenu(null);
    setProfileMenuOpen(false);
    setMemberMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 280)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 220)),
      identity,
      profile: memberProfile,
      voiceVolume: volumes.voice,
      streamVolume: volumes.stream,
    });
  };
  const acceptIncomingInvite = async () => {
    const invite = socialState.incomingInvite;
    if (!invite) return;
    accountSession.clearInvite();
    setPrivateInvite(invite.inviteCode || null);
    await enterRoom(invite.roomName, invite.inviteCode);
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
  const persistProfile = (draft: UserProfile) => {
    const normalized = { ...draft, name: draft.name.trim(), bio: draft.bio.trim() };
    if (!normalized.name) return profileSaveChain.current;
    const signature = JSON.stringify(normalized);
    const persist = async () => {
      if (lastPersistedProfile.current === signature) return;
      await roomSession.setProfile(normalized);
      let storedProfile = normalized;
      if (accountState.status === "signed-in") {
        await accountSession.updateProfile(
          normalized.name,
          normalized.bio,
          normalized.avatar,
          normalized.usernameVisible,
        );
        const refreshed = accountSession.getState();
        if (refreshed.status === "signed-in") {
          storedProfile = {
            name: refreshed.account.displayName,
            bio: refreshed.account.bio || "",
            avatar: refreshed.account.avatarUrl || normalized.avatar,
            username: refreshed.account.username,
            usernameVisible: refreshed.account.usernameVisible,
            subscriptionTier: refreshed.account.subscription.tier,
          };
          await roomSession.setProfile(storedProfile);
          setProfile((current) =>
            current.avatar === normalized.avatar && current.name.trim() === normalized.name
              ? storedProfile
              : current,
          );
        }
      }
      lastPersistedProfile.current = JSON.stringify(storedProfile);
    };
    profileSaveChain.current = profileSaveChain.current.then(persist, persist).catch((error) => {
      setAppError(error instanceof Error ? error.message : "Could not sync profile");
    });
    return profileSaveChain.current;
  };
  useEffect(() => {
    if (!profileOpen) return;
    if (profileSaveTimer.current !== null) window.clearTimeout(profileSaveTimer.current);
    profileSaveTimer.current = window.setTimeout(() => {
      profileSaveTimer.current = null;
      void persistProfile(profile);
    }, 350);
    return () => {
      if (profileSaveTimer.current !== null) window.clearTimeout(profileSaveTimer.current);
    };
  }, [profile, profileOpen]);
  const closeProfile = async () => {
    if (profileSaveTimer.current !== null) window.clearTimeout(profileSaveTimer.current);
    profileSaveTimer.current = null;
    await persistProfile(profile);
    setProfileOpen(false);
  };
  const changeUsername = async () => {
    const nextUsername = usernameDraft.trim();
    const validation = usernameError(nextUsername);
    if (validation) {
      setAppError(validation);
      return;
    }
    if (accountState.status !== "signed-in" || nextUsername === accountState.account.username) return;
    setUsernameBusy(true);
    try {
      await accountSession.changeUsername(nextUsername);
      const refreshed = accountSession.getState();
      if (refreshed.status === "signed-in") {
        setUsernameDraft(refreshed.account.username);
        const updatedProfile = {
          ...profile,
          username: refreshed.account.username,
          usernameVisible: refreshed.account.usernameVisible,
        };
        setProfile(updatedProfile);
        await roomSession.setProfile(updatedProfile);
      }
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Could not change username");
    } finally {
      setUsernameBusy(false);
    }
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
      setCropRotation(0);
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
      cropRotation,
      cropImageSize,
    );
    URL.revokeObjectURL(cropSource);
    setCropSource(null);
    setProfile((current) => ({ ...current, avatar }));
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

  if (!startupReady) {
    return (
      <StartupUpdateGate
        activity={updateActivity}
        onRetry={retryStartupUpdater}
      />
    );
  }

  if (accountState.status !== "signed-in") {
    return (
      <main className="auth-gate-shell" onContextMenu={(event) => event.preventDefault()}>
        <AuthenticationGate state={accountState} />
      </main>
    );
  }

  return (
    <main
      className={`app-shell ${isEmbeddedRtcProvider(session.rtcProvider) ? "embedded-provider" : ""}`}
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
        setMemberMenu(null);
        setProfileMenuOpen(false);
        setHelpMenuOpen(false);
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <span><img src="/mhtalk-icon.png" alt="" /></span>
          <div>MHTalk <b className="beta-badge">Beta</b><small>{appVersion}</small></div>
        </div>
        <div className="section-label">Rooms</div>
        <button
          className={`room ${session.roomName === "Main" ? "active" : ""}`}
          onClick={() => {
            setPrivateInvite(null);
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
            <button
              type="button"
              className="invite-code"
              title="Copy private invite code"
              aria-label={`Copy private invite code ${privateInvite}`}
              onClick={() => {
                void navigator.clipboard
                  .writeText(privateInvite)
                  .then(() => {
                    setPrivateInviteCopied(true);
                    window.setTimeout(() => setPrivateInviteCopied(false), 1400);
                  })
                  .catch(() => setAppError("Could not copy invite code"));
              }}
            >
              {privateInvite}
            </button>
            <small>
              {privateInviteCopied
                ? "Code copied."
                : "Share this complete code only with your friend."}
            </small>
          </div>
        )}
        <div className="participants">
          <div className="section-label">
            In this room · {session.participants.length + (active ? 1 : 0)}
          </div>
          {active && (
            <button
              className={`participant ${session.microphoneEnabled ? "speaking" : ""}`}
              onClick={(event) => openMemberMenu(event, profile)}
            >
              <Avatar value={profile.avatar} />
              <span>{profile.name} <MembershipBadge tier={subscription.tier} /></span>
              <small>{session.microphoneEnabled ? "Mic on" : "Mic off"}</small>
            </button>
          )}
          {session.participants.map((participant) => (
            <button
              className={`participant ${participant.speaking ? "speaking" : ""}`}
              onClick={(event) =>
                openMemberMenu(event, {
                  name: participant.name || participant.identity.slice(0, 12),
                  bio: participant.bio || "",
                  avatar:
                    participant.avatar ||
                    participant.identity.slice(0, 1).toUpperCase(),
                  username: participant.username,
                  usernameVisible: participant.usernameVisible,
                  subscriptionTier: participant.subscriptionTier,
                }, participant.identity)
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
                {participant.name || participant.identity.slice(0, 12)} <MembershipBadge tier={participant.subscriptionTier} />
              </span>
              <small>{participant.speaking ? "Speaking" : "Listening"}</small>
            </button>
          ))}
        </div>
        <div className="profile-area">
          <div className="profile-identity">
            <button
              className="profile"
              aria-label="Open account menu"
              onClick={(event) => {
                event.stopPropagation();
                setProfileMenuOpen((open) => !open);
                setHelpMenuOpen(false);
              }}
            >
              <Avatar value={profile.avatar} />
              <strong>{profile.name} <MembershipBadge tier={subscription.tier} /></strong>
            </button>
            <button
              className="profile-username"
              title="Copy username"
              onClick={(event) => {
                event.stopPropagation();
                void navigator.clipboard
                  .writeText(accountState.account.username)
                  .catch(() => setAppError("Could not copy username"));
              }}
            >
              @{accountState.account.username}
            </button>
          </div>
          <button
            className="profile-more friends-shortcut"
            aria-label={`Friends${socialState.requests.length ? `, ${socialState.requests.length} pending requests` : ""}`}
            title="Friends"
            onClick={(event) => {
              event.stopPropagation();
              setProfileMenuOpen(false);
              setHelpMenuOpen(false);
              setFriendsOpen(true);
              void accountSession.refreshSocial();
            }}
          >
            <span aria-hidden="true">👥</span>
            {socialState.requests.length > 0 && (
              <b className="friend-request-badge">
                {socialState.requests.length > 99 ? "99+" : socialState.requests.length}
              </b>
            )}
          </button>
          <button
            className="profile-more support-shortcut"
            aria-label="About Beta servers and support"
            title="Beta servers and support"
            onClick={(event) => {
              event.stopPropagation();
              setProfileMenuOpen(false);
              setHelpMenuOpen(false);
              setSupportOpen(true);
            }}
          >
            <span aria-hidden="true">?</span>
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
              <button
                className="profile-menu-signout"
                onClick={() => {
                  setProfileMenuOpen(false);
                  setHelpMenuOpen(false);
                  void accountSession.signOut();
                }}
              >
                <span>↪</span> Sign out
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

        <div className={`stage ${isEmbeddedRtcProvider(session.rtcProvider) ? "embedded-stage" : ""}`}>
          {active && isEmbeddedRtcProvider(session.rtcProvider) && session.embeddedCallUrl ? (
            <iframe
              className="embedded-call-frame"
              src={session.embeddedCallUrl}
              title={`${displayRoomName} call`}
              allow="camera; microphone; display-capture; autoplay; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : active ? (
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
                username={profile.username}
                usernameVisible={profile.usernameVisible}
                subscriptionTier={subscription.tier}
                speaking={session.localSpeaking}
                microphoneEnabled={session.microphoneEnabled}
                cameraEnabled={session.cameraEnabled}
                screenShareEnabled={session.screenShareEnabled}
                cameraQuality="high"
                screenShareQuality={shareQuality}
                local
                onMemberMenu={openMemberMenu}
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
                  username={participant.username}
                  usernameVisible={participant.usernameVisible}
                  subscriptionTier={participant.subscriptionTier}
                  speaking={participant.speaking}
                  microphoneEnabled={participant.microphoneEnabled}
                  cameraEnabled={participant.cameraEnabled}
                  screenShareEnabled={participant.screenShareEnabled}
                  cameraQuality={participant.cameraQuality}
                  screenShareQuality={participant.screenShareQuality}
                  onMemberMenu={openMemberMenu}
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
              <h2>{roomTransitioning ? "Connecting to a server" : session.state === "failed" ? "Connection unavailable" : "Ready when you are"}</h2>
              <p>{session.connectionMessage || "Join Main channel or create a private room."}</p>
            </div>
          )}
        </div>

        {!isEmbeddedRtcProvider(session.rtcProvider) && <footer className="controls">
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
              session.screenShareEnabled
                ? roomSession.setScreenShareEnabled(false)
                : setShareDialogOpen(true)
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
        </footer>}
      </section>
      {!isEmbeddedRtcProvider(session.rtcProvider) && <div className="chat-resizer" onPointerDown={resizeChat} />}
      {!isEmbeddedRtcProvider(session.rtcProvider) && <aside className={`chat-panel ${dragging ? "dragging" : ""}`}>
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
      </aside>}
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
      {socialState.incomingInvite && (
        <div className="modal-backdrop social-invite-backdrop">
          <section className="private-modal social-invite-modal" role="dialog" aria-modal="true">
            <h2>Room invitation</h2>
            <p>A friend invited you to join an MHTalk room. Invitations expire after 10 minutes.</p>
            <div className="social-row-actions">
              <button className="primary" onClick={() => void acceptIncomingInvite()}>Join room</button>
              <button className="control" onClick={() => accountSession.clearInvite()}>Not now</button>
            </div>
          </section>
        </div>
      )}
      {friendsOpen && (
        <div className="modal-backdrop">
          <section className="private-modal friends-modal" role="dialog" aria-modal="true" aria-label="Friends">
            <button className="modal-close" onClick={() => setFriendsOpen(false)}>×</button>
            <h2>Friends</h2>
            <div className="social-content">
                <div className="social-account-card">
                  <Avatar value={accountState.account.avatarUrl || accountState.account.displayName.slice(0, 1)} />
                  <span><strong>{accountState.account.displayName} <MembershipBadge tier={accountState.account.subscription.tier} /></strong><small>@{accountState.account.username}</small></span>
                  <button className="control social-action" onClick={() => void accountSession.refreshSocial()}>Refresh</button>
                </div>
                {socialState.requests.length > 0 && (
                  <div className="social-section">
                    <h3>Friend requests</h3>
                    {socialState.requests.map((request) => (
                      <div className="social-person" key={request.requestId}>
                        <Avatar value={request.avatarUrl || request.displayName.slice(0, 1)} remote />
                        <span><strong>{request.displayName} <MembershipBadge tier={request.subscription.tier} /></strong><small>@{request.username}</small></span>
                        <div className="social-row-actions">
                          <button className="social-accept social-action" onClick={() => void accountSession.respondFriendRequest(request.requestId, true)}>Accept</button>
                          <button className="social-icon-button social-action" title="Decline" aria-label={`Decline ${request.displayName}'s friend request`} onClick={() => void accountSession.respondFriendRequest(request.requestId, false)}>×</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="social-search">
                  <input value={friendSearch} onChange={(event) => setFriendSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchFriends(); }} placeholder="Search name or @username" />
                  <button className="control social-action" disabled={socialBusy === "search" || friendSearch.trim().length < 2} onClick={() => void searchFriends()}>Search</button>
                </div>
                {friendResults.length > 0 && (
                  <div className="social-results">
                    {friendResults.map((result) => (
                      <div className="social-person" key={result.id}>
                        <Avatar value={result.avatarUrl || result.displayName.slice(0, 1)} remote />
                        <span><strong>{result.displayName} <MembershipBadge tier={result.subscription.tier} /></strong><small>@{result.username}</small></span>
                        <button className="control social-action" disabled={result.isFriend || socialBusy === result.id} onClick={async () => {
                          setSocialBusy(result.id);
                          try {
                            await accountSession.sendFriendRequest(result.id);
                            setFriendResults((items) => items.filter((item) => item.id !== result.id));
                          } catch (error) {
                            setAppError(error instanceof Error ? error.message : "Could not send friend request");
                          } finally { setSocialBusy(""); }
                        }}>{result.isFriend ? "Friends" : "Add"}</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="social-section social-friend-list">
                  <h3>Your friends</h3>
                  {socialState.loading && <p>Loading friends…</p>}
                  {!socialState.loading && socialState.friends.length === 0 && <p>No friends yet. Search by name or username.</p>}
                  {socialState.friends.map((friend) => (
                    <div className="social-person" key={friend.id}>
                      <div className="social-avatar"><Avatar value={friend.avatarUrl || friend.displayName.slice(0, 1)} remote /><i className={friend.online ? "online" : "offline"} /></div>
                      <span><strong>{friend.displayName} <MembershipBadge tier={friend.subscription.tier} /></strong><small>{friend.online ? "Online" : "Offline"} · @{friend.username}</small></span>
                      <button className="primary social-action" disabled={socialBusy === friend.id} onClick={() => void inviteFriend(friend.id)}>Invite</button>
                    </div>
                  ))}
                  {socialState.error && <small className="social-error">{socialState.error}</small>}
                </div>
            </div>
          </section>
        </div>
      )}
      {supportOpen && (
        <div className="modal-backdrop">
          <section className="private-modal support-modal" role="dialog" aria-modal="true" aria-label="MHTalk Beta and support">
            <button className="modal-close" onClick={() => setSupportOpen(false)}>×</button>
            <div className="support-heading"><span>M</span><div><h2>One membership. Two apps.</h2><small>Choose a plan, then pay with LAVA or Patreon</small></div></div>
            <p className="support-membership">Your verified membership works with MHTalk on Windows and Android and with MVDownloader. Calling, messaging and safety features remain free.</p>
            <div className="membership-plans" role="radiogroup" aria-label="Monthly membership plan">
              <button
                type="button"
                className={`membership-plan-card ${membershipPlan === "plus" ? "selected" : ""}`}
                aria-pressed={membershipPlan === "plus"}
                onClick={() => setMembershipPlan("plus")}
              >
                <span className="membership-plan-top"><strong>Plus</strong><b>$5 <small>/ month</small></b></span>
                <span className="membership-plan-copy">HD media essentials for MHTalk, plus higher MVDownloader limits.</span>
                <span className="membership-plan-benefits">✓ MHTalk Plus badge, 1080p camera/screen sharing and source-quality recording up to 120 FPS</span>
                <span className="membership-plan-benefits">✓ MVDownloader: unlimited audio and 720p, plus 10 Full HD downloads every 24 hours</span>
              </button>
              <button
                type="button"
                className={`membership-plan-card ${membershipPlan === "pro" ? "selected" : ""}`}
                aria-pressed={membershipPlan === "pro"}
                onClick={() => setMembershipPlan("pro")}
              >
                <span className="membership-plan-top"><strong>Pro</strong><b>$7 <small>/ month</small></b></span>
                <span className="membership-plan-copy">The complete MHTalk experience with unlimited Full HD downloads.</span>
                <span className="membership-plan-benefits">✓ Everything in Plus, plus 100 MB files, 7-day retention, profiles, themes, frames, emojis, soundboard and custom invites</span>
                <span className="membership-plan-benefits">✓ MVDownloader: unlimited 1080p, 720p and high-quality audio</span>
              </button>
              <button
                type="button"
                className={`membership-plan-card ${membershipPlan === "ultimate" ? "selected" : ""}`}
                aria-pressed={membershipPlan === "ultimate"}
                onClick={() => setMembershipPlan("ultimate")}
              >
                <span className="membership-plan-top"><strong>Ultimate</strong><b>$10 <small>/ month</small></b></span>
                <span className="membership-plan-copy">Maximum MVDownloader quality with the complete MHTalk experience.</span>
                <span className="membership-plan-benefits">✓ MVDownloader: unlimited 2K, 4K and higher source-quality video</span>
                <span className="membership-plan-benefits">✓ Every MHTalk Pro feature with the exclusive Ultimate badge</span>
              </button>
              <button
                type="button"
                className={`membership-plan-card ${membershipPlan === "max_supporter" ? "selected" : ""}`}
                aria-pressed={membershipPlan === "max_supporter"}
                onClick={() => setMembershipPlan("max_supporter")}
              >
                <span className="membership-plan-top"><strong>Max Supporter</strong><b>$15 <small>/ month</small></b></span>
                <span className="membership-plan-copy">All Ultimate MVDownloader benefits plus extra support for the project.</span>
                <span className="membership-plan-benefits">✓ MVDownloader: everything included with Ultimate</span>
                <span className="membership-plan-benefits">✓ Every MHTalk Pro feature with the exclusive Max Supporter badge</span>
              </button>
            </div>
            <p className="support-tier-note">Plus focuses on HD sharing and recording. Pro unlocks the rest of MHTalk. Ultimate and Max Supporter include every Pro feature with their own exclusive badge.</p>
            {membershipDetails && (
              <div className="support-membership-status">
                Plan: {subscriptionLabels[membershipDetails.tier]} · Source: {(membershipDetails.provider || "lava").toUpperCase()} · Status: {membershipDetails.status === "gifted" ? "Gifted" : membershipDetails.status === "active" || membershipDetails.status === "owner" ? "Active" : membershipDetails.status}
              </div>
            )}
            {membershipMessage && <div className="support-membership-status">{membershipMessage}</div>}
            <div className="support-membership-link">
              <label htmlFor="membership-activation-code">Already have a shared membership?</label>
              <p>In MVDownloader open Settings → Membership details, copy the MHTalk activation code and paste it here.</p>
              <div>
                <input
                  id="membership-activation-code"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={membershipCode}
                  placeholder="Paste activation code"
                  onChange={(event) => setMembershipCode(event.target.value)}
                />
                <button className="control" disabled={lavaBusy || !membershipCode.trim()} onClick={async () => {
                  setLavaBusy(true);
                  try {
                    const result = await linkExistingLavaMembership(membershipCode);
                    setMembershipCode("");
                    setMembershipDetails(result);
                    setMembershipMessage(hasMembershipBadge(result.tier) ? `MHTalk ${subscriptionLabels[result.tier]} is active on this account.` : result.pending ? "Payment confirmation is still pending." : "No active membership was found.");
                  } catch (error) {
                    setMembershipMessage(error instanceof Error ? error.message : "Could not link this membership");
                  } finally { setLavaBusy(false); }
                }}>Link membership</button>
              </div>
            </div>
            <div className="support-actions">
              <button className="primary" disabled={lavaBusy} onClick={async () => {
                setLavaBusy(true);
                try {
                   await startLavaMembership(membershipPlan);
                  setMembershipMessage("Complete payment in your browser, then return here and choose Verify membership.");
                } catch (error) {
                  setAppError(error instanceof Error ? error.message : "Could not open LAVA membership");
                } finally {
                  setLavaBusy(false);
                }
               }}>{lavaBusy ? "Opening LAVA…" : `Continue with LAVA · ${{ plus: 5, pro: 7, ultimate: 10, max_supporter: 15 }[membershipPlan]}`}</button>
              <button className="control" disabled={lavaBusy} onClick={async () => {
                setLavaBusy(true);
                try {
                  const result = await syncLavaMembership(true);
                  setMembershipDetails(result);
                  setMembershipMessage(!result ? "Start or link a membership first." : hasMembershipBadge(result.tier) ? `MHTalk ${subscriptionLabels[result.tier]} is active on this account.` : result.pending ? "Membership confirmation is still pending." : "No active membership was found.");
                } catch (error) {
                  setMembershipMessage(error instanceof Error ? error.message : "Could not verify membership");
                } finally { setLavaBusy(false); }
              }}>Check now</button>
              <button className="control" onClick={() => void openUrl(patreonMembershipUrl)}>View Patreon plans</button>
              <button className="control" disabled={lavaBusy} onClick={async () => {
                setLavaBusy(true);
                try {
                  const result = await startPatreonMembership();
                  if (result) {
                    setMembershipDetails(result);
                    setMembershipMessage(`MHTalk ${subscriptionLabels[result.tier]} is active from Patreon.`);
                  } else {
                    setMembershipMessage("Finish linking in Patreon, then return here and choose Check now.");
                  }
                } catch (error) {
                  setMembershipMessage(error instanceof Error ? error.message : "Could not link Patreon membership");
                } finally { setLavaBusy(false); }
              }}>Link Patreon membership</button>
              {membershipDetails?.provider === "patreon" && !membershipDetails.pending && hasMembershipBadge(membershipDetails.tier) && (
                <button className="control" disabled={lavaBusy} onClick={async () => {
                  setLavaBusy(true);
                  try {
                    await disconnectMembership();
                    setMembershipDetails(null);
                    setMembershipMessage("This MHTalk device was disconnected. Your MVDownloader session was not changed.");
                  } catch (error) {
                    setMembershipMessage(error instanceof Error ? error.message : "Could not disconnect this MHTalk membership");
                  } finally { setLavaBusy(false); }
                }}>Disconnect this MHTalk device</button>
              )}
              <button className="control" onClick={() => void openUrl(mvDownloaderUrl)}>Download MVDownloader</button>
              <button className="control" onClick={() => {
                void navigator.clipboard.writeText("Try MHTalk Beta for voice, video, rooms and chat: https://github.com/mhlko-tech/MhlkoTalk/releases/latest").then(() => setAppError("MHTalk link copied — thank you for sharing."));
              }}>Share MHTalk</button>
            </div>
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
            <div className="settings-section">
              <h3>Voice processing</h3>
              <label className="settings-check event-sound-row">
                <input
                  type="checkbox"
                  checked={noiseCancellation}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setNoiseCancellation(enabled);
                    void roomSession.setNoiseCancellationEnabled(enabled);
                  }}
                />
                <span>
                  <strong>Noise cancellation</strong>
                  <small>Remove background noise from your microphone only.</small>
                </span>
              </label>
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
            <div className="settings-section">
              <h3>Event sounds</h3>
              <label className="settings-check event-sound-row">
                <input
                  type="checkbox"
                  checked={eventSounds.presence}
                  onChange={(event) => {
                    const presence = event.target.checked;
                    setEventSounds((current) => ({ ...current, presence }));
                    roomSession.setEventSoundEnabled("presence", presence);
                  }}
                />
                <span>
                  <strong>Join and leave sounds</strong>
                  <small>Play a sound when a member enters or leaves.</small>
                </span>
              </label>
              <label className="settings-check event-sound-row">
                <input
                  type="checkbox"
                  checked={eventSounds.media}
                  onChange={(event) => {
                    const media = event.target.checked;
                    setEventSounds((current) => ({ ...current, media }));
                    roomSession.setEventSoundEnabled("media", media);
                  }}
                />
                <span>
                  <strong>Camera and stream sounds</strong>
                  <small>Play a sound when shared media starts or stops.</small>
                </span>
              </label>
            </div>
            <div className="settings-section account-foundation">
              <h3>MHTalk account</h3>
              <p>{`Signed in as ${accountState.account.displayName} (@${accountState.account.username})`}</p>
            </div>
            <div className="settings-section subscription-card">
              <div className="subscription-heading">
                <div>
                  <h3>MHTalk {subscriptionLabels[subscription.tier]}</h3>
                  <small>Your current account plan</small>
                </div>
                <span className={`plan-badge ${subscription.tier}`}>{subscription.tier}</span>
              </div>
              <ul>
                <li>Clear voice calls with optional microphone noise cancellation</li>
                <li>Camera and screen sharing up to {isPaidSubscription(subscription.tier) ? "1080p" : "720p"}</li>
                <li>Screen recording {isPaidSubscription(subscription.tier) ? "at source resolution and up to 120 FPS" : "up to 720p at 60 FPS"}</li>
                <li>Files up to {formatAttachmentLimit(subscription.entitlements.maxAttachmentBytes)}</li>
                {subscription.entitlements.animatedProfile && (
                  <>
                    <li>Animated profiles, banners, themes and profile frames</li>
                    <li>Custom emojis, stickers, soundboard and invite links</li>
                  </>
                )}
              </ul>
              {subscription.tier === "free" && (
                <p className="subscription-note">
                  Open the yellow help button beside Friends to view LAVA and Patreon support options. Core calling and safety features remain free.
                </p>
              )}
            </div>
          </section>
        </div>
      )}
      {shareDialogOpen && (
        <div className="modal-backdrop">
          <section className="private-modal share-options-modal">
            <button
              className="modal-close"
              onClick={() => setShareDialogOpen(false)}
            >
              ×
            </button>
            <h2>Start screen share</h2>
            <label>
              Broadcast quality
              <select
                value={shareQuality}
                onChange={(event) =>
                  setShareQuality(event.target.value as MediaQuality)
                }
              >
                {mediaQualityOrder.map((quality) => (
                  <option
                    key={quality}
                    value={quality}
                    disabled={
                      quality === "high" &&
                      subscription.entitlements.maxScreenShareQuality !== "high"
                    }
                  >
                    {mediaQualityLabels[quality]}
                    {quality === "high" && subscription.tier === "free" ? " · Plus" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary modal-create"
              onClick={async () => {
                await roomSession.setScreenShareEnabled(
                  true,
                  shareQuality,
                );
                setShareDialogOpen(false);
              }}
            >
              Choose screen and start
            </button>
          </section>
        </div>
      )}
      {profileOpen && (
        <div className="modal-backdrop">
          <section className="private-modal profile-edit-modal">
            <button
              className="modal-close"
              onClick={() => void closeProfile()}
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
              {profileAvatarImageSource(profile.avatar) ? (
                <img src={profileAvatarImageSource(profile.avatar) || ""} alt="Avatar preview" />
              ) : <Avatar value={profile.avatar || profile.name.slice(0, 1) || "M"} />}
              <small>Choose photo</small>
            </button>
            {profileAvatarImageSource(profile.avatar) && (
              <button
                className="remove-avatar"
                onClick={() =>
                  setProfile((current) => ({
                    ...current,
                    avatar: (profile.name.trim()[0] || "M").toUpperCase(),
                  }))
                }
              >
                Remove photo
              </button>
            )}
            <DisplayNameField
              label="Name"
              value={profile.name}
              onValueChange={(name) => setProfile((current) => ({ ...current, name }))}
              autoComplete="name"
            />
            <div className="username-editor">
              <label>
                Username
                <input
                  value={usernameDraft}
                  maxLength={32}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={usernameChangeLocked || usernameBusy}
                  onChange={(event) => setUsernameDraft(
                    event.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32),
                  )}
                />
              </label>
              <button
                className="username-change-button"
                disabled={
                  usernameBusy ||
                  usernameChangeLocked ||
                  accountState.status !== "signed-in" ||
                  usernameDraft.trim() === accountState.account.username ||
                  Boolean(usernameError(usernameDraft))
                }
                onClick={() => void changeUsername()}
              >
                {usernameBusy ? "Changing…" : "Change username"}
              </button>
              <small>
                {usernameChangeLocked && usernameNextChangeAt
                  ? `You can change it again on ${usernameNextChangeAt.toLocaleDateString()}.`
                  : "You can change your username once every 30 days."}
              </small>
            </div>
            <label className="settings-check profile-visibility-setting">
              <input
                type="checkbox"
                checked={profile.usernameVisible !== false}
                onChange={(event) => setProfile((current) => ({
                  ...current,
                  usernameVisible: event.target.checked,
                }))}
              />
              <span>
                Show my username on my profile
                <small>Your username remains available for sign-in and friend search.</small>
              </span>
            </label>
            <label>
              Bio
              <input
                maxLength={120}
                value={profile.bio}
                onChange={(event) => setProfile((current) => ({ ...current, bio: event.target.value }))}
              />
            </label>
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
          rotation={cropRotation}
          onZoom={setCropZoom}
          onMove={(x, y) => { setCropX(x); setCropY(y); }}
          onRotate={() => {
            setCropRotation((value) => (value + 90) % 360);
            setCropX(0);
            setCropY(0);
          }}
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
            {profileAvatarImageSource(viewProfile.avatar) ? (
              <button
                className="big-avatar profile-avatar-preview"
                type="button"
                aria-label={`Open ${viewProfile.name}'s profile photo`}
                onClick={() => {
                  const source = profileAvatarImageSource(viewProfile.avatar);
                  if (source) setViewImage({ url: source, name: `${viewProfile.name}'s profile photo` });
                }}
              >
                <Avatar value={viewProfile.avatar} />
              </button>
            ) : (
              <div className="big-avatar">
                <Avatar value={viewProfile.avatar} />
              </div>
            )}
            <h2>{viewProfile.name} <MembershipBadge tier={viewProfile.subscriptionTier} /></h2>
            {viewProfile.usernameVisible !== false && viewProfile.username && (
              <button
                className="view-profile-username"
                title="Copy username"
                onClick={() => void navigator.clipboard
                  .writeText(`@${viewProfile.username}`)
                  .catch(() => setAppError("Could not copy username"))}
              >
                @{viewProfile.username}
              </button>
            )}
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
      {memberMenu && (
        <div
          className="member-menu"
          style={{ left: memberMenu.x, top: memberMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="member-profile-action"
            onClick={() => {
              setViewProfile(memberMenu.profile);
              setMemberMenu(null);
            }}
          >
            <Avatar value={memberMenu.profile.avatar} remote={Boolean(memberMenu.identity)} />
            <span>
              <strong>{memberMenu.profile.name} <MembershipBadge tier={memberMenu.profile.subscriptionTier} /></strong>
              <small>Open profile</small>
            </span>
          </button>
          {memberMenu.identity && (
            <div className="member-volume-controls">
              <label>
                <span>Microphone <small>{memberMenu.voiceVolume}%</small></span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={memberMenu.voiceVolume}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    roomSession.setParticipantVoiceVolume(memberMenu.identity || "", value);
                    setMemberMenu((current) => current ? { ...current, voiceVolume: value } : current);
                  }}
                />
              </label>
              <label>
                <span>Stream <small>{memberMenu.streamVolume}%</small></span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={memberMenu.streamVolume}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    roomSession.setParticipantStreamVolume(memberMenu.identity || "", value);
                    setMemberMenu((current) => current ? { ...current, streamVolume: value } : current);
                  }}
                />
              </label>
            </div>
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
