export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';
export type PeerConnectionStatus = 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type ScreenQuality = 'auto-max' | '4k' | '1440p' | '1080p' | '720p' | '480p' | '360p' | 'audio-only';
export type ScreenFps = 144 | 120 | 60 | 30 | 15 | 8;
export type ScreenRecorderQuality = 'adaptive' | 'high' | 'balanced' | 'performance';
export type ScreenRecorderFps = 'match' | 60 | 30 | 15;
export type ScreenRecorderCodec = 'auto' | 'h264' | 'vp8' | 'vp9';

export type ChatMessageKind = 'text' | 'image' | 'video' | 'audio' | 'file';
export type MessageDeliveryStatus = 'sending' | 'sent' | 'delivered' | 'seen';
export type FileTransferStatus = 'sending' | 'receiving' | 'completed' | 'failed' | 'canceled';
export type AppLanguage = 'ar' | 'en' | 'tr';
export type NativeVoiceSolution = 1 | 2 | 3 | 4;

export interface UserProfile {
  id: number;
  display_name: string;
  account_email: string;
  avatar_data_url: string | null;
  banner_data_url: string | null;
  bio: string;
  status: string;
  updated_at: number;
}

export type HotkeyAction = 'muteMic' | 'toggleScreen' | 'endCall' | 'toggleFullscreen' | 'toggleSettings' | 'toggleOverlayMode';

export interface ChatOverlaySettings {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  opacity: number;
  borderRadius: number;
  showText: boolean;
  showImages: boolean;
  showAudio: boolean;
  interactive: boolean;
  monitorName: string;
}


export interface CameraOverlaySettings {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  borderRadius: number;
  mirror: boolean;
  fitMode: 'cover' | 'contain';
  cropXPercent: number;
  cropYPercent: number;
  opacity: number;
}


export interface ScreenRecorderSettings {
  quality: ScreenRecorderQuality;
  fps: ScreenRecorderFps;
  codec: ScreenRecorderCodec;
  includeAudio: boolean;
  includeMic: boolean;
  includeMembers: boolean;
  includeSystem: boolean;
  micVolume: number;
  membersVolume: number;
  systemVolume: number;
  autoDuckSystem: boolean;
  micDeviceId: string;
  outputDeviceId: string;
  autoStart: boolean;
}

export interface AppSettings {
  saveChat: boolean;
  lowInternetMode: boolean;
  lowPcMode: boolean;
  signalingUrl: string;
  audioInputId: string;
  audioOutputId: string;
  cameraInputId: string;
  screenQuality: ScreenQuality;
  screenFps: ScreenFps;
  remoteVolume: number;
  language: AppLanguage;
  notificationsEnabled: boolean;
  nativeVoiceSolution: NativeVoiceSolution;
  voiceEnhanceEnabled: boolean;
  hotkeys: Record<HotkeyAction, string>;
  chatOverlay: ChatOverlaySettings;
  cameraOverlay: CameraOverlaySettings;
  showHistoryForNewMembers: boolean;
  screenRecorder: ScreenRecorderSettings;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  sender: 'me' | 'peer' | 'system';
  senderName: string;
  body: string;
  createdAt: number;
  kind?: ChatMessageKind;
  fileName?: string;
  mimeType?: string;
  dataUrl?: string;
  peerId?: string;
  privateTo?: string;
  privateFrom?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  waveform?: number[];
  editedAt?: number;
  deletedAt?: number;
  uploadProgress?: number;
  transferId?: string;
  fileSize?: number;
  localPath?: string;
  fileStatus?: FileTransferStatus;
  transferredBytes?: number;
  linkPreview?: { url: string; title: string; image?: string; provider?: string };
  deliveryStatus?: MessageDeliveryStatus;
  deliveredTo?: string[];
  seenBy?: string[];
  targetCount?: number;
}

export interface PeerProfile {
  peerId: string;
  displayName: string;
  avatar?: string | null;
  avatarVersion?: string;
  status?: string;
  role?: 'owner' | 'moderator' | 'member';
  connectionStatus?: PeerConnectionStatus;
  capabilities?: {
    rtpVoice?: boolean;
    voiceCompanion?: boolean;
    rtcDiagnosticsVersion?: number;
  };
}



export interface PeerMediaStatus {
  micEnabled: boolean;
  screenSharing: boolean;
  cameraSharing?: boolean;
}
