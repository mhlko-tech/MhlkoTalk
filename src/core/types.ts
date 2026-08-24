export type SessionState =
  | "idle"
  | "connecting"
  | "connected"
  | "recovering"
  | "failed";

export type MediaQuality = "low" | "medium" | "high";

export interface SessionSnapshot {
  state: SessionState;
  roomName: string | null;
  microphoneEnabled: boolean;
  localSpeaking: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  screenShareAudioEnabled: boolean;
  connectionQuality: "excellent" | "good" | "poor" | "lost" | "unknown";
  estimatedDropPercent: number | null;
  recoveryAttempt: number;
  lastRecoveryMs: number | null;
  participants: Array<{
    identity: string;
    speaking: boolean;
    microphoneEnabled: boolean;
    cameraEnabled: boolean;
    screenShareEnabled: boolean;
    cameraQuality: MediaQuality;
    screenShareQuality: MediaQuality;
    name?: string;
    bio?: string;
    avatar?: string;
  }>;
}

export type ChatAttachment = {
  name: string;
  mimeType: string;
  size: number;
  url: string;
  kind: "image" | "video" | "audio" | "file";
};
export type ChatMessage = {
  id: string;
  sender: string;
  senderIdentity?: string;
  body?: string;
  createdAt: number;
  mine: boolean;
  attachment?: ChatAttachment;
  deleted?: boolean;
  replyTo?: { id: string; sender: string; body: string };
};
export type UserProfile = { name: string; bio: string; avatar: string };
export type ChatSnapshot = { messages: ChatMessage[]; typing: string[] };

export type SessionListener = (snapshot: SessionSnapshot) => void;
export type ChatListener = (snapshot: ChatSnapshot) => void;
