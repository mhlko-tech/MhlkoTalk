import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppSettings, CameraOverlaySettings, ChatMessage, ChatMessageKind, ConnectionState, PeerConnectionStatus, PeerProfile, ScreenFps, ScreenQuality, UserProfile } from '../types/models';
import { ScreenCameraCompositor } from './mediaCompositor';
import { profileAvatarVersion, profileEndpointFromSignaling, type ProfileAssetAccess } from './profileAssets';
import { classifyRtcPressure, mediaBudgetFor, type RtcPressureLevel } from './rtcPolicy';

type NativeAudioChunk = { sequence: number; sample_rate: number; channels: number; format: 'f32le'; data: string };

type VoiceCompanionStatus = {
  running: boolean;
  ready: boolean;
  processId: number;
  generation: number;
  restartCount: number;
  lastError?: string | null;
};

type VoiceMessageStartResult = {
  recordingId: string;
  mimeType: string;
};

type VoiceMessageWaiter<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: number;
};

type SendFileOptions = {
  replyTo?: Pick<ChatMessage, 'id' | 'body' | 'senderName'>;
  waveform?: number[];
  onProgress?: (progress: number) => void;
  isCanceled?: () => boolean;
  messageId?: string;
  createdAt?: number;
  fileSize?: number;
};

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export type RtcDiagnosticsSnapshot = {
  at: number;
  peerId: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  protocol?: string;
  relayProtocol?: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
  localAddress?: string;
  remoteAddress?: string;
  direct: boolean;
  mediaTopology: 'p2p';
  signalingHost?: string;
  serverRegion?: string;
  rttMs?: number;
  jitterMs?: number;
  packetLossPct?: number;
  incomingPacketLossPct?: number;
  outgoingPacketLossPct?: number;
  packetsSent?: number;
  packetsReceived?: number;
  packetsLost?: number;
  packetsDiscarded?: number;
  retransmittedPacketsSent?: number;
  retransmittedPacketsReceived?: number;
  audioSendKbps?: number;
  audioReceiveKbps?: number;
  videoSendKbps?: number;
  videoQualityLimitationReason?: string;
  videoFramesPerSecond?: number;
  availableOutgoingKbps?: number;
  availableIncomingKbps?: number;
  jitterBufferMs?: number;
  jitterBufferTargetMs?: number;
  jitterBufferEmittedCount?: number;
  concealedSamples?: number;
  concealmentEvents?: number;
  silentConcealedSamples?: number;
  totalSamplesReceived?: number;
  interruptionCount?: number;
  totalInterruptionDurationMs?: number;
  freezeCount?: number;
  totalFreezesDurationMs?: number;
  insertedSamplesForDeceleration?: number;
  removedSamplesForAcceleration?: number;
  localAudioTrackState?: MediaStreamTrackState;
  remoteAudioTrackState?: MediaStreamTrackState;
  totalPacketSendDelayMs?: number;
  audioLevel?: number;
  codec?: string;
  eventLoopLagMs: number;
  fileBufferedBytes: number;
  screenActive: boolean;
  cameraActive: boolean;
  recordingActive: boolean;
  reconnects: number;
  iceRestarts: number;
  pressure: RtcPressureLevel;
};

type RtcCounterState = {
  at: number;
  outboundAudioBytes: number;
  inboundAudioBytes: number;
  outboundVideoBytes: number;
  outboundPackets: number;
  outboundLost: number;
  inboundPackets: number;
  inboundLost: number;
  outboundTotalSendDelay: number;
  jitterBufferDelay: number;
  jitterBufferTargetDelay: number;
  jitterBufferEmittedCount: number;
};
type BannedMember = { peerId: string; displayName: string; kickedAt: number };
type JoinRequest = { peerId: string; displayName: string; requestedAt: number };
type RoomRole = 'owner' | 'moderator' | 'member';

type SignalMessage =
  | { type: 'hello'; from: string; to?: string; profile: PeerProfile }
  | { type: 'profile'; from: string; to?: string; profile: PeerProfile }
  | { type: 'description'; from: string; to: string; description: RTCSessionDescriptionInit }
  | { type: 'candidate'; from: string; to: string; candidate: RTCIceCandidateInit | null }
  | { type: 'media'; from: string; to?: string; screenSharing?: boolean; micEnabled?: boolean; screenStreamId?: string; cameraSharing?: boolean; cameraStreamId?: string }
  | { type: 'kick'; from: string; to: string; reason?: string }
  | { type: 'unban'; from: string; to: string }
  | { type: 'join-approve'; from: string; to: string }
  | { type: 'join-reject'; from: string; to: string }
  | { type: 'promote'; from: string; to: string }
  | { type: 'companion-register'; from: string; token: string }
  | { type: 'companion-revoke'; from: string }
  | { type: 'admin-mute-all'; from: string; at: number }
  | { type: 'admin-unmute-all'; from: string; at: number }
  | { type: 'admin-mute-peer'; from: string; to: string; at: number }
  | { type: 'admin-unmute-peer'; from: string; to: string; at: number }
  | { type: 'admin-mute-state'; from: string; targetPeerId: string; muted: boolean; at: number };

type DataPacket =
  | { type: 'chat'; id: string; from: string; to?: string; senderName: string; body: string; createdAt: number; private?: boolean; replyToId?: string; replyToBody?: string; replyToSender?: string }
  | { type: 'edit'; id: string; from: string; to?: string; body: string; editedAt: number }
  | { type: 'delete'; id: string; from: string; to?: string; deletedAt: number }
  | { type: 'receipt'; id: string; from: string; to?: string; status: 'delivered' | 'seen'; at: number }
  | { type: 'typing'; from: string; to?: string; senderName: string; active: boolean }
  | { type: 'file-start'; id: string; from: string; to?: string; senderName: string; fileName: string; mimeType: string; kind: ChatMessageKind; total: number; createdAt: number; private?: boolean; replyToId?: string; replyToBody?: string; replyToSender?: string; waveform?: number[] }
  | { type: 'file-chunk'; id: string; index: number; data: string }
  | { type: 'file-end'; id: string }
  | { type: 'file-stream-start'; id: string; transferId: string; roomId: string; from: string; to?: string; senderName: string; fileName: string; safeFileName: string; fileSize: number; mimeType: string; kind: ChatMessageKind; chunkSize: number; totalChunks: number; createdAt: number; private?: boolean; replyToId?: string; replyToBody?: string; replyToSender?: string; waveform?: number[] }
  | { type: 'file-stream-progress'; id: string; transferId: string; from: string; transferredBytes: number; fileSize: number }
  | { type: 'file-stream-complete'; id: string; transferId: string; from: string }
  | { type: 'file-stream-cancel'; id: string; transferId: string; from: string; reason?: string }
  | { type: 'file-stream-error'; id: string; transferId: string; from: string; reason?: string }
  | { type: 'stream-refresh-request'; from: string; at: number }
  | { type: 'stream-refresh-response'; from: string; ok: boolean; at: number }
  | { type: 'admin-mute-all'; from: string; at: number }
  | { type: 'admin-unmute-all'; from: string; at: number }
  | { type: 'admin-mute-peer'; from: string; to: string; at: number }
  | { type: 'admin-unmute-peer'; from: string; to: string; at: number }
  | { type: 'admin-mute-state'; from: string; targetPeerId: string; muted: boolean; at: number }
  | { type: 'request-to-speak'; from: string; senderName: string; requestedAt: number }
  | { type: 'allow-speak'; from: string; to: string; at: number }
  | { type: 'reject-speak'; from: string; to: string; at: number }
  | { type: 'voice-quality-profile'; from: string; profile: 'high' | 'balanced' | 'low'; at: number };

type IncomingFile = {
  id: string;
  from: string;
  to?: string;
  senderName: string;
  fileName: string;
  mimeType: string;
  kind: ChatMessageKind;
  total: number;
  createdAt: number;
  private?: boolean;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  waveform?: number[];
  chunks: string[];
  received: number;
  receivedChars: number;
};

type IncomingStreamFile = {
  id: string;
  transferId: string;
  from: string;
  to?: string;
  senderName: string;
  fileName: string;
  safeFileName: string;
  fileSize: number;
  mimeType: string;
  kind: ChatMessageKind;
  chunkSize: number;
  totalChunks: number;
  createdAt: number;
  private?: boolean;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  waveform?: number[];
  receivedBytes: number;
  receivedChunks: Set<number>;
  localPath?: string;
};

type PeerRuntime = {
  peerId: string;
  profile?: PeerProfile;
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  fileDc?: RTCDataChannel;
  statsPrevious?: RtcCounterState;
  reconnectCount: number;
  iceRestartCount: number;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  negotiationQueued: boolean;
  negotiationTimer?: number;
  screenStream: MediaStream;
  cameraStream: MediaStream;
  screenStreamId?: string;
  cameraStreamId?: string;
  screenVideoSender?: RTCRtpSender;
  cameraVideoSender?: RTCRtpSender;
  screenSenders: RTCRtpSender[];
  cameraSenders: RTCRtpSender[];
  incomingFiles: Map<string, IncomingFile>;
  incomingStreamFiles: Map<string, IncomingStreamFile>;
  pendingCandidates: RTCIceCandidateInit[];
  candidateKeys: Set<string>;
  connectionStatus: PeerConnectionStatus;
  restartTimer?: number;
  connectingTimer?: number;
  handshakeTimer?: number;
  handshakeAttempts: number;
  repairAttempts: number;
  hardResetCount: number;
  remoteScreenRecoveries: Map<string, { timer?: number; attempts: number }>;
  lastScreenRefreshRequestAt?: number;
  disposing: boolean;
  sendQueue: DataPacket[];
};

type Callbacks = {
  onState: (state: ConnectionState, label?: string) => void;
  onMessage: (message: ChatMessage) => void;
  onPeers: (peers: PeerProfile[]) => void;
  onRemoteStream: (peerId: string, streamType: 'screen' | 'camera', stream: MediaStream) => void;
  onError: (message: string) => void;
  onMedia: (peerId: string, media: { screenSharing?: boolean; micEnabled?: boolean; cameraSharing?: boolean }) => void;
  onPeerLeft: (peerId: string) => void;
  onMessageEdit: (messageId: string, body: string, editedAt: number, peerId: string) => void;
  onMessageDelete: (messageId: string, deletedAt: number, peerId: string) => void;
  onMessageReceipt: (messageId: string, peerId: string, status: 'delivered' | 'seen', at: number) => void;
  onFileProgress?: (message: ChatMessage) => void;
  onTyping: (peerId: string, senderName: string, active: boolean) => void;
  onOwner: (isOwner: boolean, ownerId: string) => void;
  onRoles: (roles: Record<string, RoomRole>) => void;
  onJoinRequest: (request: JoinRequest) => void;
  onJoinDecision: (accepted: boolean) => void;
  onKicked: () => void;
  onBans: (members: BannedMember[]) => void;
  onLocalMedia?: (media: { screenSharing?: boolean; micEnabled?: boolean; cameraSharing?: boolean }) => void;
  onVoiceActivity?: (peerId: string, speaking: boolean, audioLevel?: number) => void;
  onAdminMuteAll?: (fromPeerId: string) => void;
  onAdminUnmuteAll?: (fromPeerId: string) => void;
  onAdminPeerMuteState?: (peerId: string, muted: boolean, fromPeerId: string) => void;
  onRequestToSpeak?: (request: { peerId: string; displayName: string; requestedAt: number }) => void;
  onSpeakPermission?: (allowed: boolean, fromPeerId: string) => void;
  onVoiceProfile?: (profile: 'high' | 'balanced' | 'low') => void;
  onVoicePressure?: (level: 'normal' | 'pressure' | 'severe') => void;
  onRtcDiagnostics?: (snapshot: RtcDiagnosticsSnapshot) => void;
  onProfileAssetAccess?: (access: ProfileAssetAccess | null) => void;
  onProfileAssetsStale?: () => void;
  onLog?: (message: string, level?: 'info' | 'error') => void;
};

const BASE_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

// Optional TURN support. Keep credentials out of source code.
// Configure later at build time with VITE_TURN_URLS, VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL
// or at runtime with localStorage keys mhlko.turn.urls / username / credential.
function getConfiguredIceServers(): RTCIceServer[] {
  const servers = [...BASE_ICE_SERVERS];
  try {
    const env = import.meta.env as Record<string, string | undefined>;
    const rawUrls = (env.VITE_TURN_URLS || window.localStorage.getItem('mhlko.turn.urls') || '').trim();
    const username = (env.VITE_TURN_USERNAME || window.localStorage.getItem('mhlko.turn.username') || '').trim();
    const credential = (env.VITE_TURN_CREDENTIAL || window.localStorage.getItem('mhlko.turn.credential') || '').trim();
    if (rawUrls) {
      const urls = rawUrls.split(',').map((value) => value.trim()).filter(Boolean).sort((a, b) => {
        const rank = (value: string) => value.startsWith('turns:') ? 3 : value.includes('transport=tcp') ? 2 : value.startsWith('turn:') ? 1 : 0;
        return rank(a) - rank(b);
      });
      if (urls.length) servers.push(username || credential ? { urls, username, credential } : { urls });
    }
  } catch { /* localStorage/import.meta may be unavailable in tests */ }
  return servers;
}

const CONNECTING_WATCHDOG_MS = 6500;
const FAST_ICE_COMPLETE_WATCHDOG_MS = 900;
const HANDSHAKE_RETRY_MS = 1600;
const MAX_HANDSHAKE_RETRIES = 5;
const HARD_RESET_AFTER_REPAIRS = 3;
const MAX_HARD_RESETS = 2;
const SIGNALING_HEARTBEAT_INTERVAL_MS = 15_000;
const SIGNALING_STALE_AFTER_MS = 45_000;
const SIGNALING_RECONNECT_MAX_MS = 12_000;
const MAX_QUEUED_RTC_SIGNALS = 96;

const LEGACY_FILE_CHUNK_SIZE = 16 * 1024;
export const MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
export const INLINE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const FILE_CHUNK_BYTES = 64 * 1024;
const FILE_BUFFERED_HIGH_WATER = 1 * 1024 * 1024;
const FILE_BUFFERED_LOW_WATER = 256 * 1024;
const DATA_CHANNEL_BUFFERED_HIGH_WATER = 256 * 1024;
const DATA_CHANNEL_BUFFERED_LOW_WATER = 64 * 1024;
const MAX_FILE_DATAURL_CHARS = 28 * 1024 * 1024; // legacy inline guard only; large files use binary streaming.
const MAX_DATA_PACKET_CHARS = 64 * 1024;
const MAX_CONCURRENT_INCOMING_FILES = 16;
const MAX_LEGACY_FILE_CHUNKS = Math.ceil(MAX_FILE_DATAURL_CHARS / LEGACY_FILE_CHUNK_SIZE);


type FileBinaryChunk = { transferId: string; chunkIndex: number; byteOffset: number; payload: Uint8Array };
const FILE_BINARY_ENCODER = new TextEncoder();
const FILE_BINARY_DECODER = new TextDecoder();

function safeFileName(fileName: string): string {
  const clean = fileName.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').replace(/\.\.+/g, '_').trim();
  return (clean || 'mhlkotalk-file').slice(0, 160);
}

function packFileBinaryChunk(transferId: string, chunkIndex: number, byteOffset: number, payload: ArrayBuffer): ArrayBuffer {
  const header = FILE_BINARY_ENCODER.encode(JSON.stringify({ transferId, chunkIndex, byteOffset }));
  const body = new Uint8Array(payload);
  const out = new Uint8Array(4 + header.length + body.length);
  new DataView(out.buffer).setUint32(0, header.length, false);
  out.set(header, 4);
  out.set(body, 4 + header.length);
  return out.buffer;
}

function unpackFileBinaryChunk(data: ArrayBuffer): FileBinaryChunk | null {
  if (data.byteLength < 4 || data.byteLength > FILE_CHUNK_BYTES + 4100) return null;
  const view = new DataView(data);
  const headerLength = view.getUint32(0, false);
  if (headerLength <= 0 || headerLength > 4096 || 4 + headerLength > data.byteLength) return null;
  const header = JSON.parse(FILE_BINARY_DECODER.decode(new Uint8Array(data, 4, headerLength))) as { transferId?: string; chunkIndex?: number; byteOffset?: number };
  if (!header.transferId || !/^[a-zA-Z0-9_-]{1,96}$/.test(header.transferId)) return null;
  if (!Number.isSafeInteger(header.chunkIndex) || Number(header.chunkIndex) < 0 || !Number.isSafeInteger(header.byteOffset) || Number(header.byteOffset) < 0) return null;
  return {
    transferId: String(header.transferId),
    chunkIndex: Number(header.chunkIndex),
    byteOffset: Number(header.byteOffset),
    payload: new Uint8Array(data, 4 + headerLength)
  };
}

function waitForBufferedLow(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= FILE_BUFFERED_HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const previousThreshold = channel.bufferedAmountLowThreshold;
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('error', onClose);
      channel.bufferedAmountLowThreshold = previousThreshold;
    };
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('file data channel closed')); };
    channel.bufferedAmountLowThreshold = FILE_BUFFERED_LOW_WATER;
    channel.addEventListener('bufferedamountlow', onLow, { once: true });
    channel.addEventListener('close', onClose, { once: true });
    channel.addEventListener('error', onClose, { once: true });
  });
}

function kindFromMime(mimeType: string): ChatMessageKind {
  return mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'file';
}

function isMLineOrderMismatch(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '').toLowerCase();
  return message.includes('order of m-lines') && message.includes('subsequent offer');
}

function pcCleanup(pc: RTCPeerConnection) {
  pc.onicecandidate = null;
  pc.onconnectionstatechange = null;
  pc.oniceconnectionstatechange = null;
  pc.onicegatheringstatechange = null;
  pc.ontrack = null;
  pc.ondatachannel = null;
  pc.onnegotiationneeded = null;
}

export class RealtimeRoom {
  private ws?: WebSocket;
  private readonly roomId: string;
  private readonly signalingUrl: string;
  private readonly peerId = crypto.randomUUID();
  private readonly stableClientId = getStableClientId();
  private profile: UserProfile;
  private readonly callbacks: Callbacks;
  private reconnectTimer?: number;
  private socketGeneration = 0;
  private reconnectAttempt = 0;
  private signalingHeartbeatTimer?: number;
  private lastSignalingActivityAt = 0;
  /** Bounded, lightweight SDP/ICE control messages retained only across a signaling reconnect. */
  private pendingRtcSignals: SignalMessage[] = [];
  private pendingStateRefresh = false;
  private peerSignalChains = new Map<string, Promise<void>>();
  private voiceMicRestoreTimer?: number;
  private closedByUser = false;
  private rtcStatsTimer?: number;
  private eventLoopTimer?: number;
  private eventLoopLagMs = 0;
  private eventLoopExpectedAt = 0;
  private diagnosticsHistory: RtcDiagnosticsSnapshot[] = [];
  private diagnosticsEnabled = false;
  private lastDiagnosticsLogAt = 0;
  private pressureCandidate: RtcPressureLevel = 'normal';
  private pressureCandidateSince = 0;
  private pressureRecoverySince = 0;
  private recordingActive = false;
  private voiceDesiredActive = false;
  private voiceMicEnabled = true;
  private voiceInputDeviceId?: string;
  private voiceOutputDeviceId?: string;
  private voiceEnhanceEnabled = true;
  private readonly voiceCompanionToken = createVoiceCompanionToken();
  private voiceCompanionRegistered = false;
  private voiceCompanionReady = false;
  private voiceCompanionStartPromise?: Promise<void>;
  private voiceCompanionUnlisten?: () => void;
  private voiceCompanionRestartAttempts = 0;
  private voiceCompanionHeartbeatAt = 0;
  private voiceCompanionGeneration = 0;
  private voiceCompanionHealthTimer?: number;
  private voiceCompanionHealthCheckInFlight = false;
  private voiceCompanionHealthMisses = 0;
  private voiceCompanionLastRestartAt = 0;
  private voiceReadyWaiters = new Set<(ready: boolean) => void>();
  private voiceMessageStartWaiters = new Map<string, VoiceMessageWaiter<VoiceMessageStartResult>>();
  private voiceMessageCompleteWaiters = new Map<string, VoiceMessageWaiter<Blob>>();
  private activeVoiceMessageRecordingId = '';
  private recoveryListenersAttached = false;
  /** Stable transport stream used by WebRTC and the recorder. */
  private screenStream?: MediaStream;
  /** Raw getDisplayMedia stream. Kept separate so camera composition can replace only video. */
  private screenCaptureStream?: MediaStream;
  private cameraStream?: MediaStream;
  private screenCompositor?: ScreenCameraCompositor;
  private localScreenMuteTimer?: number;
  private localScreenRecoveryAttempts = 0;
  private nativeAudioContext?: AudioContext;
  private nativeAudioDestination?: MediaStreamAudioDestinationNode;
  private nativeAudioTrack?: MediaStreamTrack;
  private nativeAudioNextTime = 0;
  private nativeAudioUnlisten?: () => void;
  private nativeAudioErrorUnlisten?: () => void;
  private nativeAudioRecoveryTimer?: number;
  private nativeAudioRecoveryAttempts = 0;
  private nativeAudioRecovering = false;
  private screenAudioLifecycle: Promise<void> = Promise.resolve();
  private roomReady = false;
  private screenStopping = false;
  private currentScreenBitrate = qualityToParams('auto-max').bitrate;
  private currentScreenFps: ScreenFps = 60;
  private voiceProfile: 'high' | 'balanced' | 'low' = 'high';
  private voicePressureLevel: 'normal' | 'pressure' | 'severe' = 'normal';
  private lastVoicePressureNotifyAt = 0;
  private roomRoles: Record<string, RoomRole> = {};
  private peers = new Map<string, PeerRuntime>();

  constructor(args: { roomId: string; signalingUrl: string; profile: UserProfile; callbacks: Callbacks }) {
    this.roomId = args.roomId;
    this.signalingUrl = args.signalingUrl.replace(/\/$/, '');
    this.profile = args.profile;
    this.callbacks = args.callbacks;
  }

  private log(message: string, level: 'info' | 'error' = 'info') {
    this.callbacks.onLog?.(message, level);
  }

  private updateRoles(roles: Record<string, RoomRole>) {
    this.roomRoles = { ...roles };
    this.callbacks.onRoles(this.roomRoles);
  }

  private isAuthorizedModerator(peerId: string, ownerOnly = false): boolean {
    const role = this.roomRoles[peerId];
    return ownerOnly ? role === 'owner' : role === 'owner' || role === 'moderator';
  }

  private resolveVoiceReady(ready: boolean) {
    for (const resolve of this.voiceReadyWaiters) resolve(ready);
    this.voiceReadyWaiters.clear();
  }

  private async attachVoiceCompanionListener(): Promise<void> {
    if (this.voiceCompanionUnlisten) return;
    this.voiceCompanionUnlisten = await listen<Record<string, unknown>>('mhtalk://voice-companion-event', (event) => {
      this.handleVoiceCompanionEvent(event.payload).catch((error) => {
        this.log(`MHTalkVoice event failed: ${String((error as Error)?.message || error)}`, 'error');
      });
    });
  }

  private async handleVoiceCompanionEvent(payload: Record<string, unknown>): Promise<void> {
    const type = String(payload?.type || '');
    if (type === 'ENGINE_STARTED') {
      this.voiceCompanionGeneration = Number(payload.generation || 0);
      this.log(`MHTalkVoice process started pid=${Number(payload.processId || 0)}`);
      return;
    }
    if (type === 'VOICE_READY') {
      this.voiceCompanionReady = true;
      this.voiceCompanionRestartAttempts = 0;
      this.voiceCompanionLastRestartAt = 0;
      this.voiceCompanionHeartbeatAt = Date.now();
      this.voiceCompanionHealthMisses = 0;
      this.resolveVoiceReady(true);
      this.log(`MHTalkVoice ready pid=${Number(payload.processId || 0)}`);
      if (this.voiceDesiredActive && payload.micActive === false) this.scheduleVoiceMicRestore('voice-ready');
      await this.restoreScreenSystemAudioAfterVoiceRestart();
      return;
    }
    if (type === 'VOICE_DISCONNECTED') {
      this.voiceCompanionReady = false;
      await this.disableScreenSystemAudio('MHTalkVoice signaling disconnected; system audio was disabled to prevent call echo.');
      this.log(`MHTalkVoice disconnected: ${String(payload.reason || 'signaling-closed')}`, 'error');
      if (!this.closedByUser && this.roomReady) {
        window.setTimeout(() => {
          this.ensureVoiceCompanionReady().catch(() => undefined);
        }, 900);
      }
      return;
    }
    if (type === 'VOICE_HEARTBEAT') {
      this.voiceCompanionHeartbeatAt = Date.now();
      this.voiceCompanionHealthMisses = 0;
      if (this.voiceDesiredActive && payload.micActive === false) this.scheduleVoiceMicRestore('heartbeat');
      return;
    }
    if (type === 'PONG') {
      this.voiceCompanionHeartbeatAt = Date.now();
      this.voiceCompanionHealthMisses = 0;
      return;
    }
    if (type === 'MIC_STATE') {
      const enabled = Boolean(payload.enabled);
      this.callbacks.onLocalMedia?.({ micEnabled: enabled });
      if (!enabled) this.callbacks.onVoiceActivity?.(this.peerId, false, 0);
      return;
    }
    if (type === 'REMOTE_MIC_STATE') {
      const peerId = String(payload.peerId || '');
      if (peerId) this.callbacks.onMedia(peerId, { micEnabled: Boolean(payload.enabled) });
      return;
    }
    if (type === 'SPEAKING') {
      const peerId = String(payload.peerId || '');
      if (peerId) this.callbacks.onVoiceActivity?.(peerId, Boolean(payload.speaking), Number(payload.level || 0));
      return;
    }
    if (type === 'VOICE_PEER_STATE') {
      const peerId = String(payload.peerId || '');
      if (peerId && this.diagnosticsEnabled) this.log(`MHTalkVoice peer ${peerId}: ${String(payload.state || '')}`);
      return;
    }
    if (type === 'VOICE_MESSAGE_STARTED') {
      const recordingId = String(payload.recordingId || '');
      const waiter = this.voiceMessageStartWaiters.get(recordingId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        this.voiceMessageStartWaiters.delete(recordingId);
        waiter.resolve({ recordingId, mimeType: String(payload.mimeType || 'audio/webm') });
      }
      this.activeVoiceMessageRecordingId = recordingId;
      this.log(`Voice message recording started in MHTalkVoice: ${recordingId}`);
      return;
    }
    if (type === 'VOICE_MESSAGE_COMPLETE') {
      const recordingId = String(payload.recordingId || '');
      const waiter = this.voiceMessageCompleteWaiters.get(recordingId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        this.voiceMessageCompleteWaiters.delete(recordingId);
        try {
          const bytes = base64ToUint8Array(String(payload.data || ''));
          waiter.resolve(new Blob([bytes], { type: String(payload.mimeType || 'audio/webm') }));
        } catch (error) {
          waiter.reject(new Error(`voice message decode failed: ${String((error as Error)?.message || error)}`));
        }
      }
      if (this.activeVoiceMessageRecordingId === recordingId) this.activeVoiceMessageRecordingId = '';
      this.log(`Voice message recording completed in MHTalkVoice: ${recordingId}`);
      return;
    }
    if (type === 'VOICE_MESSAGE_ERROR' || type === 'VOICE_MESSAGE_CANCELED') {
      const recordingId = String(payload.recordingId || this.activeVoiceMessageRecordingId || '');
      const message = String(payload.message || (type === 'VOICE_MESSAGE_CANCELED' ? 'voice message recording canceled' : 'voice message recording failed'));
      this.rejectVoiceMessageWaiters(recordingId, new Error(message));
      if (this.activeVoiceMessageRecordingId === recordingId) this.activeVoiceMessageRecordingId = '';
      if (type === 'VOICE_MESSAGE_ERROR') this.log(`MHTalkVoice voice message error: ${message}`, 'error');
      return;
    }
    if (type === 'USER_ACTION_REQUIRED' || type === 'MIC_PERMISSION_REQUIRED') {
      const message = String(payload.message || 'MHTalkVoice needs user permission to continue.');
      this.log(message, 'info');
      this.callbacks.onError(message);
      return;
    }
    if (type === 'VOICE_ERROR') {
      const message = String(payload.message || 'MHTalkVoice error');
      this.log(message, 'error');
      this.callbacks.onError(message);
      return;
    }
    if (type === 'ENGINE_EXITED') {
      const expected = Boolean(payload.expected);
      this.voiceCompanionReady = false;
      this.resolveVoiceReady(false);
      if (this.activeVoiceMessageRecordingId) {
        this.rejectVoiceMessageWaiters(this.activeVoiceMessageRecordingId, new Error('MHTalkVoice stopped while recording the voice message'));
        this.activeVoiceMessageRecordingId = '';
      }
      await this.disableScreenSystemAudio('MHTalkVoice stopped; system audio was disabled to prevent call echo.');
      if (!expected && !this.closedByUser && this.roomReady && this.voiceCompanionRestartAttempts < 3) {
        this.voiceCompanionRestartAttempts += 1;
        const delay = Math.min(4000, 500 * (2 ** (this.voiceCompanionRestartAttempts - 1)));
        this.log(`MHTalkVoice exited unexpectedly; recovery attempt ${this.voiceCompanionRestartAttempts}/3.`, 'error');
        window.setTimeout(() => {
          this.launchVoiceCompanion(true).catch((error) => {
            this.log(`MHTalkVoice restart failed: ${String((error as Error)?.message || error)}`, 'error');
          });
        }, delay);
      }
      return;
    }
    if (type === 'VOICE_LOG' && this.diagnosticsEnabled) this.log(String(payload.message || 'MHTalkVoice'));
  }

  private scheduleVoiceMicRestore(reason: string) {
    if (!this.voiceDesiredActive || !this.voiceCompanionReady || this.closedByUser || this.voiceMicRestoreTimer) return;
    this.voiceMicRestoreTimer = window.setTimeout(() => {
      this.voiceMicRestoreTimer = undefined;
      if (!this.voiceDesiredActive || !this.voiceCompanionReady || this.closedByUser) return;
      invoke('send_voice_companion_command', {
        command: {
          type: 'START_MIC',
          payload: {
            inputDeviceId: this.voiceInputDeviceId || null,
            outputDeviceId: this.voiceOutputDeviceId || null,
            voiceEnhanceEnabled: this.voiceEnhanceEnabled,
            micEnabled: this.voiceMicEnabled,
            recoveryReason: reason
          }
        }
      }).then(() => this.log(`Microphone restored after voice recovery: ${reason}`)).catch((error) => {
        this.log(`Microphone restore failed after ${reason}: ${String((error as Error)?.message || error)}`, 'error');
      });
    }, 800);
  }

  private rejectVoiceMessageWaiters(recordingId: string, error: Error) {
    const startWaiter = this.voiceMessageStartWaiters.get(recordingId);
    if (startWaiter) {
      window.clearTimeout(startWaiter.timer);
      this.voiceMessageStartWaiters.delete(recordingId);
      startWaiter.reject(error);
    }
    const completeWaiter = this.voiceMessageCompleteWaiters.get(recordingId);
    if (completeWaiter) {
      window.clearTimeout(completeWaiter.timer);
      this.voiceMessageCompleteWaiters.delete(recordingId);
      completeWaiter.reject(error);
    }
  }

  private async readVoiceCompanionStatus(): Promise<VoiceCompanionStatus | null> {
    try {
      return await invoke<VoiceCompanionStatus>('voice_companion_status');
    } catch {
      return null;
    }
  }

  private voiceCompanionBootstrapConfig() {
    return {
      roomId: this.roomId,
      signalingUrl: this.signalingUrl,
      parentPeerId: this.peerId,
      voiceToken: this.voiceCompanionToken,
      displayName: this.profile.display_name || 'MHTalk User',
      iceServers: getConfiguredIceServers()
    };
  }

  private async ensureVoiceCompanionProcessForLocalCapture(): Promise<boolean> {
    const status = await this.readVoiceCompanionStatus();
    if (status?.running && status.processId > 0) {
      try {
        // BOOTSTRAP and the following local recorder command share the same ordered
        // stdin queue. Voice-message recording therefore remains available during a
        // temporary signaling reconnect without killing a healthy call microphone.
        await invoke('start_voice_companion', { config: this.voiceCompanionBootstrapConfig() });
        return true;
      } catch (error) {
        this.log(`MHTalkVoice local-capture resync failed: ${String((error as Error)?.message || error)}`, 'error');
      }
    }
    return this.ensureVoiceCompanionReady();
  }

  private waitForVoiceCompanionReady(timeoutMs = 12_000): Promise<boolean> {
    if (this.voiceCompanionReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.voiceReadyWaiters.delete(finish);
        resolve(ready);
      };
      const timer = window.setTimeout(() => finish(false), timeoutMs);
      this.voiceReadyWaiters.add(finish);
    });
  }

  private async registerVoiceCompanion(): Promise<void> {
    if (!this.roomReady || this.closedByUser) return;
    await this.attachVoiceCompanionListener();
    this.voiceCompanionRegistered = false;
    this.sendSignal({ type: 'companion-register', from: this.peerId, token: this.voiceCompanionToken });
  }

  private async launchVoiceCompanion(forceRestart = false): Promise<void> {
    if (this.closedByUser || !this.roomReady || !this.voiceCompanionRegistered) throw new Error('voice companion is not registered with the room');
    if (this.voiceCompanionReady && !forceRestart) return;
    if (this.voiceCompanionStartPromise) return this.voiceCompanionStartPromise;
    const task = (async () => {
      await this.attachVoiceCompanionListener();
      if (forceRestart) {
        try { await invoke('stop_voice_companion'); } catch { /* process may already be gone */ }
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
      this.voiceCompanionReady = false;
      await invoke('start_voice_companion', {
        config: this.voiceCompanionBootstrapConfig()
      });
      const ready = await this.waitForVoiceCompanionReady();
      if (!ready) throw new Error('MHTalkVoice did not become ready');
      if (this.voiceOutputDeviceId) await this.sendVoiceCompanionCommand('SET_OUTPUT_DEVICE', { outputDeviceId: this.voiceOutputDeviceId });
    })();
    this.voiceCompanionStartPromise = task;
    try { await task; } finally { if (this.voiceCompanionStartPromise === task) this.voiceCompanionStartPromise = undefined; }
  }

  private async ensureVoiceCompanionReady(): Promise<boolean> {
    if (this.voiceCompanionReady) return true;

    const nativeStatus = await this.readVoiceCompanionStatus();
    if (nativeStatus?.ready && nativeStatus.running && nativeStatus.processId > 0) {
      this.voiceCompanionReady = true;
      this.voiceCompanionHeartbeatAt = Date.now();
      this.resolveVoiceReady(true);
      this.log(`MHTalkVoice readiness resynchronized from native status pid=${nativeStatus.processId}`);
      return true;
    }

    if (!this.voiceCompanionRegistered) {
      await this.registerVoiceCompanion();
      const registered = await new Promise<boolean>((resolve) => {
        const deadline = Date.now() + 5000;
        const check = () => {
          if (this.voiceCompanionRegistered) resolve(true);
          else if (Date.now() >= deadline || this.closedByUser) resolve(false);
          else window.setTimeout(check, 80);
        };
        check();
      });
      if (!registered) return false;
    }

    try {
      // Re-sending BOOTSTRAP to an existing sidecar is harmless and repairs a missed
      // VOICE_READY event without killing a healthy microphone or remote playback graph.
      if (nativeStatus?.running) {
        await invoke('start_voice_companion', { config: this.voiceCompanionBootstrapConfig() });
        if (await this.waitForVoiceCompanionReady(6500)) return true;
      }

      await this.launchVoiceCompanion(Boolean(nativeStatus?.running));
      if (this.voiceCompanionReady) return true;

      const finalStatus = await this.readVoiceCompanionStatus();
      if (finalStatus?.ready && finalStatus.running) {
        this.voiceCompanionReady = true;
        this.voiceCompanionHeartbeatAt = Date.now();
        return true;
      }
      return false;
    } catch (error) {
      this.log(`MHTalkVoice unavailable: ${String((error as Error)?.message || error)}`, 'error');
      return false;
    }
  }

  private async sendVoiceCompanionCommand(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (!(await this.ensureVoiceCompanionReady())) throw new Error('MHTalkVoice is not ready');
    await invoke('send_voice_companion_command', { command: { type, payload } });
  }

  private async stopVoiceCompanion(): Promise<void> {
    this.voiceCompanionReady = false;
    this.resolveVoiceReady(false);
    if (this.activeVoiceMessageRecordingId) {
      this.rejectVoiceMessageWaiters(this.activeVoiceMessageRecordingId, new Error('voice companion stopped'));
      this.activeVoiceMessageRecordingId = '';
    }
    if (this.voiceCompanionRegistered) this.sendSignal({ type: 'companion-revoke', from: this.peerId });
    this.voiceCompanionRegistered = false;
    try { await invoke('stop_voice_companion'); } catch { /* sidecar may not have started */ }
  }

  getRtcDiagnosticsHistory(): RtcDiagnosticsSnapshot[] {
    return this.diagnosticsHistory.map((item) => ({ ...item }));
  }

  setRecordingActive(active: boolean): void {
    this.recordingActive = active;
  }

  private readonly handleMediaDeviceChange = () => {
    if (this.voiceDesiredActive && this.voiceCompanionReady) {
      // MHTalkVoice owns the microphone and performs an in-process track replacement.
      // Keep the GUI process out of getUserMedia so call audio can never leak into it.
      invoke('send_voice_companion_command', { command: { type: 'PING', payload: { reason: 'device-change' } } }).catch(() => undefined);
    }
    if (this.screenStream && !this.screenStopping) this.scheduleNativeSystemAudioRecovery('Windows audio device changed');
  };

  private readonly handleNetworkResume = () => {
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'disconnected' || peer.pc.iceConnectionState === 'failed') {
        this.schedulePeerRepair(peer, 0);
      }
    }
    if (this.voiceCompanionReady) invoke('send_voice_companion_command', { command: { type: 'PING', payload: { reason: 'network-resume' } } }).catch(() => undefined);
  };

  private readonly handleVisibilityResume = () => {
    if (document.visibilityState === 'visible') this.handleNetworkResume();
  };

  private attachRecoveryListeners() {
    if (this.recoveryListenersAttached) return;
    this.recoveryListenersAttached = true;
    navigator.mediaDevices?.addEventListener?.('devicechange', this.handleMediaDeviceChange);
    window.addEventListener('online', this.handleNetworkResume);
    document.addEventListener('visibilitychange', this.handleVisibilityResume);
  }

  private detachRecoveryListeners() {
    if (!this.recoveryListenersAttached) return;
    this.recoveryListenersAttached = false;
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.handleMediaDeviceChange);
    window.removeEventListener('online', this.handleNetworkResume);
    document.removeEventListener('visibilitychange', this.handleVisibilityResume);
  }

  private startEventLoopMonitor() {
    if (this.eventLoopTimer) window.clearInterval(this.eventLoopTimer);
    const interval = 500;
    this.eventLoopExpectedAt = performance.now() + interval;
    this.eventLoopTimer = window.setInterval(() => {
      const now = performance.now();
      const drift = Math.max(0, now - this.eventLoopExpectedAt);
      this.eventLoopLagMs = this.eventLoopLagMs * 0.7 + drift * 0.3;
      this.eventLoopExpectedAt = now + interval;
    }, interval);
  }

  private stopEventLoopMonitor() {
    if (this.eventLoopTimer) window.clearInterval(this.eventLoopTimer);
    this.eventLoopTimer = undefined;
    this.eventLoopLagMs = 0;
  }

  private async verifyVoiceCompanionHealth(observedSilenceMs: number): Promise<void> {
    const heartbeatBeforeProbe = this.voiceCompanionHeartbeatAt;
    const nativeStatus = await this.readVoiceCompanionStatus();
    if (!nativeStatus) {
      this.voiceCompanionHealthMisses += 1;
      const currentSilenceMs = Date.now() - this.voiceCompanionHeartbeatAt;
      if (this.voiceCompanionHealthMisses < 3 && currentSilenceMs < 20_000) return;
    }
    if (nativeStatus?.running && nativeStatus.ready && nativeStatus.processId > 0) {
      await invoke('send_voice_companion_command', {
        command: { type: 'PING', payload: { reason: 'health-probe' } }
      }).catch(() => undefined);
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      if (this.voiceCompanionHeartbeatAt > heartbeatBeforeProbe) {
        this.voiceCompanionHealthMisses = 0;
        return;
      }
      const confirmedStatus = await this.readVoiceCompanionStatus();
      if (confirmedStatus?.running && confirmedStatus.ready && confirmedStatus.processId > 0) {
        this.voiceCompanionHealthMisses += 1;
        const currentSilenceMs = Date.now() - this.voiceCompanionHeartbeatAt;
        if (this.voiceCompanionHealthMisses < 3 && currentSilenceMs < 20_000) return;
      } else if (!confirmedStatus || (confirmedStatus.running && confirmedStatus.processId > 0)) {
        this.voiceCompanionHealthMisses += 1;
        const currentSilenceMs = Date.now() - this.voiceCompanionHeartbeatAt;
        if (this.voiceCompanionHealthMisses < 3 && currentSilenceMs < 20_000) return;
      }
    }
    if (nativeStatus?.running && nativeStatus.processId > 0 && !nativeStatus.ready) {
      this.voiceCompanionHealthMisses += 1;
      const currentSilenceMs = Date.now() - this.voiceCompanionHeartbeatAt;
      if (this.voiceCompanionHealthMisses < 3 && currentSilenceMs < 20_000) return;
    }

    if (!this.voiceCompanionReady || this.closedByUser || !this.roomReady) return;
    this.voiceCompanionHealthMisses = 0;
    this.voiceCompanionReady = false;
    this.resolveVoiceReady(false);
    await this.disableScreenSystemAudio('MHTalkVoice heartbeat was lost; system audio was disabled to prevent call echo.');
    this.log(`MHTalkVoice heartbeat timeout confirmed (${Math.max(observedSilenceMs, Date.now() - this.voiceCompanionHeartbeatAt)}ms).`, 'error');
    const now = Date.now();
    if (this.voiceCompanionRestartAttempts < 3 && now - this.voiceCompanionLastRestartAt > 3500) {
      this.voiceCompanionRestartAttempts += 1;
      this.voiceCompanionLastRestartAt = now;
      this.launchVoiceCompanion(true).catch((error) => {
        this.log(`MHTalkVoice heartbeat restart failed: ${String((error as Error)?.message || error)}`, 'error');
      });
    }
  }

  private startVoiceCompanionHealthMonitor() {
    if (this.voiceCompanionHealthTimer) window.clearInterval(this.voiceCompanionHealthTimer);
    this.voiceCompanionHealthTimer = window.setInterval(() => {
      if (!this.voiceCompanionReady || this.closedByUser || !this.roomReady) return;
      const silenceMs = Date.now() - this.voiceCompanionHeartbeatAt;
      if (this.voiceCompanionHeartbeatAt <= 0 || silenceMs < 8000 || this.voiceCompanionHealthCheckInFlight) return;
      this.voiceCompanionHealthCheckInFlight = true;
      this.verifyVoiceCompanionHealth(silenceMs)
        .catch((error) => this.log(`MHTalkVoice health probe failed: ${String((error as Error)?.message || error)}`, 'error'))
        .finally(() => { this.voiceCompanionHealthCheckInFlight = false; });
    }, 2500);
  }

  private stopVoiceCompanionHealthMonitor() {
    if (this.voiceCompanionHealthTimer) window.clearInterval(this.voiceCompanionHealthTimer);
    this.voiceCompanionHealthTimer = undefined;
    this.voiceCompanionHealthCheckInFlight = false;
    this.voiceCompanionHealthMisses = 0;
  }

  getLocalPeerId(): string { return this.peerId; }
  getLocalScreenStream(): MediaStream | undefined { return this.screenStream; }
  getLocalCameraStream(): MediaStream | undefined { return this.cameraStream; }
  isCameraOverlayActive(): boolean { return Boolean(this.screenCompositor); }

  async connect(): Promise<void> {
    this.closedByUser = false;
    try { this.diagnosticsEnabled = window.localStorage.getItem('mhtalk.dev.rtcDiagnostics') === '1'; } catch { this.diagnosticsEnabled = false; }
    this.attachRecoveryListeners();
    this.startEventLoopMonitor();
    this.startRtcStatsMonitor();
    this.startVoiceCompanionHealthMonitor();
    this.log(`Connecting to room ${this.roomId}`);
    this.callbacks.onState('connecting', 'state_connecting');
    this.openWebSocket();
  }

  updateProfile(profile: UserProfile) {
    const avatarChanged = profileAvatarVersion(profile.avatar_data_url) !== profileAvatarVersion(this.profile.avatar_data_url);
    this.profile = profile;
    if (!avatarChanged) this.announceProfile();
    this.emitPeers();
  }

  announceProfile() {
    this.sendSignal({ type: 'profile', from: this.peerId, profile: this.publicProfile() });
  }

  private setRoomReady(label = 'state_room_ready') {
    this.roomReady = true;
    this.callbacks.onState('connected', label);
  }

  private refreshRoomState() {
    if (!this.roomReady) return;
    const connectedPeers = [...this.peers.values()].filter((peer) => this.isPeerConnected(peer)).length;
    this.callbacks.onState('connected', connectedPeers > 0 ? 'state_connected' : 'state_room_ready');
    if (connectedPeers === 0) this.log('Waiting for members');
  }

  private setPeerConnectionStatus(peer: PeerRuntime, status: PeerConnectionStatus, label?: string) {
    if (peer.connectionStatus !== status) {
      peer.connectionStatus = status;
      this.log(label || `Peer ${peer.peerId} ${status}`);
      this.emitPeers();
    }
  }

  private createPeer(peerId: string): PeerRuntime {
    const pc = new RTCPeerConnection({
      iceServers: getConfiguredIceServers(),
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 8,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    const peer: PeerRuntime = {
      peerId,
      pc,
      polite: this.peerId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      negotiationQueued: false,
      screenStream: new MediaStream(),
      cameraStream: new MediaStream(),
      screenSenders: [],
      cameraSenders: [],
      incomingFiles: new Map(),
      incomingStreamFiles: new Map(),
      pendingCandidates: [],
      candidateKeys: new Set(),
      connectionStatus: 'waiting',
      reconnectCount: 0,
      iceRestartCount: 0,
      handshakeAttempts: 0,
      repairAttempts: 0,
      hardResetCount: 0,
      remoteScreenRecoveries: new Map(),
      disposing: false,
      sendQueue: []
    };
    this.log(`Peer discovered: ${peerId}`);

    try {
      // Call audio lives exclusively in MHTalkVoice. The main WebView only receives
      // video/screen media so its process tree can never play member voice.
      pc.addTransceiver('video', { direction: 'recvonly' });
    } catch { /* older WebView builds may reject pre-created transceivers */ }

    pc.onicecandidate = ({ candidate }) => {
      this.sendSignal({ type: 'candidate', from: this.peerId, to: peerId, candidate: candidate ? candidate.toJSON() : null });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.markPeerConnected(peer);
        this.setPeerConnectionStatus(peer, 'connected', `Peer connected: ${peer.peerId}`);
        this.refreshRoomState();
      } else if (state === 'connecting') {
        this.setPeerConnectionStatus(peer, 'connecting', `Peer connecting: ${peer.peerId}`);
        this.scheduleConnectingWatchdog(peer);
      } else if (state === 'disconnected') {
        this.setPeerConnectionStatus(peer, 'reconnecting', `Peer reconnecting: ${peer.peerId}`);
        this.schedulePeerRepair(peer);
      } else if (state === 'failed') {
        this.setPeerConnectionStatus(peer, 'failed', `Peer failed: ${peer.peerId}`);
        this.schedulePeerRepair(peer, 300);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.markPeerConnected(peer);
        this.setPeerConnectionStatus(peer, 'connected', `ICE connected: ${peer.peerId}`);
        this.refreshRoomState();
      }
      if (pc.iceConnectionState === 'checking') {
        this.setPeerConnectionStatus(peer, 'connecting', `ICE checking: ${peer.peerId}`);
        this.scheduleConnectingWatchdog(peer);
      }
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        this.setPeerConnectionStatus(peer, pc.iceConnectionState === 'failed' ? 'failed' : 'reconnecting', `ICE ${pc.iceConnectionState}: ${peer.peerId}`);
        this.schedulePeerRepair(peer);
      }
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete' && !this.isPeerConnected(peer)) this.scheduleConnectingWatchdog(peer, FAST_ICE_COMPLETE_WATCHDOG_MS);
    };

    pc.ontrack = (event) => this.handleRemoteTrack(peer, event);
    pc.ondatachannel = (event) => {
      if (event.channel.label.startsWith('mhlko-voice')) {
        // Reject legacy voice channels in the GUI process. This is a hard isolation
        // boundary: only MHTalkVoice is allowed to receive or render call audio.
        try { event.channel.close(); } catch { /* ignore */ }
      } else if (event.channel.label.startsWith('mhlko-file')) this.setupFileDataChannel(peer, event.channel);
      else this.setupDataChannel(peer, event.channel);
    };
    pc.onnegotiationneeded = () => {
      peer.negotiationQueued = true;
      this.scheduleQueuedNegotiation(peer, 'browser-negotiationneeded');
    };

    if (this.shouldCreateOffer(peerId)) {
      this.setupDataChannel(peer, pc.createDataChannel(`mhlko-${peerId}`, { ordered: true }));
      this.setupFileDataChannel(peer, pc.createDataChannel(`mhlko-file-${peerId}`, { ordered: true }));
    }

    this.peers.set(peerId, peer);
    this.addCurrentLocalTracks(peer).catch((error) => {
      this.log(`Failed to attach current local media to ${peer.peerId}: ${String((error as Error)?.message || error || 'unknown')}`, 'error');
    });
    this.scheduleHandshakePulse(peer, 700);
    this.scheduleConnectingWatchdog(peer, CONNECTING_WATCHDOG_MS);
    this.emitPeers();
    return peer;
  }

  private ensurePeer(peerId: string): PeerRuntime {
    return this.peers.get(peerId) || this.createPeer(peerId);
  }

  private shouldCreateOffer(remotePeerId: string): boolean {
    return this.peerId < remotePeerId;
  }

  private openWebSocket() {
    if (this.closedByUser) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const url = `${this.signalingUrl}/room/${encodeURIComponent(this.roomId)}/ws?peerId=${encodeURIComponent(this.peerId)}&stableClientId=${encodeURIComponent(this.stableClientId)}&name=${encodeURIComponent(this.profile.display_name || 'Mhlko User')}`;
    const ws = new WebSocket(url);
    const generation = ++this.socketGeneration;
    this.ws = ws;

    ws.onopen = () => {
      if (this.closedByUser || this.ws !== ws || generation !== this.socketGeneration) return;
      this.reconnectAttempt = 0;
      this.lastSignalingActivityAt = Date.now();
      this.startSignalingHeartbeat(ws, generation);
      this.log('Room signaling connected');
      this.callbacks.onState('connecting', 'state_connecting');
    };

    ws.onmessage = async (event) => {
      if (this.closedByUser || this.ws !== ws || generation !== this.socketGeneration) return;
      this.lastSignalingActivityAt = Date.now();
      try {
        const data = JSON.parse(String(event.data));
        if (data?.type === 'server' && data.event === 'pong') return;
        if (data?.type === 'server') {
          if (data.event === 'pending-approval') {
            this.callbacks.onState('connecting', 'state_waiting_approval');
          }
          if (data.event === 'joined' || data.event === 'join-approved' || data.event === 'rejoin-approved') {
            this.log(`Room ready: ${data.event} owner=${String(data.ownerId || '')}`);
            if (data.event === 'rejoin-approved') this.log('Member rejoined within grace period');
            this.callbacks.onOwner(Boolean(data.isOwner), String(data.ownerId || ''));
            this.callbacks.onJoinDecision(true);
            if (data.roles && typeof data.roles === 'object') this.updateRoles(data.roles as Record<string, RoomRole>);
            const profileToken = typeof data.profileToken === 'string' ? data.profileToken : '';
            if (profileToken) {
              try {
                this.callbacks.onProfileAssetAccess?.({
                  endpointUrl: profileEndpointFromSignaling(this.signalingUrl, this.roomId),
                  token: profileToken,
                  generation
                });
              } catch (error) {
                this.log(`Profile REST endpoint unavailable: ${String((error as Error)?.message || error)}`, 'error');
              }
            }
            this.setRoomReady('state_room_ready');
            this.flushPendingRtcSignals();
            this.sendSignal({ type: 'hello', from: this.peerId, profile: this.publicProfile() });
            this.sendSignal({
              type: 'media',
              from: this.peerId,
              screenSharing: Boolean(this.screenStream),
              screenStreamId: this.screenStream?.id,
              cameraSharing: Boolean(this.cameraStream),
              cameraStreamId: this.cameraStream?.id,
              micEnabled: this.voiceMicEnabled
            });
            this.pendingStateRefresh = false;
            this.registerVoiceCompanion().catch((error) => this.log(`Voice companion registration failed: ${String((error as Error)?.message || error)}`, 'error'));
          }
          if (data.event === 'companion-registered') {
            this.voiceCompanionRegistered = true;
            this.launchVoiceCompanion().catch((error) => {
              this.log(`MHTalkVoice launch failed: ${String((error as Error)?.message || error)}`, 'error');
              this.callbacks.onError('MHTalkVoice could not start. Call audio is unavailable.');
            });
          }
          if (data.event === 'companion-register-failed') {
            this.voiceCompanionRegistered = false;
            this.callbacks.onError('MHTalkVoice room authentication failed.');
          }
          if (data.event === 'companion-revoked') this.voiceCompanionRegistered = false;
          if (data.event === 'join-request' && data.peerId) {
            this.log(`Join request: ${String(data.displayName || data.peerId)}`);
            this.callbacks.onJoinRequest({ peerId: String(data.peerId), displayName: String(data.displayName || 'Friend'), requestedAt: Number(data.requestedAt || Date.now()) });
          }
          if (data.event === 'join-rejected') {
            this.closedByUser = true;
            this.callbacks.onJoinDecision(false);
            try { this.ws?.close(); } catch { /* ignore */ }
          }
          if (data.event === 'join-approved') this.callbacks.onJoinDecision(true);
          if (data.event === 'roles' && data.roles && typeof data.roles === 'object') this.updateRoles(data.roles as Record<string, RoomRole>);
          if (data.event === 'peer-joined') {
            this.log(`Peer joined signaling room: ${String(data.peerId || '')}`);
            this.callbacks.onOwner(String(data.ownerId || '') === this.peerId, String(data.ownerId || ''));
            if (data.roles && typeof data.roles === 'object') this.updateRoles(data.roles as Record<string, RoomRole>);
            const joinedPeerId = String(data.peerId || '');
            if (joinedPeerId && joinedPeerId !== this.peerId) {
              const peer = this.ensurePeer(joinedPeerId);
              peer.profile = { peerId: joinedPeerId, displayName: String(data.displayName || 'Friend'), status: 'Online' };
              this.emitPeers();
              this.sendHelloToPeer(joinedPeerId);
              this.scheduleHandshakePulse(peer, 450);
              if (this.shouldCreateOffer(joinedPeerId)) this.negotiate(peer).catch(() => undefined);
            }
          }
          if ((data.event === 'peer-left' || data.event === 'peer-error') && data.peerId) {
            this.log(`Peer left signaling room: ${String(data.peerId || '')} event=${String(data.event || '')}`);
            this.removePeer(data.peerId);
            this.refreshRoomState();
            if (typeof data.ownerId === 'string') this.callbacks.onOwner(data.ownerId === this.peerId, data.ownerId);
            if (data.roles && typeof data.roles === 'object') this.updateRoles(data.roles as Record<string, RoomRole>);
          }
          if (data.event === 'temporary-approval-expired') this.log('Temporary approval expired');
          if (data.event === 'temporary-approval-cached') this.log('Temporary approval cached');
          if (data.event === 'temporary-approval-cleared' || data.event === 'banned-member-temporary-approval-cleared') this.log('Temporary approval cleared because kicked/banned');
          if (data.event === 'stale-temporary-approval-cleanup-completed') this.log('Stale temporary approval cleanup completed');
          if (data.event === 'member-rejoined-within-grace-period') this.log('Member rejoined within grace period');
          if (data.event === 'owner-persisted') this.log('Owner persisted');
          if (data.event === 'owner-restored') this.log('Owner restored');
          if (data.event === 'owner-reconnected') this.log('Owner reconnected');
          if (data.event === 'owner-offline-but-retained') this.log('Owner offline but retained');
          if (data.event === 'legacy-owner-fallback-used') this.log('Legacy owner fallback used');
          if (data.event === 'unexpected-owner-mismatch-prevented') this.log('Unexpected owner mismatch prevented');
          if (data.event === 'oversized-message-rejected') this.log('Oversized signaling message rejected', 'error');
          if (data.event === 'unknown-message-type-ignored') this.log('Unknown worker message type ignored');
          if (data.event === 'rate-limit-applied') this.log('Worker rate limit applied');
          if (data.event === 'moderation-applied') this.log(`Worker moderation applied: ${String(data.action || '')}`);
          if (data.event === 'moderation-denied') {
            this.log(`Worker moderation denied: ${String(data.action || '')}`, 'error');
            this.callbacks.onError('ownerOnly');
          }
          if (data.event === 'peer-kicked' && data.peerId) {
            if (typeof data.ownerId === 'string') this.callbacks.onOwner(data.ownerId === this.peerId, data.ownerId);
            if (data.roles && typeof data.roles === 'object') this.updateRoles(data.roles as Record<string, RoomRole>);
            if (data.peerId === this.peerId) {
              this.closedByUser = true;
              this.callbacks.onKicked();
              try { this.ws?.close(); } catch { /* ignore */ }
            } else {
              this.removePeer(data.peerId);
            }
          }
          if (data.event === 'kick-denied') this.callbacks.onError('ownerOnly');
          if (data.event === 'banned') { this.closedByUser = true; this.callbacks.onKicked(); try { this.ws?.close(); } catch { /* ignore */ } }
          if (data.event === 'bans-list' && Array.isArray(data.bans)) this.callbacks.onBans(data.bans as BannedMember[]);
          return;
        }
        if (!this.isSignalMessage(data)) {
          this.log('Ignored unknown signaling message.', 'info');
          return;
        }
        await this.handleSignal(data as SignalMessage);
      } catch (error) {
        const detail = String((error as Error)?.message || error || 'unknown');
        this.log(`Ignored stale or invalid signaling message: ${detail}`, 'info');
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws || generation !== this.socketGeneration) return;
      this.stopSignalingHeartbeat();
      this.ws = undefined;
      this.log(this.closedByUser ? 'Signaling closed by user' : 'Signaling closed unexpectedly', this.closedByUser ? 'info' : 'error');
      if (this.closedByUser) return;
      this.roomReady = false;
      this.voiceCompanionRegistered = false;
      this.voiceCompanionReady = false;
      this.resolveVoiceReady(false);
      this.disableScreenSystemAudio('Room signaling disconnected; system audio was disabled to prevent call echo.').catch(() => undefined);
      this.callbacks.onState('reconnecting', 'state_reconnecting');
      this.scheduleSignalingReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws || generation !== this.socketGeneration || this.closedByUser) return;
      this.log('Signaling WebSocket error', 'error');
      this.callbacks.onError('error_signaling');
    };
  }

  private startSignalingHeartbeat(ws: WebSocket, generation: number) {
    this.stopSignalingHeartbeat();
    this.signalingHeartbeatTimer = window.setInterval(() => {
      if (this.closedByUser || this.ws !== ws || generation !== this.socketGeneration) {
        this.stopSignalingHeartbeat();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const silenceMs = Date.now() - this.lastSignalingActivityAt;
      if (silenceMs >= SIGNALING_STALE_AFTER_MS) {
        this.log(`Signaling heartbeat timed out after ${silenceMs}ms; reconnecting.`, 'error');
        try { ws.close(4000, 'heartbeat-timeout'); } catch { /* reconnect from onclose */ }
        return;
      }
      try { ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); } catch { /* onclose repairs */ }
    }, SIGNALING_HEARTBEAT_INTERVAL_MS);
  }

  private stopSignalingHeartbeat() {
    if (this.signalingHeartbeatTimer) window.clearInterval(this.signalingHeartbeatTimer);
    this.signalingHeartbeatTimer = undefined;
  }

  private scheduleSignalingReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(SIGNALING_RECONNECT_MAX_MS, 900 * (2 ** Math.min(this.reconnectAttempt, 4)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openWebSocket();
    }, delay);
  }

  private isSignalMessage(data: unknown): data is SignalMessage {
    if (!data || typeof data !== 'object') return false;
    const type = (data as { type?: unknown }).type;
    return typeof type === 'string' && [
      'hello', 'profile', 'description', 'candidate', 'media', 'kick', 'unban', 'join-approve', 'join-reject', 'promote', 'companion-register', 'companion-revoke',
      'admin-mute-all', 'admin-unmute-all', 'admin-mute-peer', 'admin-unmute-peer', 'admin-mute-state'
    ].includes(type);
  }

  private async handleSignal(message: SignalMessage) {
    const from = message.from || (message as SignalMessage & { peerId?: string }).peerId;
    if (!from || from === this.peerId) return;
    if ('to' in message && message.to && message.to !== this.peerId) return;

    if (message.type === 'hello') {
      const peer = this.ensurePeer(from);
      peer.profile = message.profile;
      this.callbacks.onProfileAssetsStale?.();
      this.emitPeers();
      this.sendSignal({ type: 'profile', from: this.peerId, to: from, profile: this.publicProfile() });
      this.ensureLocalDataChannels(peer);
      if (this.shouldCreateOffer(from)) await this.negotiate(peer);
      return;
    }

    if (message.type === 'profile') {
      const peer = this.ensurePeer(from);
      peer.profile = message.profile;
      this.callbacks.onProfileAssetsStale?.();
      this.emitPeers();
      this.ensureLocalDataChannels(peer);
      if (this.shouldCreateOffer(from)) await this.negotiate(peer);
      return;
    }

    if (message.type === 'admin-mute-all') {
      if (!this.isAuthorizedModerator(from, true)) {
        this.log(`Ignored unauthorized Mute All from ${from}`, 'error');
        return;
      }
      this.callbacks.onAdminMuteAll?.(from);
      this.log(`Server-authorized Mute All received from ${from}`);
      return;
    }

    if (message.type === 'admin-unmute-all') {
      if (!this.isAuthorizedModerator(from, true)) {
        this.log(`Ignored unauthorized Unmute All from ${from}`, 'error');
        return;
      }
      this.callbacks.onAdminUnmuteAll?.(from);
      this.log(`Server-authorized Unmute All received from ${from}`);
      return;
    }

    if (message.type === 'admin-mute-peer') {
      if (!this.isAuthorizedModerator(from)) {
        this.log(`Ignored unauthorized member mute from ${from}`, 'error');
        return;
      }
      if (message.to === this.peerId) this.callbacks.onAdminPeerMuteState?.(this.peerId, true, from);
      this.log(`Server-authorized member mute received from ${from} for ${message.to}`);
      return;
    }

    if (message.type === 'admin-unmute-peer') {
      if (!this.isAuthorizedModerator(from)) {
        this.log(`Ignored unauthorized member unmute from ${from}`, 'error');
        return;
      }
      if (message.to === this.peerId) this.callbacks.onAdminPeerMuteState?.(this.peerId, false, from);
      this.log(`Server-authorized member unmute received from ${from} for ${message.to}`);
      return;
    }

    if (message.type === 'admin-mute-state') {
      if (!this.isAuthorizedModerator(from)) {
        this.log(`Ignored unauthorized public mute state from ${from}`, 'error');
        return;
      }
      this.callbacks.onAdminPeerMuteState?.(message.targetPeerId, Boolean(message.muted), from);
      return;
    }

    if (message.type === 'kick') {
      if (message.to === this.peerId) {
        this.closedByUser = true;
        this.callbacks.onKicked();
        this.close();
      }
      return;
    }

    if (message.type === 'media') {
      const peer = this.ensurePeer(from);
      if (message.screenSharing === false) {
        this.log(`Remote screen stopped by ${from}`);
        this.clearRemoteScreen(peer);
      } else if (message.screenSharing === true) {
        const incomingStreamId = message.screenStreamId || '';
        const streamChanged = Boolean(incomingStreamId && incomingStreamId !== peer.screenStreamId);
        const currentVideoLive = peer.screenStream.getVideoTracks().some((track) => track.readyState === 'live');
        if (streamChanged || !currentVideoLive) {
          peer.screenStreamId = incomingStreamId || peer.screenStreamId;
          this.resetRemoteScreenStream(peer, 'remote-screen-started');
        } else if (incomingStreamId) {
          peer.screenStreamId = incomingStreamId;
        }
        this.log(`Remote screen started by ${from}${incomingStreamId ? ` stream=${incomingStreamId}` : ''}`);
      }
      if (message.cameraSharing === false) {
        this.log(`Remote camera stopped by ${from}`);
        this.clearRemoteCamera(peer);
      } else if (message.cameraSharing === true) {
        const incomingCameraId = message.cameraStreamId || '';
        const cameraChanged = Boolean(incomingCameraId && incomingCameraId !== peer.cameraStreamId);
        const currentCameraLive = peer.cameraStream.getVideoTracks().some((track) => track.readyState === 'live');
        if (cameraChanged || !currentCameraLive) {
          peer.cameraStreamId = incomingCameraId || peer.cameraStreamId;
          this.resetRemoteCameraStream(peer, 'remote-camera-started');
        } else if (incomingCameraId) {
          peer.cameraStreamId = incomingCameraId;
        }
        this.log(`Remote camera started by ${from}${incomingCameraId ? ` stream=${incomingCameraId}` : ''}`);
      }
      this.callbacks.onMedia(from, { screenSharing: message.screenSharing, micEnabled: message.micEnabled, cameraSharing: message.cameraSharing });
      return;
    }

    if (message.type === 'description') {
      await this.enqueuePeerSignal(from, (peer) => this.applyRemoteDescription(peer, message.description));
      return;
    }

    if (message.type === 'candidate') {
      const candidate = message.candidate;
      await this.enqueuePeerSignal(from, async (peer) => {
        if (!candidate) {
          if (peer.pc.remoteDescription) {
            try { await peer.pc.addIceCandidate(null); } catch { /* end-of-candidates is optional */ }
          }
          return;
        }

        const key = candidateKey(candidate);
        if (peer.candidateKeys.has(key)) return;
        peer.candidateKeys.add(key);

        if (!peer.pc.remoteDescription) {
          peer.pendingCandidates.push(candidate);
          this.log(`Early ICE candidate queued: ${from}`);
          return;
        }

        try { await peer.pc.addIceCandidate(candidate); } catch (error) { if (!peer.ignoreOffer) this.log(`Ignored stale ICE candidate from ${from}: ${String((error as Error)?.message || error || 'unknown')}`, 'info'); }
      });
    }
  }

  private enqueuePeerSignal(peerId: string, operation: (peer: PeerRuntime) => Promise<void>): Promise<void> {
    const previous = this.peerSignalChains.get(peerId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.closedByUser) return;
        const peer = this.peers.get(peerId);
        if (peer) await operation(peer);
      });
    this.peerSignalChains.set(peerId, next);
    void next.then(
      () => { if (this.peerSignalChains.get(peerId) === next) this.peerSignalChains.delete(peerId); },
      () => { if (this.peerSignalChains.get(peerId) === next) this.peerSignalChains.delete(peerId); }
    );
    return next;
  }

  private async applyRemoteDescription(peer: PeerRuntime, description: RTCSessionDescriptionInit): Promise<void> {
    const offerCollision = description.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    if (offerCollision && peer.polite) {
      try { await peer.pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit); } catch { /* implicit rollback may already be supported */ }
    }
    try {
      await peer.pc.setRemoteDescription(description);
    } catch (error) {
      if (description.type !== 'offer' || !isMLineOrderMismatch(error) || this.peers.get(peer.peerId) !== peer) {
        this.log(`Ignored stale WebRTC description from ${peer.peerId}: ${String((error as Error)?.message || error || 'unknown')}`, 'info');
        return;
      }
      peer = this.recreatePeerForRemoteOffer(peer);
      await peer.pc.setRemoteDescription(description);
      this.log(`Rebuilt peer transport immediately after remote SDP lineage changed: ${peer.peerId}`);
    }
    await this.flushPendingCandidates(peer);
    this.scheduleConnectingWatchdog(peer);
    if (description.type === 'offer') {
      await peer.pc.setLocalDescription();
      this.sendSignal({ type: 'description', from: this.peerId, to: peer.peerId, description: peer.pc.localDescription! });
    }
    this.scheduleQueuedNegotiation(peer, `remote-${description.type}-stable`);
  }

  private async flushPendingCandidates(peer: PeerRuntime) {
    if (!peer.pc.remoteDescription || !peer.pendingCandidates.length) return;
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
        this.log(`Queued ICE candidate applied: ${peer.peerId}`);
      }
      catch (error) { if (!peer.ignoreOffer) this.log(`Ignored queued stale ICE candidate from ${peer.peerId}: ${String((error as Error)?.message || error || 'unknown')}`, 'info'); }
    }
  }


  private resetRemoteScreenStream(peer: PeerRuntime, reason: string) {
    this.clearAllRemoteScreenRecoveries(peer);
    try { peer.screenStream.getTracks().forEach((track) => peer.screenStream.removeTrack(track)); } catch { /* ignore */ }
    peer.screenStream = new MediaStream();
    this.log(`Remote screen stream reset for ${peer.peerId}: ${reason}`);
    this.callbacks.onRemoteStream(peer.peerId, 'screen', peer.screenStream);
  }

  private clearRemoteScreen(peer: PeerRuntime) {
    this.clearAllRemoteScreenRecoveries(peer);
    try { peer.screenStream.getTracks().forEach((track) => peer.screenStream.removeTrack(track)); } catch { /* ignore */ }
    peer.screenStream = new MediaStream();
    peer.screenStreamId = undefined;
    this.callbacks.onRemoteStream(peer.peerId, 'screen', peer.screenStream);
  }



  private resetRemoteCameraStream(peer: PeerRuntime, reason: string) {
    try { peer.cameraStream.getTracks().forEach((track) => peer.cameraStream.removeTrack(track)); } catch { /* ignore */ }
    peer.cameraStream = new MediaStream();
    this.log(`Remote camera stream reset for ${peer.peerId}: ${reason}`);
    this.callbacks.onRemoteStream(peer.peerId, 'camera', peer.cameraStream);
  }

  private clearRemoteCamera(peer: PeerRuntime) {
    try { peer.cameraStream.getTracks().forEach((track) => peer.cameraStream.removeTrack(track)); } catch { /* ignore */ }
    peer.cameraStream = new MediaStream();
    peer.cameraStreamId = undefined;
    this.callbacks.onRemoteStream(peer.peerId, 'camera', peer.cameraStream);
  }

  private isPeerConnected(peer: PeerRuntime): boolean {
    return peer.pc.connectionState === 'connected'
      || peer.pc.iceConnectionState === 'connected'
      || peer.pc.iceConnectionState === 'completed';
  }

  private markPeerConnected(peer: PeerRuntime) {
    peer.repairAttempts = 0;
    this.ensureLocalDataChannels(peer);
    if (peer.connectingTimer) {
      window.clearTimeout(peer.connectingTimer);
      peer.connectingTimer = undefined;
    }
    if (peer.restartTimer) {
      window.clearTimeout(peer.restartTimer);
      peer.restartTimer = undefined;
    }
    if (peer.handshakeTimer) {
      window.clearTimeout(peer.handshakeTimer);
      peer.handshakeTimer = undefined;
    }
  }

  private sendHelloToPeer(peerId: string) {
    this.sendSignal({ type: 'hello', from: this.peerId, to: peerId, profile: this.publicProfile() });
    this.sendSignal({ type: 'profile', from: this.peerId, to: peerId, profile: this.publicProfile() });
  }

  private scheduleHandshakePulse(peer: PeerRuntime, delay = HANDSHAKE_RETRY_MS) {
    if (peer.handshakeTimer || peer.pc.signalingState === 'closed' || this.isPeerConnected(peer)) return;
    peer.handshakeTimer = window.setTimeout(() => {
      peer.handshakeTimer = undefined;
      if (peer.pc.signalingState === 'closed' || this.isPeerConnected(peer)) return;
      peer.repairAttempts = Math.max(peer.repairAttempts, 0);
      const attempts = peer.handshakeAttempts;
      peer.handshakeAttempts = attempts + 1;
      this.sendHelloToPeer(peer.peerId);
      if (this.shouldCreateOffer(peer.peerId)) this.negotiate(peer).catch(() => undefined);
      if (!this.isPeerConnected(peer) && attempts + 1 < MAX_HANDSHAKE_RETRIES) this.scheduleHandshakePulse(peer, HANDSHAKE_RETRY_MS);
    }, delay);
  }

  private scheduleConnectingWatchdog(peer: PeerRuntime, delay = CONNECTING_WATCHDOG_MS) {
    if (peer.connectingTimer || peer.pc.signalingState === 'closed' || this.isPeerConnected(peer)) return;
    peer.connectingTimer = window.setTimeout(() => {
      peer.connectingTimer = undefined;
      if (peer.pc.signalingState === 'closed' || this.isPeerConnected(peer)) return;
      this.schedulePeerRepair(peer, 0);
    }, delay);
  }

  private scheduleQueuedNegotiation(peer: PeerRuntime, reason: string, delay = 0) {
    if (!peer.negotiationQueued || peer.negotiationTimer || peer.pc.signalingState === 'closed') return;
    if (peer.makingOffer || peer.pc.signalingState !== 'stable') return;
    peer.negotiationTimer = window.setTimeout(() => {
      peer.negotiationTimer = undefined;
      this.negotiate(peer).catch((error) => {
        this.log(`Queued negotiation failed for ${peer.peerId} (${reason}): ${String((error as Error)?.message || error || 'unknown')}`, 'error');
      });
    }, delay);
  }

  private negotiate(peer: PeerRuntime): Promise<void> {
    return this.enqueuePeerSignal(peer.peerId, (current) => this.negotiateNow(current));
  }

  private async negotiateNow(peer: PeerRuntime) {
    if (peer.pc.signalingState === 'closed') return;
    if (peer.makingOffer || peer.pc.signalingState !== 'stable') {
      peer.negotiationQueued = true;
      return;
    }
    try {
      peer.makingOffer = true;
      peer.negotiationQueued = false;
      await peer.pc.setLocalDescription();
      this.setPeerConnectionStatus(peer, 'connecting', `Peer connecting: ${peer.peerId}`);
      if (peer.pc.localDescription) this.sendSignal({ type: 'description', from: this.peerId, to: peer.peerId, description: peer.pc.localDescription });
    } catch {
      this.callbacks.onError('error_prepare_connection');
    } finally {
      peer.makingOffer = false;
      this.scheduleQueuedNegotiation(peer, 'post-local-description');
    }
  }

  private schedulePeerRepair(peer: PeerRuntime, delay = 1200) {
    if (peer.restartTimer || peer.pc.signalingState === 'closed' || this.isPeerConnected(peer)) return;
    peer.restartTimer = window.setTimeout(async () => {
      peer.restartTimer = undefined;
      if (peer.pc.signalingState === 'closed' || this.isPeerConnected(peer)) return;
      try {
        peer.repairAttempts += 1;
        peer.reconnectCount += 1;
        peer.iceRestartCount += 1;
        this.setPeerConnectionStatus(peer, 'reconnecting', `Peer reconnecting: ${peer.peerId}`);
        this.log(`ICE restart started: ${peer.peerId} attempt=${peer.repairAttempts}`);
        this.sendHelloToPeer(peer.peerId);
        if (peer.repairAttempts >= HARD_RESET_AFTER_REPAIRS && peer.hardResetCount < MAX_HARD_RESETS) {
          this.log(`Escalating to peer-only hard reset for ${peer.peerId}`);
          await this.rebuildPeerOnly(peer.peerId);
          return;
        }
        peer.pc.restartIce();
        await this.negotiate(peer);
        this.log(`ICE restart requested: ${peer.peerId}`);
        this.scheduleConnectingWatchdog(peer, peer.repairAttempts >= 2 ? 3000 : CONNECTING_WATCHDOG_MS);
      } catch {
        this.log(`ICE restart failed: ${peer.peerId}`, 'error');
        this.callbacks.onError('error_repair_connection');
      }
    }, delay);
  }

  private async rebuildPeerOnly(peerId: string) {
    const oldPeer = this.peers.get(peerId);
    if (!oldPeer || this.isPeerConnected(oldPeer)) return;
    this.log(`Peer-only hard reset after failed reconnects: ${peerId}`);
    const oldProfile = oldPeer.profile;
    const nextReconnectCount = oldPeer.reconnectCount + 1;
    const nextIceRestartCount = oldPeer.iceRestartCount;
    const nextHardResetCount = oldPeer.hardResetCount + 1;
    this.disposePeer(oldPeer);
    this.peers.delete(peerId);

    const peer = this.createPeer(peerId);
    peer.profile = oldProfile;
    peer.reconnectCount = nextReconnectCount;
    peer.iceRestartCount = nextIceRestartCount;
    peer.hardResetCount = nextHardResetCount;
    this.emitPeers();
    this.sendHelloToPeer(peerId);
    this.scheduleHandshakePulse(peer, 300);
    if (this.shouldCreateOffer(peerId)) await this.negotiate(peer);
  }

  private recreatePeerForRemoteOffer(oldPeer: PeerRuntime): PeerRuntime {
    const peerId = oldPeer.peerId;
    const oldProfile = oldPeer.profile;
    const screenStreamId = oldPeer.screenStreamId;
    const cameraStreamId = oldPeer.cameraStreamId;
    const pendingCandidates = oldPeer.pendingCandidates.splice(0);
    const reconnectCount = oldPeer.reconnectCount + 1;
    const iceRestartCount = oldPeer.iceRestartCount;
    const hardResetCount = oldPeer.hardResetCount;

    this.pendingRtcSignals = this.pendingRtcSignals.filter((message) => !('to' in message) || message.to !== peerId);
    this.disposePeer(oldPeer);
    this.peers.delete(peerId);

    const peer = this.createPeer(peerId);
    peer.profile = oldProfile;
    peer.screenStreamId = screenStreamId;
    peer.cameraStreamId = cameraStreamId;
    peer.pendingCandidates.push(...pendingCandidates);
    peer.reconnectCount = reconnectCount;
    peer.iceRestartCount = iceRestartCount;
    peer.hardResetCount = hardResetCount;
    this.setPeerConnectionStatus(peer, 'reconnecting', `Peer transport rebuilding: ${peerId}`);
    if (screenStreamId) this.callbacks.onRemoteStream(peerId, 'screen', peer.screenStream);
    if (cameraStreamId) this.callbacks.onRemoteStream(peerId, 'camera', peer.cameraStream);
    this.emitPeers();
    return peer;
  }

  private disposePeer(peer: PeerRuntime) {
    if (peer.disposing) return;
    peer.disposing = true;
    if (peer.restartTimer) window.clearTimeout(peer.restartTimer);
    if (peer.connectingTimer) window.clearTimeout(peer.connectingTimer);
    if (peer.handshakeTimer) window.clearTimeout(peer.handshakeTimer);
    if (peer.negotiationTimer) window.clearTimeout(peer.negotiationTimer);
    this.clearAllRemoteScreenRecoveries(peer);
    if (peer.dc) {
      peer.dc.onopen = null;
      peer.dc.onclose = null;
      peer.dc.onerror = null;
      peer.dc.onmessage = null;
      try { peer.dc.close(); } catch { /* ignore */ }
      peer.dc = undefined;
    }
    if (peer.fileDc) {
      peer.fileDc.onopen = null;
      peer.fileDc.onclose = null;
      peer.fileDc.onerror = null;
      peer.fileDc.onmessage = null;
      try { peer.fileDc.close(); } catch { /* ignore */ }
      peer.fileDc = undefined;
    }
    for (const transferId of peer.incomingStreamFiles.keys()) {
      invoke('cancel_file_receive', { transferId }).catch(() => undefined);
    }
    peer.incomingStreamFiles.clear();
    peer.incomingFiles.clear();
    pcCleanup(peer.pc);
    try { peer.pc.close(); } catch { /* ignore */ }
    try { peer.screenStream.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
    try { peer.cameraStream.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
  }

  private ensureLocalDataChannels(peer: PeerRuntime): boolean {
    if (peer.disposing || peer.pc.signalingState === 'closed' || !this.shouldCreateOffer(peer.peerId)) return false;
    let changed = false;
    if (!peer.dc || peer.dc.readyState === 'closed') {
      this.setupDataChannel(peer, peer.pc.createDataChannel(`mhlko-${peer.peerId}`, { ordered: true }));
      changed = true;
    }
    if (!peer.fileDc || peer.fileDc.readyState === 'closed') {
      this.setupFileDataChannel(peer, peer.pc.createDataChannel(`mhlko-file-${peer.peerId}`, { ordered: true }));
      changed = true;
    }
    if (changed) {
      peer.negotiationQueued = true;
      this.scheduleQueuedNegotiation(peer, 'data-channel-recreate', 50);
    }
    return changed;
  }

  private setupDataChannel(peer: PeerRuntime, channel: RTCDataChannel) {
    const previous = peer.dc;
    if (previous && previous !== channel) {
      previous.onopen = null;
      previous.onclose = null;
      previous.onerror = null;
      previous.onmessage = null;
      try { previous.close(); } catch { /* ignore */ }
    }
    peer.dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (peer.disposing || peer.dc !== channel) return;
      this.markPeerConnected(peer);
      this.setPeerConnectionStatus(peer, 'connected', `Data channel connected: ${peer.peerId}`);
      this.refreshRoomState();
      this.flushDataQueue(peer);
    };
    channel.onbufferedamountlow = () => {
      if (peer.disposing || peer.dc !== channel) return;
      this.flushDataQueue(peer);
    };
    channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFERED_LOW_WATER;
    channel.onclose = () => {
      if (peer.disposing || peer.dc !== channel) return;
      peer.dc = undefined;
      this.setPeerConnectionStatus(peer, 'reconnecting', `Data channel closed: ${peer.peerId}`);
      this.refreshRoomState();
      this.sendHelloToPeer(peer.peerId);
      this.ensureLocalDataChannels(peer);
      this.schedulePeerRepair(peer, 300);
    };
    channel.onerror = () => {
      if (peer.disposing || peer.dc !== channel) return;
      this.log(`Data channel error: ${peer.peerId}`, 'error');
      this.callbacks.onError('error_data_channel');
      this.sendHelloToPeer(peer.peerId);
      this.schedulePeerRepair(peer, 300);
    };
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      if (event.data.length > MAX_DATA_PACKET_CHARS) {
        this.log(`Oversized data packet rejected from ${peer.peerId}`, 'error');
        this.callbacks.onError('error_bad_chat');
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).type !== 'string') {
          throw new Error('invalid-data-packet');
        }
        this.handleDataPacket(peer, parsed as DataPacket).catch(() => this.callbacks.onError('error_bad_chat'));
      } catch {
        this.callbacks.onError('error_bad_chat');
      }
    };
  }



  private setupFileDataChannel(peer: PeerRuntime, channel: RTCDataChannel) {
    const previous = peer.fileDc;
    if (previous && previous !== channel) {
      previous.onopen = null;
      previous.onclose = null;
      previous.onerror = null;
      previous.onmessage = null;
      try { previous.close(); } catch { /* ignore */ }
    }
    peer.fileDc = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = FILE_BUFFERED_LOW_WATER;
    channel.onopen = () => {
      if (!peer.disposing && peer.fileDc === channel) this.log(`Reliable file channel open: ${peer.peerId}`);
    };
    channel.onclose = () => {
      if (peer.disposing || peer.fileDc !== channel) return;
      peer.fileDc = undefined;
      this.log(`Reliable file channel closed: ${peer.peerId}`);
      this.sendHelloToPeer(peer.peerId);
      this.ensureLocalDataChannels(peer);
      this.schedulePeerRepair(peer, 300);
    };
    channel.onerror = () => {
      if (peer.disposing || peer.fileDc !== channel) return;
      this.log(`Reliable file channel error: ${peer.peerId}`, 'error');
      this.sendHelloToPeer(peer.peerId);
      this.schedulePeerRepair(peer, 300);
    };
    channel.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      this.handleFileBinaryChunk(peer, event.data).catch((error) => {
        this.log(`File chunk receive failed: ${String((error as Error)?.message || error || 'unknown')}`, 'error');
      });
    };
  }

  private async handleDataPacket(peer: PeerRuntime, data: DataPacket) {
    data = { ...data, from: peer.peerId } as DataPacket;
    if ('to' in data && data.to && data.to !== this.peerId) return;

    if (data.type === 'admin-mute-all') {
      if (!this.isAuthorizedModerator(peer.peerId, true)) {
        this.log(`Ignored unauthorized legacy Mute All from ${peer.peerId}`, 'error');
        return;
      }
      this.callbacks.onAdminMuteAll?.(peer.peerId);
      this.log('Legacy owner Mute All accepted');
      return;
    }

    if (data.type === 'admin-unmute-all') {
      if (!this.isAuthorizedModerator(peer.peerId, true)) {
        this.log(`Ignored unauthorized legacy Unmute All from ${peer.peerId}`, 'error');
        return;
      }
      this.callbacks.onAdminUnmuteAll?.(peer.peerId);
      this.log('Legacy owner Unmute All accepted');
      return;
    }

    if (data.type === 'admin-mute-peer') {
      if (!this.isAuthorizedModerator(peer.peerId)) {
        this.log(`Ignored unauthorized legacy member mute from ${peer.peerId}`, 'error');
        return;
      }
      if (data.to === this.peerId) this.callbacks.onAdminPeerMuteState?.(this.peerId, true, peer.peerId);
      this.log(`Legacy authorized member mute accepted for ${data.to}`);
      return;
    }

    if (data.type === 'admin-unmute-peer') {
      if (!this.isAuthorizedModerator(peer.peerId)) {
        this.log(`Ignored unauthorized legacy member unmute from ${peer.peerId}`, 'error');
        return;
      }
      if (data.to === this.peerId) this.callbacks.onAdminPeerMuteState?.(this.peerId, false, peer.peerId);
      this.log(`Legacy authorized member unmute accepted for ${data.to}`);
      return;
    }

    if (data.type === 'admin-mute-state') {
      if (!this.isAuthorizedModerator(peer.peerId)) {
        this.log(`Ignored unauthorized legacy public mute state from ${peer.peerId}`, 'error');
        return;
      }
      this.callbacks.onAdminPeerMuteState?.(data.targetPeerId, Boolean(data.muted), peer.peerId);
      this.log(`Legacy public admin mute state ${data.targetPeerId}: ${data.muted ? 'muted' : 'unmuted'}`);
      return;
    }

    if (data.type === 'request-to-speak') {
      this.callbacks.onRequestToSpeak?.({ peerId: data.from || peer.peerId, displayName: data.senderName || 'Member', requestedAt: Number(data.requestedAt || Date.now()) });
      this.log('Member requested to speak');
      return;
    }

    if (data.type === 'allow-speak') {
      this.callbacks.onSpeakPermission?.(true, data.from || peer.peerId);
      this.log('Forced mute cleared for member');
      return;
    }

    if (data.type === 'reject-speak') {
      this.callbacks.onSpeakPermission?.(false, data.from || peer.peerId);
      this.log('Admin rejected speak request');
      return;
    }

    if (data.type === 'voice-quality-profile') {
      this.log(`Remote voice profile ${data.profile}: ${data.from || peer.peerId}`);
      return;
    }

    if (data.type === 'stream-refresh-request') {
      this.refreshScreenForPeer(peer).then((ok) => {
        this.sendData(peer, { type: 'stream-refresh-response', from: this.peerId, ok, at: Date.now() });
      }).catch(() => {
        this.sendData(peer, { type: 'stream-refresh-response', from: this.peerId, ok: false, at: Date.now() });
        this.callbacks.onError('error_stream_refresh');
      });
      return;
    }

    if (data.type === 'stream-refresh-response') {
      // Force the viewer UI to rebind the current screen stream after the broadcaster renegotiates.
      this.callbacks.onRemoteStream(peer.peerId, 'screen', peer.screenStream);
      if (!data.ok) this.callbacks.onError('error_stream_refresh');
      return;
    }

    if (data.type === 'chat') {
      const incomingId = data.id || crypto.randomUUID();
      const fromPeer = data.from || peer.peerId;
      this.callbacks.onMessage({
        id: incomingId,
        roomId: this.roomId,
        sender: 'peer',
        senderName: data.senderName || 'Friend',
        body: data.body || '',
        createdAt: data.createdAt || Date.now(),
        kind: 'text',
        peerId: fromPeer,
        privateFrom: data.private ? fromPeer : undefined,
        privateTo: data.private ? this.peerId : undefined,
        replyToId: data.replyToId,
        replyToBody: data.replyToBody,
        replyToSender: data.replyToSender
      });
      this.sendData(peer, { type: 'receipt', id: incomingId, from: this.peerId, to: fromPeer, status: 'delivered', at: Date.now() });
      return;
    }

    if (data.type === 'edit') {
      this.callbacks.onMessageEdit(data.id, data.body, data.editedAt || Date.now(), data.from || peer.peerId);
      return;
    }

    if (data.type === 'delete') {
      this.callbacks.onMessageDelete(data.id, data.deletedAt || Date.now(), data.from || peer.peerId);
      return;
    }

    if (data.type === 'receipt') {
      this.callbacks.onMessageReceipt(data.id, data.from || peer.peerId, data.status, data.at || Date.now());
      return;
    }

    if (data.type === 'typing') {
      this.callbacks.onTyping(data.from || peer.peerId, data.senderName || peer.profile?.displayName || 'Friend', Boolean(data.active));
      return;
    }



    if (data.type === 'file-stream-start') {
      const transferId = typeof data.transferId === 'string' ? data.transferId : '';
      const fileSize = Number(data.fileSize);
      const totalChunks = Number(data.totalChunks);
      const chunkSize = Number(data.chunkSize);
      const fileName = typeof data.fileName === 'string' ? data.fileName.slice(0, 512) : '';
      const expectedChunks = Math.max(1, Math.ceil(fileSize / FILE_CHUNK_BYTES));
      const valid = /^[a-zA-Z0-9_-]{1,96}$/.test(transferId)
        && fileName.length > 0
        && Number.isSafeInteger(fileSize) && fileSize >= 0 && fileSize <= MAX_ATTACHMENT_BYTES
        && chunkSize === FILE_CHUNK_BYTES
        && Number.isSafeInteger(totalChunks) && totalChunks === expectedChunks
        && peer.incomingStreamFiles.size < MAX_CONCURRENT_INCOMING_FILES
        && !peer.incomingStreamFiles.has(transferId);
      if (!valid) {
        this.log(`Invalid file stream offer rejected from ${peer.peerId}`, 'error');
        this.sendData(peer, { type: 'file-stream-error', id: String(data.id || ''), transferId, from: this.peerId, reason: 'invalid-file-offer' });
        return;
      }
      const fromPeer = peer.peerId;
      const pending: IncomingStreamFile = {
        id: String(data.id || '').slice(0, 160),
        transferId,
        from: fromPeer,
        to: data.to,
        senderName: String(data.senderName || 'Friend').slice(0, 80),
        fileName,
        safeFileName: safeFileName(fileName),
        fileSize,
        mimeType: String(data.mimeType || 'application/octet-stream').slice(0, 160),
        kind: data.kind || kindFromMime(data.mimeType || ''),
        chunkSize,
        totalChunks,
        createdAt: Number(data.createdAt || Date.now()),
        private: data.private,
        replyToId: data.replyToId,
        replyToBody: data.replyToBody,
        replyToSender: data.replyToSender,
        waveform: Array.isArray(data.waveform) ? data.waveform.map(Number).filter(Number.isFinite).slice(0, 80) : undefined,
        receivedBytes: 0,
        receivedChunks: new Set<number>()
      };
      try {
        pending.localPath = await invoke<string>('begin_file_receive', {
          transferId: pending.transferId,
          fileName: pending.safeFileName,
          size: pending.fileSize,
          mimeType: pending.mimeType,
          roomId: this.roomId
        });
        peer.incomingStreamFiles.set(pending.transferId, pending);
        this.callbacks.onMessage({
          id: pending.id,
          roomId: this.roomId,
          sender: 'peer',
          senderName: pending.senderName,
          body: pending.fileName,
          createdAt: pending.createdAt,
          kind: pending.kind,
          fileName: pending.fileName,
          mimeType: pending.mimeType,
          fileSize: pending.fileSize,
          fileStatus: 'receiving',
          transferredBytes: 0,
          uploadProgress: 0,
          transferId: pending.transferId,
          peerId: pending.from,
          privateFrom: pending.private ? pending.from : undefined,
          privateTo: pending.private ? this.peerId : undefined,
          replyToId: pending.replyToId,
          replyToBody: pending.replyToBody,
          replyToSender: pending.replyToSender,
          waveform: pending.waveform
        });
        this.log(`File streaming receive started: ${pending.transferId} size=${pending.fileSize}`);
      } catch (error) {
        this.log(`File receive init failed: ${String((error as Error)?.message || error || 'unknown')}`, 'error');
        this.sendData(peer, { type: 'file-stream-error', id: data.id, transferId: data.transferId, from: this.peerId, reason: 'receive-init-failed' });
      }
      return;
    }

    if (data.type === 'file-stream-progress') {
      this.callbacks.onFileProgress?.({ id: data.id, roomId: this.roomId, sender: 'me', senderName: this.profile.display_name || 'Me', body: '', createdAt: Date.now(), kind: 'file', transferId: data.transferId, fileSize: data.fileSize, transferredBytes: data.transferredBytes, uploadProgress: Math.round((data.transferredBytes / Math.max(1, data.fileSize)) * 100), fileStatus: 'sending' });
      return;
    }

    if (data.type === 'file-stream-complete') {
      const pending = peer.incomingStreamFiles.get(data.transferId);
      if (!pending) return;
      if (pending.receivedBytes !== pending.fileSize || pending.receivedChunks.size !== pending.totalChunks) {
        peer.incomingStreamFiles.delete(pending.transferId);
        await invoke('cancel_file_receive', { transferId: pending.transferId }).catch(() => undefined);
        this.sendData(peer, { type: 'file-stream-error', id: pending.id, transferId: pending.transferId, from: this.peerId, reason: 'incomplete-file' });
        this.callbacks.onError('error_incomplete_file');
        return;
      }
      try {
        const localPath = await invoke<string>('complete_file_receive', { transferId: pending.transferId });
        peer.incomingStreamFiles.delete(pending.transferId);
        const completeMessage: ChatMessage = {
          id: pending.id,
          roomId: this.roomId,
          sender: 'peer',
          senderName: pending.senderName || 'Friend',
          body: pending.fileName,
          createdAt: pending.createdAt || Date.now(),
          kind: pending.kind,
          fileName: pending.fileName,
          mimeType: pending.mimeType,
          fileSize: pending.fileSize,
          localPath,
          fileStatus: 'completed',
          transferredBytes: pending.fileSize,
          uploadProgress: 100,
          transferId: pending.transferId,
          peerId: pending.from,
          privateFrom: pending.private ? pending.from : undefined,
          privateTo: pending.private ? this.peerId : undefined,
          replyToId: pending.replyToId,
          replyToBody: pending.replyToBody,
          replyToSender: pending.replyToSender,
          waveform: pending.waveform
        };
        this.callbacks.onFileProgress?.(completeMessage);
        this.sendData(peer, { type: 'receipt', id: pending.id, from: this.peerId, to: pending.from, status: 'delivered', at: Date.now() });
        this.log(`File streaming receive completed: ${pending.transferId}`);
      } catch (error) {
        peer.incomingStreamFiles.delete(pending.transferId);
        await invoke('cancel_file_receive', { transferId: pending.transferId }).catch(() => undefined);
        this.log(`File receive finalize failed: ${String((error as Error)?.message || error || 'unknown')}`, 'error');
        this.callbacks.onFileProgress?.({ id: pending.id, roomId: this.roomId, sender: 'peer', senderName: pending.senderName, body: pending.fileName, createdAt: pending.createdAt, kind: pending.kind, transferId: pending.transferId, fileName: pending.fileName, mimeType: pending.mimeType, fileSize: pending.fileSize, fileStatus: 'failed' });
      }
      return;
    }

    if (data.type === 'file-stream-cancel' || data.type === 'file-stream-error') {
      const pending = peer.incomingStreamFiles.get(data.transferId);
      peer.incomingStreamFiles.delete(data.transferId);
      await invoke('cancel_file_receive', { transferId: data.transferId }).catch(() => undefined);
      if (pending) this.callbacks.onFileProgress?.({ id: pending.id, roomId: this.roomId, sender: 'peer', senderName: pending.senderName, body: pending.fileName, createdAt: pending.createdAt, kind: pending.kind, transferId: pending.transferId, fileName: pending.fileName, mimeType: pending.mimeType, fileSize: pending.fileSize, fileStatus: data.type === 'file-stream-cancel' ? 'canceled' : 'failed' });
      this.log(`File streaming ${data.type === 'file-stream-cancel' ? 'canceled' : 'failed'}: ${data.transferId}`);
      return;
    }

    if (data.type === 'file-start') {
      const total = Number(data.total);
      const id = typeof data.id === 'string' ? data.id.slice(0, 160) : '';
      if (!id || id !== data.id || !Number.isSafeInteger(total) || total < 1 || total > MAX_LEGACY_FILE_CHUNKS || peer.incomingFiles.size >= MAX_CONCURRENT_INCOMING_FILES || peer.incomingFiles.has(id)) {
        this.log(`Invalid legacy file offer rejected from ${peer.peerId}`, 'error');
        return;
      }
      peer.incomingFiles.set(id, {
        id,
        from: peer.peerId,
        to: data.to,
        senderName: String(data.senderName || 'Friend').slice(0, 80),
        fileName: String(data.fileName || 'file').slice(0, 512),
        mimeType: String(data.mimeType || 'application/octet-stream').slice(0, 160),
        kind: data.kind,
        total,
        createdAt: data.createdAt,
        private: data.private,
        replyToId: data.replyToId,
        replyToBody: data.replyToBody,
        replyToSender: data.replyToSender,
        waveform: Array.isArray(data.waveform) ? data.waveform : undefined,
        chunks: new Array(total),
        received: 0,
        receivedChars: 0
      });
      return;
    }

    if (data.type === 'file-chunk') {
      const pending = peer.incomingFiles.get(data.id);
      if (!pending) return;
      if (!Number.isSafeInteger(data.index) || data.index < 0 || data.index >= pending.total || typeof data.data !== 'string' || data.data.length > LEGACY_FILE_CHUNK_SIZE || pending.receivedChars + data.data.length > MAX_FILE_DATAURL_CHARS) {
        peer.incomingFiles.delete(data.id);
        this.log(`Invalid legacy file chunk rejected from ${peer.peerId}`, 'error');
        return;
      }
      if (pending.chunks[data.index] === undefined) {
        pending.chunks[data.index] = data.data;
        pending.received += 1;
        pending.receivedChars += data.data.length;
      }
      return;
    }

    if (data.type === 'file-end') {
      const pending = peer.incomingFiles.get(data.id);
      if (!pending) return;
      if (pending.received < pending.total) {
        this.callbacks.onError('error_incomplete_file');
        return;
      }
      const dataUrl = pending.chunks.join('');
      if (dataUrl.length > MAX_FILE_DATAURL_CHARS || !dataUrl.startsWith('data:')) {
        peer.incomingFiles.delete(data.id);
        this.callbacks.onError('error_bad_chat');
        return;
      }
      this.callbacks.onMessage({
        id: pending.id,
        roomId: this.roomId,
        sender: 'peer',
        senderName: pending.senderName || 'Friend',
        body: pending.fileName,
        createdAt: pending.createdAt || Date.now(),
        kind: pending.kind,
        fileName: pending.fileName,
        mimeType: pending.mimeType,
        dataUrl,
        peerId: pending.from,
        privateFrom: pending.private ? pending.from : undefined,
        privateTo: pending.private ? this.peerId : undefined,
        replyToId: pending.replyToId,
        replyToBody: pending.replyToBody,
        replyToSender: pending.replyToSender,
        waveform: pending.waveform
      });
      this.sendData(peer, { type: 'receipt', id: pending.id, from: this.peerId, to: pending.from, status: 'delivered', at: Date.now() });
      peer.incomingFiles.delete(data.id);
    }
  }



  private async handleFileBinaryChunk(peer: PeerRuntime, raw: ArrayBuffer) {
    const chunk = unpackFileBinaryChunk(raw);
    if (!chunk) return;
    const pending = peer.incomingStreamFiles.get(chunk.transferId);
    if (!pending || pending.receivedChunks.has(chunk.chunkIndex)) return;
    const expectedOffset = chunk.chunkIndex * pending.chunkSize;
    const expectedLength = Math.min(pending.chunkSize, Math.max(0, pending.fileSize - expectedOffset));
    const valid = chunk.chunkIndex === pending.receivedChunks.size
      && chunk.chunkIndex < pending.totalChunks
      && chunk.byteOffset === expectedOffset
      && chunk.byteOffset === pending.receivedBytes
      && chunk.payload.byteLength === expectedLength;
    if (!valid) {
      peer.incomingStreamFiles.delete(chunk.transferId);
      await invoke('cancel_file_receive', { transferId: chunk.transferId }).catch(() => undefined);
      this.sendData(peer, { type: 'file-stream-error', id: pending.id, transferId: chunk.transferId, from: this.peerId, reason: 'invalid-file-chunk' });
      throw new Error('invalid file chunk sequence or size');
    }
    pending.receivedChunks.add(chunk.chunkIndex);
    let written: number;
    try {
      written = await invoke<number>('append_file_chunk', chunk.payload, {
        headers: {
          'x-mhtalk-transfer-id': chunk.transferId,
          'x-mhtalk-chunk-index': String(chunk.chunkIndex)
        }
      });
    } catch (error) {
      peer.incomingStreamFiles.delete(chunk.transferId);
      await invoke('cancel_file_receive', { transferId: chunk.transferId }).catch(() => undefined);
      this.sendData(peer, { type: 'file-stream-error', id: pending.id, transferId: chunk.transferId, from: this.peerId, reason: 'file-write-rejected' });
      throw error;
    }
    pending.receivedBytes = Number(written || pending.receivedBytes + chunk.payload.byteLength);
    const progress = Math.min(99, Math.floor((pending.receivedBytes / Math.max(1, pending.fileSize)) * 100));
    this.callbacks.onFileProgress?.({
      id: pending.id,
      roomId: this.roomId,
      sender: 'peer',
      senderName: pending.senderName,
      body: pending.fileName,
      createdAt: pending.createdAt,
      kind: pending.kind,
      transferId: pending.transferId,
      fileName: pending.fileName,
      mimeType: pending.mimeType,
      fileSize: pending.fileSize,
      transferredBytes: pending.receivedBytes,
      uploadProgress: progress,
      fileStatus: 'receiving'
    });
  }

  private flushDataQueue(peer: PeerRuntime) {
    if (!peer.dc || peer.dc.readyState !== 'open' || !peer.sendQueue.length) return;
    while (peer.sendQueue.length && peer.dc.bufferedAmount <= DATA_CHANNEL_BUFFERED_HIGH_WATER) {
      const packet = peer.sendQueue.shift();
      if (!packet) break;
      try {
        peer.dc.send(JSON.stringify(packet));
      } catch (error) {
        this.log(`Failed flushing queued data for ${peer.peerId}: ${String((error as Error)?.message || error)}`, 'error');
        peer.sendQueue.unshift(packet);
        break;
      }
    }
  }

  private sendData(peer: PeerRuntime, packet: DataPacket): boolean {
    const channel = peer.dc;
    if (!channel || channel.readyState !== 'open') {
      this.log(`Data channel unavailable for ${peer.peerId}; dropped ${packet.type}`, 'error');
      return false;
    }

    if (peer.sendQueue.length) this.flushDataQueue(peer);
    if (channel.bufferedAmount <= DATA_CHANNEL_BUFFERED_HIGH_WATER) {
      try {
        channel.send(JSON.stringify(packet));
        return true;
      } catch (error) {
        this.log(`Failed sending data to ${peer.peerId}: ${String((error as Error)?.message || error)}`, 'error');
        return false;
      }
    }

    if (peer.sendQueue.length >= 128) {
      this.log(`Send queue full for ${peer.peerId}; dropped ${packet.type}`, 'error');
      return false;
    }

    peer.sendQueue.push(packet);
    this.log(`Queued data message for ${peer.peerId} (${peer.sendQueue.length} pending)`);
    return true;
  }

  private updateVoicePressure(level: 'normal' | 'pressure' | 'severe') {
    const now = Date.now();
    if (level !== this.voicePressureLevel || now - this.lastVoicePressureNotifyAt > 5000) {
      this.voicePressureLevel = level;
      this.lastVoicePressureNotifyAt = now;
      this.callbacks.onVoicePressure?.(level);
      if (level !== 'normal') this.log(level === 'severe' ? 'Voice priority severe pressure active' : 'Voice priority pressure active', 'info');
      else this.log('Voice priority pressure cleared', 'info');
    }
  }

  private openPeers(targetPeerId?: string): PeerRuntime[] {
    const peers = [...this.peers.values()].filter((peer) => peer.dc?.readyState === 'open');
    return targetPeerId ? peers.filter((peer) => peer.peerId === targetPeerId) : peers;
  }

  private activePeerCount(): number {
    return Math.max(1, [...this.peers.values()].filter((peer) => this.isPeerConnected(peer)).length);
  }

  private async waitForBuffer(peer: PeerRuntime) {
    if (!peer.dc) return;
    if (peer.dc.bufferedAmount <= FILE_BUFFERED_HIGH_WATER) return;
    await waitForBufferedLow(peer.dc);
  }

  private async waitForFileBudget(peer: PeerRuntime): Promise<void> {
    const channel = peer.fileDc;
    if (!channel) return;
    while (channel.readyState === 'open') {
      const budget = mediaBudgetFor(this.voicePressureLevel, this.currentScreenBitrate, this.currentScreenFps, this.activePeerCount());
      if (channel.bufferedAmount <= budget.fileHighWater) {
        if (budget.fileChunkDelayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, budget.fileChunkDelayMs));
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, this.voicePressureLevel === 'severe' ? 80 : 25));
    }
    throw new Error('file data channel closed');
  }


  sendChat(body: string, targetPeerId?: string, replyTo?: Pick<ChatMessage, 'id' | 'body' | 'senderName'>): ChatMessage | null {
    const clean = body.trim();
    if (!clean) return null;
    const targets = this.openPeers(targetPeerId);
    if (targetPeerId && !targets.length) return null;

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      roomId: this.roomId,
      sender: 'me',
      senderName: this.profile.display_name || 'Me',
      body: clean,
      createdAt: Date.now(),
      kind: 'text',
      privateTo: targetPeerId,
      replyToId: replyTo?.id,
      replyToBody: replyTo?.body,
      replyToSender: replyTo?.senderName,
      deliveryStatus: 'sent',
      deliveredTo: [],
      seenBy: [],
      targetCount: targets.length
    };

    for (const peer of targets) {
      this.sendData(peer, { type: 'chat', id: message.id, from: this.peerId, to: targetPeerId, senderName: message.senderName, body: message.body, createdAt: message.createdAt, private: Boolean(targetPeerId), replyToId: message.replyToId, replyToBody: message.replyToBody, replyToSender: message.replyToSender });
    }
    return message;
  }


  sendExistingMessageToPeer(message: ChatMessage, peerId: string): boolean {
    if (!peerId || message.deletedAt || message.sender === 'system') return false;
    const peer = this.peers.get(peerId);
    if (!peer?.dc || peer.dc.readyState !== 'open') return false;
    const senderName = message.sender === 'me' ? (this.profile.display_name || 'Me') : message.senderName;
    if ((message.kind || 'text') === 'text') {
      return this.sendData(peer, {
        type: 'chat',
        id: message.id,
        from: this.peerId,
        to: peerId,
        senderName,
        body: message.body,
        createdAt: message.createdAt,
        private: false,
        replyToId: message.replyToId,
        replyToBody: message.replyToBody,
        replyToSender: message.replyToSender
      });
    }
    if (!message.dataUrl || !message.fileName || !message.mimeType) return false;
    const chunks = Math.max(1, Math.ceil(message.dataUrl.length / LEGACY_FILE_CHUNK_SIZE));
    const kind = message.kind || kindFromMime(message.mimeType);
    if (!this.sendData(peer, { type: 'file-start', id: message.id, from: this.peerId, to: peerId, senderName, fileName: message.fileName, mimeType: message.mimeType, kind, total: chunks, createdAt: message.createdAt, private: false, replyToId: message.replyToId, replyToBody: message.replyToBody, replyToSender: message.replyToSender, waveform: message.waveform })) return false;
    for (let index = 0; index < chunks; index += 1) {
      const data = message.dataUrl.slice(index * LEGACY_FILE_CHUNK_SIZE, (index + 1) * LEGACY_FILE_CHUNK_SIZE);
      this.sendData(peer, { type: 'file-chunk', id: message.id, index, data });
    }
    this.sendData(peer, { type: 'file-end', id: message.id });
    return true;
  }



  editMessage(messageId: string, body: string, targetPeerId?: string): { id: string; body: string; editedAt: number } | null {
    const clean = body.trim();
    if (!messageId || !clean) return null;
    const targets = this.openPeers(targetPeerId);
    // 0.7.6: editing must still update the local message even when the room is
    // currently empty. Only private edits to a disconnected target are rejected.
    if (targetPeerId && !targets.length) return null;
    const editedAt = Date.now();
    for (const peer of targets) {
      this.sendData(peer, { type: 'edit', id: messageId, from: this.peerId, to: targetPeerId, body: clean, editedAt });
    }
    return { id: messageId, body: clean, editedAt };
  }

  deleteMessage(messageId: string, targetPeerId?: string): { id: string; deletedAt: number } | null {
    if (!messageId) return null;
    const targets = this.openPeers(targetPeerId);
    // 0.7.6: deleting must still update the local message even when no members
    // are connected. Only private deletes to a disconnected target are rejected.
    if (targetPeerId && !targets.length) return null;
    const deletedAt = Date.now();
    for (const peer of targets) {
      this.sendData(peer, { type: 'delete', id: messageId, from: this.peerId, to: targetPeerId, deletedAt });
    }
    return { id: messageId, deletedAt };
  }

  muteAllMembers(): void {
    const at = Date.now();
    this.sendSignal({ type: 'admin-mute-all', from: this.peerId, at });
    for (const peer of this.openPeers()) {
      this.sendData(peer, { type: 'admin-mute-all', from: this.peerId, at });
    }
    this.log('Requested server-authorized Mute All');
  }

  unmuteAllMembers(): void {
    const at = Date.now();
    this.sendSignal({ type: 'admin-unmute-all', from: this.peerId, at });
    for (const peer of this.openPeers()) {
      this.sendData(peer, { type: 'admin-unmute-all', from: this.peerId, at });
    }
    this.log('Requested server-authorized Unmute All');
  }

  mutePeerForRoom(peerId: string): void {
    if (!peerId || peerId === this.peerId) return;
    const at = Date.now();
    this.sendSignal({ type: 'admin-mute-peer', from: this.peerId, to: peerId, at });
    for (const peer of this.openPeers()) {
      if (peer.peerId === peerId) this.sendData(peer, { type: 'admin-mute-peer', from: this.peerId, to: peerId, at });
      this.sendData(peer, { type: 'admin-mute-state', from: this.peerId, targetPeerId: peerId, muted: true, at });
    }
    this.log(`Requested server-authorized member mute: ${peerId}`);
  }

  unmutePeerForRoom(peerId: string): void {
    if (!peerId || peerId === this.peerId) return;
    const at = Date.now();
    this.sendSignal({ type: 'admin-unmute-peer', from: this.peerId, to: peerId, at });
    for (const peer of this.openPeers()) {
      if (peer.peerId === peerId) this.sendData(peer, { type: 'admin-unmute-peer', from: this.peerId, to: peerId, at });
      this.sendData(peer, { type: 'admin-mute-state', from: this.peerId, targetPeerId: peerId, muted: false, at });
    }
    this.log(`Requested server-authorized member unmute: ${peerId}`);
  }

  requestToSpeak(): void {
    for (const peer of this.openPeers()) {
      this.sendData(peer, { type: 'request-to-speak', from: this.peerId, senderName: this.profile.display_name || 'Member', requestedAt: Date.now() });
    }
    this.log('Member requested to speak');
  }

  allowMemberToSpeak(peerId: string): void {
    for (const peer of this.openPeers(peerId)) this.sendData(peer, { type: 'allow-speak', from: this.peerId, to: peerId, at: Date.now() });
    this.log(`Admin allowed member to speak: ${peerId}`);
  }

  rejectSpeakRequest(peerId: string): void {
    for (const peer of this.openPeers(peerId)) this.sendData(peer, { type: 'reject-speak', from: this.peerId, to: peerId, at: Date.now() });
    this.log(`Admin rejected speak request: ${peerId}`);
  }

  sendTyping(active: boolean, targetPeerId?: string): void {
    const targets = this.openPeers(targetPeerId);
    for (const peer of targets) {
      this.sendData(peer, { type: 'typing', from: this.peerId, to: targetPeerId, senderName: this.profile.display_name || 'Me', active });
    }
  }


  sendSeenReceipt(messageId: string, targetPeerId?: string): void {
    if (!messageId) return;
    const targets = this.openPeers(targetPeerId);
    for (const peer of targets) {
      this.sendData(peer, { type: 'receipt', id: messageId, from: this.peerId, to: targetPeerId, status: 'seen', at: Date.now() });
    }
  }

  restartConnection(): void {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.callbacks.onState('reconnecting', 'state_reconnecting');
    this.closedByUser = false;
    this.roomReady = false;
    this.pendingRtcSignals = [];
    this.stopSignalingHeartbeat();
    const oldSocket = this.ws;
    this.ws = undefined;
    this.socketGeneration += 1;
    if (oldSocket) {
      oldSocket.onopen = null;
      oldSocket.onmessage = null;
      oldSocket.onerror = null;
      oldSocket.onclose = null;
      try { oldSocket.close(4000, 'manual-restart'); } catch { /* ignore */ }
    }
    for (const peer of this.peers.values()) this.disposePeer(peer);
    this.peers.clear();
    this.emitPeers();
    window.setTimeout(() => this.openWebSocket(), 450);
  }

  restartRemoteStream(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer || peer.pc.signalingState === 'closed') return;

    this.log(`Viewer requested stream restart for ${peerId}`);

    // 1) Local-only refresh: re-emit the same MediaStream so the UI can rebind the video element.
    this.callbacks.onRemoteStream(peer.peerId, 'screen', peer.screenStream);

    // 2) Stream-path repair only: ICE restart and renegotiation on this peer connection.
    // This does not close the room WebSocket, does not clear messages, and does not ask for admin approval again.
    try { peer.pc.restartIce(); } catch { /* optional */ }
    this.negotiate(peer).catch(() => this.callbacks.onError('error_stream_refresh'));

    // 3) Ask the broadcaster to refresh/re-send only the screen tracks to this viewer.
    this.sendData(peer, { type: 'stream-refresh-request', from: this.peerId, at: Date.now() });
  }

  private async refreshScreenForPeer(peer: PeerRuntime): Promise<boolean> {
    const stream = this.screenStream;
    const videoTrack = stream?.getVideoTracks().find((track) => track.readyState === 'live');
    if (!stream || !videoTrack) return false;
    this.log(`Refreshing local screen sender for viewer ${peer.peerId}`);
    let needsNegotiation = false;
    if (peer.screenVideoSender) {
      try {
        await peer.screenVideoSender.replaceTrack(videoTrack);
        await this.applyVideoBitrate(peer.screenVideoSender, this.currentScreenBitrate, this.currentScreenFps, 'low');
      } catch (error) {
        this.log(`Screen sender replacement failed for ${peer.peerId}: ${String((error as Error)?.message || error)}`, 'error');
        return false;
      }
    } else {
      await this.addScreenToPeer(peer, this.currentScreenBitrate, this.currentScreenFps);
      needsNegotiation = true;
    }

    const audioTrack = stream.getAudioTracks().find((track) => track.readyState === 'live');
    if (audioTrack) {
      const audioSender = peer.screenSenders.find((sender) => sender.track?.kind === 'audio');
      if (audioSender) {
        try {
          await audioSender.replaceTrack(audioTrack);
          await this.applyAudioBitrate(audioSender, 128_000);
        } catch (error) {
          this.log(`Screen audio sender replacement failed for ${peer.peerId}: ${String((error as Error)?.message || error)}`, 'error');
          return false;
        }
      } else if (!peer.screenVideoSender) {
        // addScreenToPeer already attached every live screen track above.
        needsNegotiation = true;
      } else {
        const sender = peer.pc.addTrack(audioTrack, stream);
        peer.screenSenders.push(sender);
        await this.applyAudioBitrate(sender, 128_000);
        needsNegotiation = true;
      }
    }
    if (needsNegotiation) await this.negotiate(peer);
    this.sendSignal({ type: 'media', from: this.peerId, screenSharing: true, screenStreamId: stream.id });
    this.callbacks.onLocalMedia?.({ screenSharing: true });
    return true;
  }

  kickPeer(peerId: string): void {
    if (!peerId) return;
    this.sendSignal({ type: 'kick', from: this.peerId, to: peerId, reason: 'room-admin' });
  }

  approveJoin(peerId: string): void {
    if (!peerId) return;
    this.sendSignal({ type: 'join-approve', from: this.peerId, to: peerId });
  }

  rejectJoin(peerId: string): void {
    if (!peerId) return;
    this.sendSignal({ type: 'join-reject', from: this.peerId, to: peerId });
  }

  promotePeer(peerId: string): void {
    if (!peerId) return;
    this.sendSignal({ type: 'promote', from: this.peerId, to: peerId });
  }

  requestBans(): void {
    this.sendSignal({ type: 'unban', from: this.peerId, to: '__list__' });
  }

  unbanPeer(peerId: string): void {
    if (!peerId) return;
    this.sendSignal({ type: 'unban', from: this.peerId, to: peerId });
  }


  async startCameraShare(deviceId?: string): Promise<MediaStream> {
    await this.stopCameraShare(false);
    this.log('Starting camera share');
    // 0.7.2: use the camera source defaults instead of forcing heavy capture
    // constraints. The program only forwards the selected camera source and keeps
    // microphone voice/network priority above camera and stream video.
    const constraints: MediaStreamConstraints = {
      video: deviceId ? { deviceId: { ideal: deviceId } } : true,
      audio: false
    };
    this.cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    const videoTrack = this.cameraStream.getVideoTracks()[0];
    if (videoTrack) {
      try { videoTrack.contentHint = 'motion'; } catch { /* optional */ }
      videoTrack.onended = () => this.stopCameraShare(true).catch(() => undefined);
    }
    for (const peer of this.peers.values()) {
      await this.addCameraToPeer(peer);
      await this.negotiate(peer);
    }
    this.sendSignal({ type: 'media', from: this.peerId, cameraSharing: true, cameraStreamId: this.cameraStream.id });
    this.callbacks.onLocalMedia?.({ cameraSharing: true });
    return this.cameraStream;
  }

  async stopCameraShare(send = true): Promise<void> {
    if (this.screenCompositor) {
      await this.stopCameraOverlay(send);
      return;
    }
    const hadCamera = Boolean(this.cameraStream);
    for (const peer of this.peers.values()) {
      for (const sender of peer.cameraSenders) {
        try { await sender.replaceTrack(null); } catch { /* optional */ }
        try { peer.pc.removeTrack(sender); } catch { /* ignore */ }
      }
      peer.cameraSenders = [];
      peer.cameraVideoSender = undefined;
      if (hadCamera && peer.pc.signalingState !== 'closed') this.negotiate(peer).catch(() => undefined);
    }
    const stream = this.cameraStream;
    this.cameraStream = undefined;
    stream?.getTracks().forEach((track) => { try { track.onended = null; track.stop(); } catch { /* ignore */ } });
    if (send) this.sendSignal({ type: 'media', from: this.peerId, cameraSharing: false });
    this.callbacks.onLocalMedia?.({ cameraSharing: false });
    if (hadCamera) this.log('Camera share stopped');
  }

  async startCameraOverlay(deviceId: string | undefined, settings: CameraOverlaySettings): Promise<MediaStream> {
    if (!this.screenStream || !this.screenCaptureStream) throw new Error('screen sharing must be active before camera composition');
    await this.stopCameraShare(false);
    this.log('Starting camera-over-screen composition');
    const camera = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { ideal: deviceId } } : true,
      audio: false
    });
    const cameraTrack = camera.getVideoTracks()[0];
    if (!cameraTrack) {
      camera.getTracks().forEach((track) => track.stop());
      throw new Error('camera did not provide a video track');
    }
    try { cameraTrack.contentHint = 'motion'; } catch { /* optional */ }
    cameraTrack.onended = () => this.stopCameraOverlay(true).catch(() => undefined);

    const compositor = await ScreenCameraCompositor.create(
      this.screenCaptureStream,
      camera,
      settings,
      this.currentScreenFps,
      (entry) => this.log(`[compositor:${entry.stage}] ${entry.message}`, entry.stage === 'error' ? 'error' : 'info')
    );
    const compositeTrack = compositor.stream.getVideoTracks()[0];
    if (!compositeTrack) {
      compositor.stop(true);
      throw new Error('camera compositor did not create a video track');
    }
    compositeTrack.onended = () => this.scheduleLocalScreenRecovery('compositor-track-ended');

    try {
      await this.replaceScreenVideoTrack(compositeTrack, 'camera-overlay-enabled');
    } catch (error) {
      compositor.stop(true);
      throw error;
    }
    this.cameraStream = camera;
    this.screenCompositor = compositor;
    // The camera is already inside the screen track; do not send a second camera
    // stream. Viewers and recordings now receive the exact same composition.
    this.sendSignal({ type: 'media', from: this.peerId, cameraSharing: false, screenSharing: true, screenStreamId: this.screenStream.id });
    this.callbacks.onLocalMedia?.({ cameraSharing: true, screenSharing: true });
    return camera;
  }

  updateCameraOverlay(settings: CameraOverlaySettings): void {
    this.screenCompositor?.updateSettings(settings);
  }

  async stopCameraOverlay(send = true): Promise<void> {
    const compositor = this.screenCompositor;
    if (!compositor) return;
    const rawTrack = this.screenCaptureStream?.getVideoTracks().find((track) => track.readyState === 'live');
    this.screenCompositor = undefined;
    if (rawTrack && this.screenStream) {
      try { await this.replaceScreenVideoTrack(rawTrack, 'camera-overlay-disabled'); }
      catch (error) { this.log(`Could not restore raw screen track: ${String((error as Error)?.message || error)}`, 'error'); }
    }
    compositor.stop(false);
    const camera = this.cameraStream;
    this.cameraStream = undefined;
    camera?.getTracks().forEach((track) => {
      try { track.onended = null; track.stop(); } catch { /* ignore */ }
    });
    if (send) this.sendSignal({ type: 'media', from: this.peerId, cameraSharing: false, screenSharing: Boolean(this.screenStream), screenStreamId: this.screenStream?.id });
    this.callbacks.onLocalMedia?.({ cameraSharing: false, screenSharing: Boolean(this.screenStream) });
    this.log('Camera-over-screen composition stopped');
  }

  async sendFile(fileName: string, mimeType: string, source: string | File | Blob, targetPeerId?: string, options?: SendFileOptions): Promise<ChatMessage | null> {
    const targets = this.openPeers(targetPeerId);
    if (targetPeerId && !targets.length) return null;
    const kind: ChatMessageKind = kindFromMime(mimeType);
    const now = options?.createdAt ?? Date.now();
    const id = options?.messageId || crypto.randomUUID();

    if (typeof source === 'string') {
      const dataUrl = source;
      if (dataUrl.length > MAX_FILE_DATAURL_CHARS) {
        this.callbacks.onError('fileTooLarge');
        return null;
      }
      const message: ChatMessage = {
        id,
        roomId: this.roomId,
        sender: 'me',
        senderName: this.profile.display_name || 'Me',
        body: fileName,
        createdAt: now,
        kind,
        fileName,
        mimeType,
        dataUrl,
        privateTo: targetPeerId,
        replyToId: options?.replyTo?.id,
        replyToBody: options?.replyTo?.body,
        replyToSender: options?.replyTo?.senderName,
        waveform: options?.waveform,
        ...(typeof options?.fileSize === 'number' ? {
          fileSize: options.fileSize,
          transferredBytes: 0,
          uploadProgress: 0,
          fileStatus: 'sending' as const
        } : {}),
        deliveryStatus: 'sent', deliveredTo: [], seenBy: [], targetCount: targets.length
      };
      const completedMessage = typeof options?.fileSize === 'number'
        ? { ...message, fileStatus: 'completed' as const, uploadProgress: 100, transferredBytes: options.fileSize }
        : message;
      const chunks = Math.max(1, Math.ceil(dataUrl.length / LEGACY_FILE_CHUNK_SIZE));
      if (!targets.length) {
        options?.onProgress?.(100);
        return { ...completedMessage, deliveryStatus: 'sent', targetCount: 0 };
      }
      for (let peerIndex = 0; peerIndex < targets.length; peerIndex += 1) {
        const peer = targets[peerIndex];
        this.sendData(peer, { type: 'file-start', id: message.id, from: this.peerId, to: targetPeerId, senderName: message.senderName, fileName, mimeType, kind, total: chunks, createdAt: message.createdAt, private: Boolean(targetPeerId), replyToId: message.replyToId, replyToBody: message.replyToBody, replyToSender: message.replyToSender, waveform: message.waveform });
        for (let index = 0; index < chunks; index += 1) {
          await this.waitForBuffer(peer);
          const data = dataUrl.slice(index * LEGACY_FILE_CHUNK_SIZE, (index + 1) * LEGACY_FILE_CHUNK_SIZE);
          this.sendData(peer, { type: 'file-chunk', id: message.id, index, data });
          const completedChunks = (peerIndex * chunks) + index + 1;
          options?.onProgress?.(Math.min(99, Math.round((completedChunks / (chunks * targets.length)) * 100)));
        }
        this.sendData(peer, { type: 'file-end', id: message.id });
      }
      options?.onProgress?.(100);
      return completedMessage;
    }

    const file = source;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      this.callbacks.onError('fileTooLarge');
      return null;
    }
    // Small files/audio voice messages keep legacy inline compatibility and old-message display.
    if (file.size <= INLINE_PREVIEW_MAX_BYTES) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      return this.sendFile(fileName, mimeType, dataUrl, targetPeerId, { ...options, fileSize: file.size });
    }

    const transferId = crypto.randomUUID();
    const safe = safeFileName(fileName);
    const totalChunks = Math.max(1, Math.ceil(file.size / FILE_CHUNK_BYTES));
    const message: ChatMessage = {
      id,
      roomId: this.roomId,
      sender: 'me',
      senderName: this.profile.display_name || 'Me',
      body: fileName,
      createdAt: now,
      kind,
      fileName,
      mimeType,
      fileSize: file.size,
      transferId,
      transferredBytes: 0,
      uploadProgress: 0,
      fileStatus: 'sending',
      privateTo: targetPeerId,
      replyToId: options?.replyTo?.id,
      replyToBody: options?.replyTo?.body,
      replyToSender: options?.replyTo?.senderName,
      waveform: options?.waveform,
      deliveryStatus: 'sent', deliveredTo: [], seenBy: [], targetCount: targets.length
    };

    if (!targets.length) {
      options?.onProgress?.(100);
      return { ...message, fileStatus: 'completed', uploadProgress: 100, transferredBytes: file.size, targetCount: 0 };
    }

    for (let peerIndex = 0; peerIndex < targets.length; peerIndex += 1) {
      const peer = targets[peerIndex];
      if (peer.fileDc?.readyState !== 'open') {
        this.callbacks.onError('fileFailed');
        return null;
      }
      this.sendData(peer, {
        type: 'file-stream-start', id, transferId, roomId: this.roomId, from: this.peerId, to: targetPeerId,
        senderName: message.senderName, fileName, safeFileName: safe, fileSize: file.size, mimeType, kind,
        chunkSize: FILE_CHUNK_BYTES, totalChunks, createdAt: now, private: Boolean(targetPeerId),
        replyToId: message.replyToId, replyToBody: message.replyToBody, replyToSender: message.replyToSender, waveform: message.waveform
      });
      for (let index = 0; index < totalChunks; index += 1) {
        if (options?.isCanceled?.()) {
          this.sendData(peer, { type: 'file-stream-cancel', id, transferId, from: this.peerId, reason: 'sender-canceled' });
          this.log(`File streaming canceled by sender: ${transferId}`);
          return { ...message, fileStatus: 'canceled', uploadProgress: 0 };
        }
        if (peer.fileDc?.readyState !== 'open') throw new Error('file channel closed');
        await this.waitForFileBudget(peer);
        const offset = index * FILE_CHUNK_BYTES;
        const payload = await file.slice(offset, Math.min(file.size, offset + FILE_CHUNK_BYTES)).arrayBuffer();
        peer.fileDc.send(packFileBinaryChunk(transferId, index, offset, payload));
        const transferred = Math.min(file.size, offset + payload.byteLength);
        const completedChunks = (peerIndex * totalChunks) + index + 1;
        const progress = Math.min(99, Math.round((completedChunks / (totalChunks * targets.length)) * 100));
        options?.onProgress?.(progress);
        if (index % 4 === 0 || index + 1 === totalChunks) this.sendData(peer, { type: 'file-stream-progress', id, transferId, from: this.peerId, transferredBytes: transferred, fileSize: file.size });
        const fileBudget = mediaBudgetFor(this.voicePressureLevel, this.currentScreenBitrate, this.currentScreenFps, this.activePeerCount());
        if (fileBudget.fileChunkDelayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, fileBudget.fileChunkDelayMs));
        else await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      this.sendData(peer, { type: 'file-stream-complete', id, transferId, from: this.peerId });
      this.log(`File streaming send completed: ${transferId} size=${file.size}`);
    }
    options?.onProgress?.(100);
    return { ...message, uploadProgress: 100, transferredBytes: file.size, fileStatus: 'completed' };
  }

  async startVoiceMessageRecording(inputDeviceId?: string): Promise<VoiceMessageStartResult> {
    if (this.activeVoiceMessageRecordingId) throw new Error('a voice message is already being recorded');
    if (!(await this.ensureVoiceCompanionProcessForLocalCapture())) throw new Error('MHTalkVoice could not recover for voice-message recording');

    const recordingId = crypto.randomUUID();
    const started = new Promise<VoiceMessageStartResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.voiceMessageStartWaiters.delete(recordingId);
        reject(new Error('MHTalkVoice did not start the voice-message recorder in time'));
      }, 8000);
      this.voiceMessageStartWaiters.set(recordingId, { resolve, reject, timer });
    });

    try {
      await invoke('send_voice_companion_command', {
        command: {
          type: 'START_VOICE_MESSAGE_RECORDING',
          payload: {
            recordingId,
            inputDeviceId: inputDeviceId || this.voiceInputDeviceId || null,
            voiceEnhanceEnabled: this.voiceEnhanceEnabled
          }
        }
      });
      const result = await started;
      this.activeVoiceMessageRecordingId = recordingId;
      return result;
    } catch (error) {
      this.rejectVoiceMessageWaiters(recordingId, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async stopVoiceMessageRecording(recordingId = this.activeVoiceMessageRecordingId): Promise<Blob> {
    if (!recordingId) throw new Error('voice message recorder is not active');
    const completed = new Promise<Blob>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.voiceMessageCompleteWaiters.delete(recordingId);
        reject(new Error('MHTalkVoice did not finalize the voice message in time'));
      }, 20_000);
      this.voiceMessageCompleteWaiters.set(recordingId, { resolve, reject, timer });
    });
    try {
      await invoke('send_voice_companion_command', {
        command: { type: 'STOP_VOICE_MESSAGE_RECORDING', payload: { recordingId } }
      });
      return await completed;
    } catch (error) {
      this.rejectVoiceMessageWaiters(recordingId, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (this.activeVoiceMessageRecordingId === recordingId) this.activeVoiceMessageRecordingId = '';
    }
  }

  async cancelVoiceMessageRecording(recordingId = this.activeVoiceMessageRecordingId): Promise<void> {
    if (!recordingId) return;
    try {
      await invoke('send_voice_companion_command', {
        command: { type: 'CANCEL_VOICE_MESSAGE_RECORDING', payload: { recordingId } }
      });
    } finally {
      this.rejectVoiceMessageWaiters(recordingId, new Error('voice message recording canceled'));
      if (this.activeVoiceMessageRecordingId === recordingId) this.activeVoiceMessageRecordingId = '';
    }
  }

  async startVoice(inputDeviceId?: string, outputDeviceId?: string, _inputDeviceLabel?: string, _outputDeviceLabel?: string, voiceEnhanceEnabled = true): Promise<void> {
    this.voiceDesiredActive = true;
    this.voiceMicEnabled = true;
    if (this.voiceMicRestoreTimer) window.clearTimeout(this.voiceMicRestoreTimer);
    this.voiceMicRestoreTimer = undefined;
    this.voiceInputDeviceId = inputDeviceId || undefined;
    this.voiceOutputDeviceId = outputDeviceId || undefined;
    this.voiceEnhanceEnabled = voiceEnhanceEnabled;
    try {
      await this.sendVoiceCompanionCommand('START_MIC', {
        inputDeviceId: this.voiceInputDeviceId || null,
        outputDeviceId: this.voiceOutputDeviceId || null,
        voiceEnhanceEnabled,
        micEnabled: this.voiceMicEnabled
      });
      this.sendSignal({ type: 'media', from: this.peerId, micEnabled: true });
      this.log('Voice started in the isolated MHTalkVoice WebRTC engine.');
    } catch (error) {
      this.voiceDesiredActive = false;
      this.callbacks.onLocalMedia?.({ micEnabled: false });
      throw error;
    }
  }

  async stopVoice(send = true): Promise<void> {
    this.voiceDesiredActive = false;
    this.voiceMicEnabled = false;
    if (this.voiceMicRestoreTimer) window.clearTimeout(this.voiceMicRestoreTimer);
    this.voiceMicRestoreTimer = undefined;
    try {
      if (this.voiceCompanionReady) await invoke('send_voice_companion_command', { command: { type: 'STOP_MIC', payload: {} } });
    } catch { /* companion may be closing */ }
    this.callbacks.onVoiceActivity?.(this.peerId, false, 0);
    this.callbacks.onLocalMedia?.({ micEnabled: false });
    if (send) this.sendSignal({ type: 'media', from: this.peerId, micEnabled: false });
  }

  setMicEnabled(enabled: boolean) {
    this.voiceMicEnabled = enabled;
    if (!enabled) this.callbacks.onVoiceActivity?.(this.peerId, false, 0);
    this.sendSignal({ type: 'media', from: this.peerId, micEnabled: enabled });

    const apply = async () => {
      if (!this.voiceCompanionReady && !(await this.ensureVoiceCompanionReady())) {
        throw new Error('MHTalkVoice could not recover the microphone state');
      }
      await invoke('send_voice_companion_command', {
        command: { type: 'SET_MIC_ENABLED', payload: { enabled } }
      });
    };
    apply().catch((error) => this.callbacks.onError(String((error as Error)?.message || error)));
  }

  async setVoiceEnhanceEnabled(enabled: boolean): Promise<void> {
    this.voiceEnhanceEnabled = enabled;
    if (!this.voiceCompanionReady) return;
    await invoke('send_voice_companion_command', { command: { type: 'SET_VOICE_ENHANCE', payload: { enabled } } });
  }

  async setVoiceOutputDevice(outputDeviceId?: string): Promise<void> {
    this.voiceOutputDeviceId = outputDeviceId || undefined;
    if (!this.voiceCompanionReady) return;
    await invoke('send_voice_companion_command', { command: { type: 'SET_OUTPUT_DEVICE', payload: { outputDeviceId: this.voiceOutputDeviceId || null } } });
  }

  async setPeerVoiceVolume(peerId: string, volume: number, muted: boolean): Promise<void> {
    if (!peerId) return;
    if (!(await this.ensureVoiceCompanionReady())) return;
    await invoke('send_voice_companion_command', {
      command: { type: 'SET_PEER_VOLUME', payload: { peerId, volume, muted } }
    });
  }

  private serializeScreenAudioLifecycle(operation: () => Promise<void>): Promise<void> {
    const run = this.screenAudioLifecycle.then(operation, operation);
    this.screenAudioLifecycle = run.catch(() => undefined);
    return run;
  }

  private disableScreenSystemAudio(reason: string): Promise<void> {
    return this.serializeScreenAudioLifecycle(() => this.disableScreenSystemAudioInternal(reason));
  }

  private async disableScreenSystemAudioInternal(reason: string): Promise<void> {
    const hadAudio = Boolean(this.screenStream?.getAudioTracks().length || this.nativeAudioTrack);
    await this.stopNativeExcludedSystemAudio();
    for (const track of this.screenStream?.getAudioTracks() || []) {
      try { this.screenStream?.removeTrack(track); } catch { /* ignore */ }
      try { track.stop(); } catch { /* ignore */ }
    }
    for (const peer of this.peers.values()) {
      const audioSenders = peer.screenSenders.filter((sender) => sender.track?.kind === 'audio');
      for (const sender of audioSenders) {
        try { await sender.replaceTrack(null); } catch { /* optional */ }
        try { peer.pc.removeTrack(sender); } catch { /* ignore */ }
      }
      if (audioSenders.length) {
        peer.screenSenders = peer.screenSenders.filter((sender) => !audioSenders.includes(sender));
        if (peer.pc.signalingState !== 'closed') this.negotiate(peer).catch(() => undefined);
      }
    }
    if (hadAudio) {
      this.log(reason, 'error');
      this.callbacks.onError(reason);
    }
  }

  private restoreScreenSystemAudioAfterVoiceRestart(): Promise<void> {
    return this.serializeScreenAudioLifecycle(() => this.restoreScreenSystemAudioAfterVoiceRestartInternal());
  }

  private async restoreScreenSystemAudioAfterVoiceRestartInternal(): Promise<void> {
    if (!this.screenStream || !this.voiceCompanionReady || this.screenStream.getAudioTracks().length) return;
    const track = await this.createNativeExcludedSystemAudioTrack();
    if (!track || !this.screenStream) return;
    this.screenStream.addTrack(track);
    track.enabled = true;
    try { track.contentHint = 'music'; } catch { /* optional */ }
    for (const peer of this.peers.values()) {
      if (peer.pc.signalingState === 'closed') continue;
      const sender = peer.pc.addTrack(track, this.screenStream);
      peer.screenSenders.push(sender);
      await this.applyAudioBitrate(sender, 128_000);
      await this.negotiate(peer);
    }
    this.log('System broadcast audio restored after MHTalkVoice restarted.');
  }

  private scheduleNativeSystemAudioRecovery(reason: string) {
    if (!this.screenStream || this.screenStopping || this.closedByUser || this.nativeAudioRecoveryTimer || this.nativeAudioRecovering) return;
    this.nativeAudioRecoveryAttempts += 1;
    const delay = Math.min(5000, 500 * (2 ** Math.min(3, this.nativeAudioRecoveryAttempts - 1)));
    this.log(`System broadcast audio interrupted; recovery attempt ${this.nativeAudioRecoveryAttempts} scheduled in ${delay}ms: ${reason}`, 'error');
    this.nativeAudioRecoveryTimer = window.setTimeout(() => {
      this.nativeAudioRecoveryTimer = undefined;
      this.recoverNativeSystemAudio(reason).catch((error) => {
        this.log(`System broadcast audio recovery failed: ${String((error as Error)?.message || error)}`, 'error');
        this.scheduleNativeSystemAudioRecovery(String((error as Error)?.message || error));
      });
    }, delay);
  }

  private recoverNativeSystemAudio(reason: string): Promise<void> {
    return this.serializeScreenAudioLifecycle(() => this.recoverNativeSystemAudioInternal(reason));
  }

  private async recoverNativeSystemAudioInternal(reason: string): Promise<void> {
    if (!this.screenStream || this.screenStopping || this.closedByUser || this.nativeAudioRecovering) return;
    this.nativeAudioRecovering = true;
    try {
      if (!this.voiceCompanionReady && !(await this.ensureVoiceCompanionReady())) {
        throw new Error('MHTalkVoice isolation is not ready');
      }

      const stream = this.screenStream;
      const oldTracks = [...stream.getAudioTracks()];
      const replacement = await this.createNativeExcludedSystemAudioTrack();
      if (!replacement || !this.screenStream || this.screenStream !== stream) throw new Error('replacement system-audio track was not created');

      replacement.enabled = true;
      try { replacement.contentHint = 'music'; } catch { /* optional */ }
      for (const oldTrack of oldTracks) {
        try { stream.removeTrack(oldTrack); } catch { /* ignore */ }
      }
      if (!stream.getTracks().some((track) => track.id === replacement.id)) stream.addTrack(replacement);

      for (const peer of this.peers.values()) {
        if (peer.pc.signalingState === 'closed') continue;
        const existing = peer.screenSenders.find((sender) => sender.track?.kind === 'audio' || oldTracks.some((track) => sender.track?.id === track.id));
        if (existing) {
          await existing.replaceTrack(replacement);
          await this.applyAudioBitrate(existing, 128_000);
        } else {
          const sender = peer.pc.addTrack(replacement, stream);
          peer.screenSenders.push(sender);
          await this.applyAudioBitrate(sender, 128_000);
          await this.negotiate(peer);
        }
      }

      oldTracks.forEach((track) => {
        if (track.id !== replacement.id) {
          try { track.stop(); } catch { /* ignore */ }
        }
      });
      this.nativeAudioRecoveryAttempts = 0;
      this.log(`System broadcast audio recovered without restarting the video stream: ${reason}`);
    } finally {
      this.nativeAudioRecovering = false;
    }
  }

  private async createNativeExcludedSystemAudioTrack(): Promise<MediaStreamTrack | undefined> {
    await this.stopNativeExcludedSystemAudio();
    try {
      const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return undefined;

      const context = new AudioContextClass({ sampleRate: 48_000 });
      await context.resume().catch(() => undefined);
      const destination = context.createMediaStreamDestination();

      this.nativeAudioContext = context;
      this.nativeAudioDestination = destination;
      this.nativeAudioNextTime = context.currentTime + 0.08;

      this.nativeAudioUnlisten = await listen<NativeAudioChunk>('mhlko://native-audio-chunk', (event) => {
        this.feedNativeAudioChunk(event.payload);
      });
      this.nativeAudioErrorUnlisten = await listen<string>('mhlko://native-audio-error', (event) => {
        const message = String(event.payload || 'error_native_audio');
        this.scheduleNativeSystemAudioRecovery(message);
      });

      await invoke('start_native_system_audio_excluding_self');
      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error('native audio destination did not create a track');
      this.nativeAudioTrack = track;
      return track;
    } catch (error) {
      await this.stopNativeExcludedSystemAudio();
      this.callbacks.onError('error_native_audio_exclusion_unavailable');
      return undefined;
    }
  }

  private feedNativeAudioChunk(chunk: NativeAudioChunk) {
    const context = this.nativeAudioContext;
    const destination = this.nativeAudioDestination;
    if (!context || !destination || !chunk?.data) return;
    try {
      const binary = atob(chunk.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const samples = new Float32Array(bytes.buffer);
      const channels = Math.max(1, Math.min(2, Number(chunk.channels || 2)));
      const frames = Math.floor(samples.length / channels);
      if (frames <= 0) return;

      const buffer = context.createBuffer(channels, frames, Number(chunk.sample_rate || 48_000));
      for (let channel = 0; channel < channels; channel += 1) {
        const target = buffer.getChannelData(channel);
        for (let frame = 0; frame < frames; frame += 1) target[frame] = samples[frame * channels + channel] || 0;
      }

      if (context.state === 'suspended') context.resume().catch(() => undefined);
      const now = context.currentTime;
      if (!this.nativeAudioNextTime || this.nativeAudioNextTime < now - 0.1 || this.nativeAudioNextTime > now + 1.2) this.nativeAudioNextTime = now + 0.08;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start(this.nativeAudioNextTime);
      this.nativeAudioNextTime += buffer.duration;
    } catch {
      this.callbacks.onError('error_native_audio_chunk');
    }
  }

  private setLocalScreenAudioEnabled(enabled: boolean, reason: string): void {
    const tracks = this.screenStream?.getAudioTracks() || [];
    for (const track of tracks) track.enabled = enabled;
    if (tracks.length) this.log(`Screen audio ${enabled ? 'resumed' : 'paused'} with video lifecycle: ${reason}`);
  }

  private async stopNativeExcludedSystemAudio(): Promise<void> {
    if (this.nativeAudioRecoveryTimer) window.clearTimeout(this.nativeAudioRecoveryTimer);
    this.nativeAudioRecoveryTimer = undefined;
    try { await invoke('stop_native_system_audio_excluding_self'); } catch { /* native layer may not be active */ }
    try { this.nativeAudioUnlisten?.(); } catch { /* ignore */ }
    try { this.nativeAudioErrorUnlisten?.(); } catch { /* ignore */ }
    this.nativeAudioUnlisten = undefined;
    this.nativeAudioErrorUnlisten = undefined;
    try { this.nativeAudioTrack?.stop(); } catch { /* ignore */ }
    this.nativeAudioTrack = undefined;
    try { await this.nativeAudioContext?.close(); } catch { /* ignore */ }
    this.nativeAudioContext = undefined;
    this.nativeAudioDestination = undefined;
    this.nativeAudioNextTime = 0;
  }

  async startScreen(quality: ScreenQuality, fps: ScreenFps): Promise<void> {
    if (quality === 'audio-only') return;
    this.log(`Starting screen share quality=${quality} fps=${fps}`);
    await this.stopScreenInternal(false, 'app-refresh');
    const params = qualityToParams(quality);
    this.currentScreenBitrate = params.bitrate;
    this.currentScreenFps = fps;
    this.localScreenRecoveryAttempts = 0;
    this.nativeAudioRecoveryAttempts = 0;
    this.nativeAudioRecovering = false;

    // Fail closed: broadcast system audio is enabled only after MHTalkVoice is
    // authenticated and its WebView2 playback process can be excluded.
    const voiceIsolationReady = await this.ensureVoiceCompanionReady();
    const nativeAudioTrack = voiceIsolationReady ? await this.createNativeExcludedSystemAudioTrack() : undefined;

    let capture: MediaStream;
    try {
      capture = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: params.width }, height: { ideal: params.height }, frameRate: { ideal: fps, max: fps } },
        audio: false
      });
    } catch (error) {
      await this.stopNativeExcludedSystemAudio();
      throw error;
    }

    const rawVideo = capture.getVideoTracks()[0];
    if (!rawVideo) {
      capture.getTracks().forEach((track) => track.stop());
      await this.stopNativeExcludedSystemAudio();
      throw new Error('display capture returned no video track');
    }

    this.screenCaptureStream = capture;
    // Keep one stable MediaStream identity for viewers and the recorder. Camera
    // composition swaps only the video track, so audio keeps flowing and no
    // destructive add/remove/renegotiation cycle is required.
    this.screenStream = new MediaStream([rawVideo]);
    if (nativeAudioTrack) this.screenStream.addTrack(nativeAudioTrack);
    else this.callbacks.onError('Native excluded system audio unavailable; screen shared without system audio to prevent MHTalk echo.');

    try { rawVideo.contentHint = 'detail'; } catch { /* optional */ }
    try {
      await rawVideo.applyConstraints({ width: { ideal: params.width }, height: { ideal: params.height }, frameRate: { ideal: fps, max: fps } });
    } catch {
      this.log('Stream constraints fallback: display source rejected requested constraints');
    }
    rawVideo.onended = () => this.stopScreenInternal(true, 'external').catch(() => undefined);
    rawVideo.onmute = () => this.scheduleLocalScreenRecovery('raw-track-muted');
    rawVideo.onunmute = () => {
      this.localScreenRecoveryAttempts = 0;
      if (this.localScreenMuteTimer) window.clearTimeout(this.localScreenMuteTimer);
      this.localScreenMuteTimer = undefined;
      this.setLocalScreenAudioEnabled(true, 'video-unmuted');
      this.log('Screen video track recovered');
    };

    this.screenStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
      try { track.contentHint = 'music'; } catch { /* optional */ }
    });
    for (const peer of this.peers.values()) {
      await this.addScreenToPeer(peer, params.bitrate, fps);
      await this.negotiate(peer);
    }
    this.sendSignal({ type: 'media', from: this.peerId, screenSharing: true, screenStreamId: this.screenStream.id });
    this.callbacks.onLocalMedia?.({ screenSharing: true });
    this.log(`Screen share started stream=${this.screenStream.id}`);
    this.startStatsMonitor();
  }

  private scheduleLocalScreenRecovery(reason: string) {
    if (!this.screenStream || !this.screenCaptureStream) return;
    if (this.localScreenMuteTimer) window.clearTimeout(this.localScreenMuteTimer);
    // Never allow the previous "audio-only ghost stream" state. Audio is paused
    // while the video source is muted and resumes atomically with recovered frames.
    this.setLocalScreenAudioEnabled(false, reason);
    this.log(`Screen video interruption detected: ${reason}`, 'error');
    this.localScreenMuteTimer = window.setTimeout(() => {
      this.recoverLocalScreenVideo(reason).catch((error) => {
        this.log(`Screen video recovery failed: ${String((error as Error)?.message || error)}`, 'error');
      });
    }, 1400);
  }

  private async recoverLocalScreenVideo(reason: string): Promise<void> {
    const rawTrack = this.screenCaptureStream?.getVideoTracks()[0];
    if (!rawTrack || rawTrack.readyState !== 'live' || !this.screenStream) {
      // A genuinely ended display-capture source cannot be reacquired without the
      // operating-system picker. Stop video and audio together instead of leaking
      // a stale audio-only broadcast.
      await this.stopScreenInternal(true, 'external');
      this.callbacks.onError('Screen video ended; video and stream audio were stopped together.');
      return;
    }

    this.localScreenRecoveryAttempts += 1;
    const currentTrack = this.screenStream.getVideoTracks()[0];
    if (currentTrack?.readyState === 'live') {
      for (const peer of this.peers.values()) await this.refreshScreenForPeer(peer);
      this.sendSignal({ type: 'media', from: this.peerId, screenSharing: true, screenStreamId: this.screenStream.id });
      this.log(`Screen video recovery attempt ${this.localScreenRecoveryAttempts} completed (${reason})`);
    }

    if (!rawTrack.muted) {
      this.localScreenRecoveryAttempts = 0;
      this.setLocalScreenAudioEnabled(true, 'video-recovered');
      return;
    }

    const delays = [1800, 2600, 3800, 5200, 7000, 9000, 11000, 13000];
    if (this.localScreenRecoveryAttempts < delays.length) {
      const delay = delays[this.localScreenRecoveryAttempts];
      this.localScreenMuteTimer = window.setTimeout(
        () => this.recoverLocalScreenVideo('still-muted').catch(() => undefined),
        delay
      );
      return;
    }

    await this.stopScreenInternal(true, 'external');
    this.callbacks.onError('Windows did not resume screen frames after automatic recovery; video and audio were stopped together. Start sharing again.');
  }

  private async replaceScreenVideoTrack(nextTrack: MediaStreamTrack, reason: string): Promise<void> {
    const stream = this.screenStream;
    if (!stream || nextTrack.kind !== 'video' || nextTrack.readyState !== 'live') throw new Error('replacement screen video is not live');
    const oldTracks = stream.getVideoTracks();
    for (const old of oldTracks) stream.removeTrack(old);
    stream.addTrack(nextTrack);
    try { nextTrack.contentHint = 'detail'; } catch { /* optional */ }
    for (const peer of this.peers.values()) {
      if (peer.screenVideoSender) {
        await peer.screenVideoSender.replaceTrack(nextTrack);
        await this.applyVideoBitrate(peer.screenVideoSender, this.currentScreenBitrate, this.currentScreenFps, 'low');
      } else {
        await this.addScreenToPeer(peer, this.currentScreenBitrate, this.currentScreenFps);
        await this.negotiate(peer);
      }
    }
    this.sendSignal({ type: 'media', from: this.peerId, screenSharing: true, screenStreamId: stream.id });
    this.callbacks.onLocalMedia?.({ screenSharing: true });
    this.log(`Screen video source replaced: ${reason}`);
  }

  async updateScreenQuality(quality: ScreenQuality, fps: ScreenFps): Promise<void> {
    if (!this.screenStream || quality === 'audio-only') return;
    const params = qualityToParams(quality);
    this.currentScreenBitrate = params.bitrate;
    this.currentScreenFps = fps;
    const track = this.screenStream.getVideoTracks()[0];
    try { await track?.applyConstraints({ width: { ideal: params.width }, height: { ideal: params.height }, frameRate: { ideal: fps, max: fps } }); } catch { /* some capture sources reject dynamic constraints */ }
    const budget = mediaBudgetFor(this.voicePressureLevel, params.bitrate, fps, this.activePeerCount());
    for (const peer of this.peers.values()) {
      if (peer.screenVideoSender) {
        await this.applyVideoBitrate(
          peer.screenVideoSender,
          budget.screenBitrate,
          budget.screenFps,
          'low',
          budget.screenScaleDown
        );
      }
    }
  }

  async stopScreen(send = true): Promise<void> {
    await this.stopScreenInternal(send, 'app');
  }

  private async stopScreenInternal(send = true, reason: 'app' | 'external' | 'app-refresh' = 'app'): Promise<void> {
    if (this.screenStopping) return;
    this.screenStopping = true;
    try {
      const hadScreen = Boolean(this.screenStream);
      this.log(reason === 'external' ? 'Screen share stopped externally' : 'Screen share stopped by app');
      for (const peer of this.peers.values()) {
        for (const sender of peer.screenSenders) {
          try { await sender.replaceTrack(null); } catch { /* optional */ }
          try { peer.pc.removeTrack(sender); } catch { /* ignore */ }
        }
        peer.screenSenders = [];
        peer.screenVideoSender = undefined;
        if (hadScreen && peer.pc.signalingState !== 'closed') this.negotiate(peer).catch(() => undefined);
      }
      if (this.localScreenMuteTimer) window.clearTimeout(this.localScreenMuteTimer);
      this.localScreenMuteTimer = undefined;
      this.localScreenRecoveryAttempts = 0;
      const stream = this.screenStream;
      const capture = this.screenCaptureStream;
      const compositor = this.screenCompositor;
      const compositorCamera = compositor ? this.cameraStream : undefined;
      this.screenStream = undefined;
      this.screenCaptureStream = undefined;
      this.screenCompositor = undefined;
      if (compositor) this.cameraStream = undefined;
      try { compositor?.stop(false); } catch { /* ignore */ }
      compositorCamera?.getTracks().forEach((track) => { try { track.onended = null; track.stop(); } catch { /* ignore */ } });
      capture?.getTracks().forEach((track) => {
        try { track.onended = null; track.onmute = null; track.onunmute = null; track.stop(); } catch { /* ignore */ }
      });
      stream?.getVideoTracks().forEach((track) => {
        if (!capture?.getTracks().includes(track)) { try { track.stop(); } catch { /* ignore */ } }
      });
      await this.stopNativeExcludedSystemAudio();
      if (compositor) this.callbacks.onLocalMedia?.({ cameraSharing: false });
      this.currentScreenBitrate = qualityToParams('auto-max').bitrate;
      if (send) this.sendSignal({ type: 'media', from: this.peerId, screenSharing: false });
      this.callbacks.onLocalMedia?.({ screenSharing: false });
      if (hadScreen) this.log(`Screen share cleanup completed: ${reason}`);
    } finally {
      this.screenStopping = false;
    }
  }

  private async addCurrentLocalTracks(peer: PeerRuntime) {
    let needsNegotiation = false;
    if (this.screenStream) { await this.addScreenToPeer(peer, this.currentScreenBitrate, this.currentScreenFps); needsNegotiation = true; }
    if (this.cameraStream && !this.screenCompositor) { await this.addCameraToPeer(peer); needsNegotiation = true; }
    if (needsNegotiation) await this.negotiate(peer);
  }

  private async addScreenToPeer(peer: PeerRuntime, bitrate: number, fps: ScreenFps = this.currentScreenFps) {
    if (!this.screenStream || peer.screenSenders.length) return;
    this.log(`Adding current screen tracks to peer ${peer.peerId}`);
    const budget = mediaBudgetFor(this.voicePressureLevel, bitrate, fps, this.activePeerCount());
    const videoTrack = this.screenStream.getVideoTracks()[0];
    if (videoTrack) {
      peer.screenVideoSender = peer.pc.addTrack(videoTrack, this.screenStream);
      peer.screenSenders.push(peer.screenVideoSender);
      await this.applyVideoBitrate(peer.screenVideoSender, budget.screenBitrate, budget.screenFps, 'low', budget.screenScaleDown);
    }
    for (const audioTrack of this.screenStream.getAudioTracks()) {
      const sender = peer.pc.addTrack(audioTrack, this.screenStream);
      peer.screenSenders.push(sender);
      await this.applyAudioBitrate(sender, 128_000);
    }
  }



  private async addCameraToPeer(peer: PeerRuntime) {
    if (!this.cameraStream || peer.cameraSenders.length) return;
    this.log(`Adding current camera tracks to peer ${peer.peerId}`);
    const budget = mediaBudgetFor(this.voicePressureLevel, this.currentScreenBitrate, this.currentScreenFps, this.activePeerCount());
    const videoTrack = this.cameraStream.getVideoTracks()[0];
    if (videoTrack) {
      peer.cameraVideoSender = peer.pc.addTrack(videoTrack, this.cameraStream);
      peer.cameraSenders.push(peer.cameraVideoSender);
      await this.applyVideoBitrate(peer.cameraVideoSender, budget.cameraBitrate, budget.cameraFps, 'low', budget.cameraScaleDown);
    }
  }

  private clearRemoteScreenRecovery(peer: PeerRuntime, trackId: string): void {
    const recovery = peer.remoteScreenRecoveries.get(trackId);
    if (recovery?.timer) window.clearTimeout(recovery.timer);
    peer.remoteScreenRecoveries.delete(trackId);
  }

  private clearAllRemoteScreenRecoveries(peer: PeerRuntime): void {
    for (const recovery of peer.remoteScreenRecoveries.values()) {
      if (recovery.timer) window.clearTimeout(recovery.timer);
    }
    peer.remoteScreenRecoveries.clear();
  }

  private scheduleRemoteScreenRecovery(peer: PeerRuntime, track: MediaStreamTrack, reason: string): void {
    const current = peer.remoteScreenRecoveries.get(track.id) || { attempts: 0 };
    if (current.timer) window.clearTimeout(current.timer);
    if (track.readyState !== 'live' || !track.muted || peer.pc.signalingState === 'closed') {
      this.clearRemoteScreenRecovery(peer, track.id);
      return;
    }

    const delays = [1400, 2200, 3400, 5000, 7000, 9500];
    const attempt = Math.min(current.attempts, delays.length - 1);
    current.timer = window.setTimeout(() => {
      current.timer = undefined;
      if (track.readyState !== 'live' || !track.muted || peer.pc.signalingState === 'closed') {
        this.clearRemoteScreenRecovery(peer, track.id);
        return;
      }

      current.attempts += 1;
      const now = Date.now();
      if (now - (peer.lastScreenRefreshRequestAt ?? 0) >= 1200) {
        peer.lastScreenRefreshRequestAt = now;
        this.sendData(peer, { type: 'stream-refresh-request', from: this.peerId, at: now });
      }

      // Rebind playback immediately, then repair ICE/SDP every second attempt.
      // Audio and video use independent recovery state so one muted track cannot cancel the other.
      this.callbacks.onRemoteStream(peer.peerId, 'screen', peer.screenStream);
      if (current.attempts % 2 === 0) {
        try { peer.pc.restartIce(); } catch { /* optional */ }
        this.negotiate(peer).catch(() => undefined);
      }
      this.log(`Remote screen ${track.kind} recovery attempt ${current.attempts} for ${peer.peerId} (${reason})`, 'error');

      if (current.attempts >= delays.length) {
        current.attempts = 0;
        this.callbacks.onError('Remote screen media is still paused; MHTalk will keep trying automatically.');
        current.timer = window.setTimeout(
          () => this.scheduleRemoteScreenRecovery(peer, track, 'extended-recovery'),
          12_000
        );
      } else {
        this.scheduleRemoteScreenRecovery(peer, track, `${track.kind}-still-muted`);
      }
    }, delays[attempt]);
    peer.remoteScreenRecoveries.set(track.id, current);
  }

  private handleRemoteTrack(peer: PeerRuntime, event: RTCTrackEvent) {
    const remoteStream = event.streams[0];
    const streamId = remoteStream?.id;
    const streamHasVideo = Boolean(remoteStream?.getVideoTracks().length);
    const isCamera = Boolean(streamId && streamId === peer.cameraStreamId);
    const isScreen = !isCamera && (event.track.kind === 'video' || streamHasVideo || (!!streamId && streamId === peer.screenStreamId));

    if (isCamera) {
      for (const track of peer.cameraStream.getTracks()) {
        if (track.readyState !== 'live' || (event.track.kind === 'video' && track.kind === 'video')) {
          try { peer.cameraStream.removeTrack(track); } catch { /* ignore */ }
        }
      }
    } else if (isScreen) {
      if (streamId && streamId !== peer.screenStreamId) {
        peer.screenStreamId = streamId;
        this.resetRemoteScreenStream(peer, 'incoming-track-new-stream-id');
      }

      // A restarted broadcaster creates new remote tracks. Keep exactly one screen track per
      // media kind; otherwise WebView2/AudioContext can remain bound to an older live-but-muted
      // audio track even after a healthy replacement arrives.
      for (const track of peer.screenStream.getTracks()) {
        if (track.readyState !== 'live' || (track.kind === event.track.kind && track.id !== event.track.id)) {
          this.clearRemoteScreenRecovery(peer, track.id);
          track.onended = null;
          track.onmute = null;
          track.onunmute = null;
          try { peer.screenStream.removeTrack(track); } catch { /* ignore */ }
        }
      }
    }

    if (!isCamera && !isScreen && event.track.kind === 'audio') {
      // A legacy/current-main voice track must never render in MHTalk.exe. Remote call
      // audio is accepted only by the dedicated MHTalkVoice process.
      this.log(`Blocked call-audio track in GUI process from ${peer.peerId}`, 'error');
      try { event.track.stop(); } catch { /* ignore */ }
      return;
    }

    if (!isCamera && !isScreen) {
      this.log(`Blocked unclassified media track in GUI process from ${peer.peerId}: ${event.track.kind}`, 'error');
      try { event.track.stop(); } catch { /* ignore */ }
      return;
    }
    const targetStream = isCamera ? peer.cameraStream : peer.screenStream;
    if (!targetStream.getTracks().some((track) => track.id === event.track.id)) targetStream.addTrack(event.track);
    const emit = () => this.callbacks.onRemoteStream(peer.peerId, isCamera ? 'camera' : 'screen', targetStream);
    event.track.onended = () => {
      this.clearRemoteScreenRecovery(peer, event.track.id);
      if (isScreen) {
        try { targetStream.removeTrack(event.track); } catch { /* ignore */ }
      }
      emit();
    };
    event.track.onmute = () => {
      emit();
      if (!isScreen) return;
      this.clearRemoteScreenRecovery(peer, event.track.id);
      peer.remoteScreenRecoveries.set(event.track.id, { attempts: 0 });
      this.log(`Remote screen ${event.track.kind} muted for ${peer.peerId}; automatic recovery started`, 'error');
      this.scheduleRemoteScreenRecovery(peer, event.track, 'track-muted');
    };
    event.track.onunmute = () => {
      this.clearRemoteScreenRecovery(peer, event.track.id);
      this.log(`Remote screen ${event.track.kind} resumed for ${peer.peerId}`);
      emit();
    };
    this.log(`Remote ${isCamera ? 'camera' : 'screen'} track received from ${peer.peerId}: ${event.track.kind}`);
    emit();
  }

  private async applyVideoBitrate(
    sender: RTCRtpSender,
    maxBitrate: number,
    maxFramerate: number = this.currentScreenFps,
    priority: 'low' | 'medium' = 'medium',
    scaleResolutionDownBy = 1
  ) {
    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = maxFramerate;
    params.encodings[0].scaleResolutionDownBy = Math.max(1, scaleResolutionDownBy);
    const videoEncoding = params.encodings[0] as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string };
    if ('priority' in videoEncoding) videoEncoding.priority = priority;
    if ('networkPriority' in videoEncoding) videoEncoding.networkPriority = priority;
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = this.voicePressureLevel === 'normal' ? 'balanced' : 'maintain-framerate';
    try {
      await sender.setParameters(params);
      if (this.diagnosticsEnabled) this.log(`Video budget applied bitrate=${maxBitrate} fps=${maxFramerate} scale=${scaleResolutionDownBy}`);
    } catch {
      this.log('Stream constraints fallback: sender parameters rejected');
    }
  }

  private async applyAudioBitrate(sender: RTCRtpSender, maxBitrate: number) {
    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    const audioEncoding = params.encodings[0] as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string; dtx?: string };
    if ('priority' in audioEncoding) audioEncoding.priority = 'low';
    if ('networkPriority' in audioEncoding) audioEncoding.networkPriority = 'low';
    if ('dtx' in audioEncoding) audioEncoding.dtx = 'disabled';
    try { await sender.setParameters(params); } catch { /* optional */ }
  }

  private async applyNetworkBudget(level: RtcPressureLevel): Promise<void> {
    const budget = mediaBudgetFor(level, this.currentScreenBitrate, this.currentScreenFps, this.activePeerCount());
    const nextProfile: 'high' | 'balanced' | 'low' = level === 'severe' ? 'low' : level === 'pressure' ? 'balanced' : 'high';
    const profileChanged = nextProfile !== this.voiceProfile;
    this.voiceProfile = nextProfile;
    for (const peer of this.peers.values()) {
      if (peer.screenVideoSender) await this.applyVideoBitrate(peer.screenVideoSender, budget.screenBitrate, budget.screenFps, 'low', budget.screenScaleDown);
      const screenAudioBitrate = level === 'severe' ? 32_000 : level === 'pressure' ? 64_000 : 128_000;
      for (const sender of peer.screenSenders) {
        if (sender.track?.kind === 'audio') await this.applyAudioBitrate(sender, screenAudioBitrate);
      }
      if (peer.cameraVideoSender) await this.applyVideoBitrate(peer.cameraVideoSender, budget.cameraBitrate, budget.cameraFps, 'low', budget.cameraScaleDown);
      if (profileChanged) this.sendData(peer, { type: 'voice-quality-profile', from: this.peerId, profile: nextProfile, at: Date.now() });
    }
    if (profileChanged) this.callbacks.onVoiceProfile?.(nextProfile);
  }

  private pressureRank(level: RtcPressureLevel): number {
    return level === 'severe' ? 2 : level === 'pressure' ? 1 : 0;
  }

  private updatePressureWithHysteresis(sample: RtcPressureLevel) {
    const now = Date.now();
    const current = this.voicePressureLevel as RtcPressureLevel;
    if (sample === current) {
      this.pressureCandidate = sample;
      this.pressureCandidateSince = now;
      this.pressureRecoverySince = 0;
      return;
    }

    const rising = this.pressureRank(sample) > this.pressureRank(current);
    if (rising) {
      if (this.pressureCandidate !== sample) {
        this.pressureCandidate = sample;
        this.pressureCandidateSince = now;
      }
      const requiredMs = sample === 'severe' ? 0 : 2000;
      if (now - this.pressureCandidateSince >= requiredMs) {
        this.updateVoicePressure(sample);
        this.applyNetworkBudget(sample).catch(() => undefined);
        this.pressureCandidateSince = now;
        this.pressureRecoverySince = 0;
      }
      return;
    }

    if (!this.pressureRecoverySince) this.pressureRecoverySince = now;
    const requiredRecoveryMs = current === 'severe' && sample === 'pressure' ? 6000 : 12_000;
    if (now - this.pressureRecoverySince >= requiredRecoveryMs) {
      this.updateVoicePressure(sample);
      this.applyNetworkBudget(sample).catch(() => undefined);
      this.pressureCandidate = sample;
      this.pressureCandidateSince = now;
      this.pressureRecoverySince = 0;
    }
  }

  private startStatsMonitor() {
    this.startRtcStatsMonitor();
  }

  private startRtcStatsMonitor() {
    if (this.rtcStatsTimer) return;
    this.rtcStatsTimer = window.setInterval(() => {
      this.collectRtcStats().catch((error) => {
        if (this.diagnosticsEnabled) this.log(`RTC diagnostics collection failed: ${String((error as Error)?.message || error)}`, 'error');
      });
    }, 2000);
  }

  private async collectRtcStats(): Promise<void> {
    const snapshots: RtcDiagnosticsSnapshot[] = [];
    for (const peer of this.peers.values()) {
      if (peer.pc.signalingState === 'closed') continue;
      try {
        const snapshot = await this.collectPeerRtcStats(peer);
        if (snapshot) snapshots.push(snapshot);
      } catch (error) {
        if (this.diagnosticsEnabled) this.log(`RTC stats failed for ${peer.peerId}: ${String((error as Error)?.message || error)}`, 'error');
      }
    }
    if (!snapshots.length) return;
    const worst = snapshots.reduce<RtcPressureLevel>((value, item) => this.pressureRank(item.pressure) > this.pressureRank(value) ? item.pressure : value, 'normal');
    this.updatePressureWithHysteresis(worst);
    const now = Date.now();
    for (const snapshot of snapshots) {
      this.diagnosticsHistory.push(snapshot);
      if (this.diagnosticsHistory.length > 300) this.diagnosticsHistory.splice(0, this.diagnosticsHistory.length - 300);
      this.callbacks.onRtcDiagnostics?.(snapshot);
      if (this.diagnosticsEnabled && (snapshot.pressure !== 'normal' || now - this.lastDiagnosticsLogAt >= 10_000)) {
        this.log(`[RTC] ${JSON.stringify(snapshot)}`, snapshot.pressure === 'severe' ? 'error' : 'info');
      }
    }
    if (this.diagnosticsEnabled && now - this.lastDiagnosticsLogAt >= 10_000) this.lastDiagnosticsLogAt = now;
  }

  private async collectPeerRtcStats(peer: PeerRuntime): Promise<RtcDiagnosticsSnapshot | undefined> {
    type Stat = RTCStats & Record<string, any>;
    const report = await peer.pc.getStats();
    const values: Stat[] = [];
    report.forEach((item) => values.push(item as Stat));
    const byId = new Map(values.map((item) => [item.id, item]));
    const transport = values.find((item) => item.type === 'transport');
    let pair = transport?.selectedCandidatePairId ? byId.get(String(transport.selectedCandidatePairId)) : undefined;
    if (!pair) pair = values.find((item) => item.type === 'candidate-pair' && (item.selected || (item.nominated && item.state === 'succeeded')));
    const localCandidate = pair?.localCandidateId ? byId.get(String(pair.localCandidateId)) : undefined;
    const remoteCandidate = pair?.remoteCandidateId ? byId.get(String(pair.remoteCandidateId)) : undefined;
    const outboundAudio = values.find((item) => item.type === 'outbound-rtp' && !item.isRemote && (item.kind === 'audio' || item.mediaType === 'audio'));
    const outboundVideo = values.filter((item) => item.type === 'outbound-rtp' && !item.isRemote && (item.kind === 'video' || item.mediaType === 'video'));
    const inboundAudio = values.find((item) => item.type === 'inbound-rtp' && !item.isRemote && (item.kind === 'audio' || item.mediaType === 'audio'));
    const remoteInboundAudio = values.find((item) => item.type === 'remote-inbound-rtp' && (item.kind === 'audio' || item.mediaType === 'audio'));
    const codecReport = byId.get(String(outboundAudio?.codecId || inboundAudio?.codecId || ''));
    const mediaSource = values.find((item) => item.type === 'media-source' && item.kind === 'audio');
    const at = Date.now();
    const current: RtcCounterState = {
      at,
      outboundAudioBytes: Number(outboundAudio?.bytesSent || 0),
      inboundAudioBytes: Number(inboundAudio?.bytesReceived || 0),
      outboundVideoBytes: outboundVideo.reduce((sum, item) => sum + Number(item.bytesSent || 0), 0),
      outboundPackets: Number(outboundAudio?.packetsSent || 0),
      outboundLost: Number(remoteInboundAudio?.packetsLost || 0),
      inboundPackets: Number(inboundAudio?.packetsReceived || 0),
      inboundLost: Number(inboundAudio?.packetsLost || 0),
      outboundTotalSendDelay: Number(outboundAudio?.totalPacketSendDelay || 0),
      jitterBufferDelay: Number(inboundAudio?.jitterBufferDelay || 0),
      jitterBufferTargetDelay: Number(inboundAudio?.jitterBufferTargetDelay || 0),
      jitterBufferEmittedCount: Number(inboundAudio?.jitterBufferEmittedCount || 0)
    };
    const previous = peer.statsPrevious;
    peer.statsPrevious = current;
    const elapsedSeconds = previous ? Math.max(0.001, (at - previous.at) / 1000) : 0;
    const deltaSentBytes = previous ? Math.max(0, current.outboundAudioBytes - previous.outboundAudioBytes) : 0;
    const deltaReceivedBytes = previous ? Math.max(0, current.inboundAudioBytes - previous.inboundAudioBytes) : 0;
    const deltaVideoBytes = previous ? Math.max(0, current.outboundVideoBytes - previous.outboundVideoBytes) : 0;
    const deltaReceivedPackets = previous ? Math.max(0, current.inboundPackets - previous.inboundPackets) : 0;
    const deltaLostPackets = previous ? Math.max(0, current.inboundLost - previous.inboundLost) : 0;
    const deltaSentPackets = previous ? Math.max(0, current.outboundPackets - previous.outboundPackets) : 0;
    const deltaOutgoingLostPackets = previous ? Math.max(0, current.outboundLost - previous.outboundLost) : 0;
    const deltaSendDelay = previous ? Math.max(0, current.outboundTotalSendDelay - previous.outboundTotalSendDelay) : 0;
    const incomingPacketLossPct = previous && deltaReceivedPackets + deltaLostPackets > 0 ? (deltaLostPackets / (deltaReceivedPackets + deltaLostPackets)) * 100 : 0;
    const outgoingPacketLossPct = previous && deltaSentPackets + deltaOutgoingLostPackets > 0
      ? (deltaOutgoingLostPackets / (deltaSentPackets + deltaOutgoingLostPackets)) * 100
      : Number(remoteInboundAudio?.fractionLost || 0) * 100;
    const packetLossPct = Math.max(incomingPacketLossPct, outgoingPacketLossPct);
    const emitted = current.jitterBufferEmittedCount;
    const deltaEmitted = previous ? Math.max(0, current.jitterBufferEmittedCount - previous.jitterBufferEmittedCount) : 0;
    const deltaJitterDelay = previous ? Math.max(0, current.jitterBufferDelay - previous.jitterBufferDelay) : 0;
    const deltaJitterTarget = previous ? Math.max(0, current.jitterBufferTargetDelay - previous.jitterBufferTargetDelay) : 0;
    const jitterBufferMs = deltaEmitted > 0
      ? (deltaJitterDelay / deltaEmitted) * 1000
      : emitted > 0 ? (current.jitterBufferDelay / emitted) * 1000 : undefined;
    const jitterBufferTargetMs = deltaEmitted > 0
      ? (deltaJitterTarget / deltaEmitted) * 1000
      : emitted > 0 ? (current.jitterBufferTargetDelay / emitted) * 1000 : undefined;
    const qualityReasons = [...new Set(outboundVideo.map((item) => String(item.qualityLimitationReason || '')).filter((value) => value && value !== 'none'))];
    const videoQualityLimitationReason = qualityReasons.length ? qualityReasons.join(',') : outboundVideo.length ? 'none' : undefined;
    const videoFramesPerSecond = outboundVideo.reduce((value, item) => Math.max(value, Number(item.framesPerSecond || 0)), 0) || undefined;
    const fileBufferedBytes = [...this.peers.values()].reduce((sum, item) => sum + Number(item.fileDc?.bufferedAmount || 0) + Number(item.dc?.bufferedAmount || 0), 0);
    const rttSeconds = Number(remoteInboundAudio?.roundTripTime ?? pair?.currentRoundTripTime ?? 0);
    const metrics = {
      rttMs: rttSeconds > 0 ? rttSeconds * 1000 : undefined,
      jitterMs: Number(inboundAudio?.jitter || remoteInboundAudio?.jitter || 0) * 1000,
      packetLossPct,
      availableOutgoingKbps: Number(pair?.availableOutgoingBitrate || 0) > 0 ? Number(pair?.availableOutgoingBitrate) / 1000 : undefined,
      totalPacketSendDelayMs: deltaSentPackets > 0 ? (deltaSendDelay / deltaSentPackets) * 1000 : undefined,
      jitterBufferMs,
      eventLoopLagMs: this.eventLoopLagMs,
      fileBufferedBytes
    };
    const pressure = classifyRtcPressure(metrics);
    const localType = String(localCandidate?.candidateType || '');
    const remoteType = String(remoteCandidate?.candidateType || '');
    const direct = localType !== 'relay' && remoteType !== 'relay';
    return {
      at,
      peerId: peer.peerId,
      connectionState: peer.pc.connectionState,
      iceConnectionState: peer.pc.iceConnectionState,
      signalingState: peer.pc.signalingState,
      protocol: String(localCandidate?.protocol || pair?.protocol || '') || undefined,
      relayProtocol: String(localCandidate?.relayProtocol || '') || undefined,
      localCandidateType: localType || undefined,
      remoteCandidateType: remoteType || undefined,
      localAddress: localCandidate ? `${String(localCandidate.address || localCandidate.ip || '')}:${String(localCandidate.port || '')}` : undefined,
      remoteAddress: remoteCandidate ? `${String(remoteCandidate.address || remoteCandidate.ip || '')}:${String(remoteCandidate.port || '')}` : undefined,
      direct,
      mediaTopology: 'p2p',
      signalingHost: (() => { try { return new URL(this.signalingUrl).host; } catch { return undefined; } })(),
      serverRegion: (() => {
        try {
          const env = import.meta.env as Record<string, string | undefined>;
          return (env.VITE_RTC_REGION || 'p2p-no-sfu').trim();
        } catch { return 'p2p-no-sfu'; }
      })(),
      rttMs: metrics.rttMs,
      jitterMs: metrics.jitterMs,
      packetLossPct,
      incomingPacketLossPct,
      outgoingPacketLossPct,
      packetsSent: current.outboundPackets,
      packetsReceived: current.inboundPackets,
      packetsLost: current.inboundLost,
      packetsDiscarded: Number(inboundAudio?.packetsDiscarded || 0) || undefined,
      retransmittedPacketsSent: Number(outboundAudio?.retransmittedPacketsSent || 0) || undefined,
      retransmittedPacketsReceived: Number(inboundAudio?.retransmittedPacketsReceived || 0) || undefined,
      audioSendKbps: elapsedSeconds > 0 ? (deltaSentBytes * 8) / elapsedSeconds / 1000 : undefined,
      audioReceiveKbps: elapsedSeconds > 0 ? (deltaReceivedBytes * 8) / elapsedSeconds / 1000 : undefined,
      videoSendKbps: elapsedSeconds > 0 ? (deltaVideoBytes * 8) / elapsedSeconds / 1000 : undefined,
      videoQualityLimitationReason,
      videoFramesPerSecond,
      availableOutgoingKbps: metrics.availableOutgoingKbps,
      availableIncomingKbps: Number(pair?.availableIncomingBitrate || 0) > 0 ? Number(pair?.availableIncomingBitrate) / 1000 : undefined,
      jitterBufferMs,
      jitterBufferTargetMs,
      jitterBufferEmittedCount: emitted || undefined,
      concealedSamples: Number(inboundAudio?.concealedSamples || 0) || undefined,
      concealmentEvents: Number(inboundAudio?.concealmentEvents || 0) || undefined,
      silentConcealedSamples: Number(inboundAudio?.silentConcealedSamples || 0) || undefined,
      totalSamplesReceived: Number(inboundAudio?.totalSamplesReceived || 0) || undefined,
      interruptionCount: Number(inboundAudio?.interruptionCount || 0) || undefined,
      totalInterruptionDurationMs: Number(inboundAudio?.totalInterruptionDuration || 0) > 0
        ? Number(inboundAudio?.totalInterruptionDuration) * 1000
        : undefined,
      freezeCount: Number(inboundAudio?.freezeCount || 0) || undefined,
      totalFreezesDurationMs: Number(inboundAudio?.totalFreezesDuration || 0) > 0
        ? Number(inboundAudio?.totalFreezesDuration) * 1000
        : undefined,
      insertedSamplesForDeceleration: Number(inboundAudio?.insertedSamplesForDeceleration || 0) || undefined,
      removedSamplesForAcceleration: Number(inboundAudio?.removedSamplesForAcceleration || 0) || undefined,
      localAudioTrackState: undefined,
      remoteAudioTrackState: undefined,
      totalPacketSendDelayMs: metrics.totalPacketSendDelayMs,
      audioLevel: Number(mediaSource?.audioLevel ?? inboundAudio?.audioLevel ?? 0) || undefined,
      codec: String(codecReport?.mimeType || '') || undefined,
      eventLoopLagMs: Math.round(this.eventLoopLagMs),
      fileBufferedBytes,
      screenActive: Boolean(this.screenStream),
      cameraActive: Boolean(this.cameraStream),
      recordingActive: this.recordingActive,
      reconnects: peer.reconnectCount,
      iceRestarts: peer.iceRestartCount,
      pressure
    };
  }

  private sendSignal(message: SignalMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
        return true;
      } catch (error) {
        this.log(`Failed sending signal ${message.type}: ${String((error as Error)?.message || error)}`, 'error');
        return false;
      }
    }

    if (this.queueRtcSignal(message)) {
      this.log(`Signaling temporarily unavailable; queued ${message.type}`, 'info');
    } else if (message.type === 'hello' || message.type === 'profile' || message.type === 'media') {
      if (!this.pendingStateRefresh) this.log('Signaling state refresh deferred until room reconnects');
      this.pendingStateRefresh = true;
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.log(`Signaling socket is still connecting; deferred state refresh for ${message.type}`, 'info');
    } else {
      this.log(`Signaling unavailable; dropped ${message.type}`, 'error');
    }
    return false;
  }

  private queueRtcSignal(message: SignalMessage): boolean {
    if ((message.type !== 'description' && message.type !== 'candidate') || !message.to || !this.peers.has(message.to)) return false;

    if (message.type === 'description') {
      const previousIndex = this.pendingRtcSignals.findIndex((item) => item.type === 'description' && item.to === message.to);
      if (previousIndex >= 0) this.pendingRtcSignals.splice(previousIndex, 1);
    }

    if (this.pendingRtcSignals.length >= MAX_QUEUED_RTC_SIGNALS) {
      const oldestCandidate = this.pendingRtcSignals.findIndex((item) => item.type === 'candidate');
      this.pendingRtcSignals.splice(oldestCandidate >= 0 ? oldestCandidate : 0, 1);
    }
    this.pendingRtcSignals.push(message);
    return true;
  }

  private flushPendingRtcSignals(): void {
    const ws = this.ws;
    if (!this.roomReady || ws?.readyState !== WebSocket.OPEN || !this.pendingRtcSignals.length) return;

    const queued = this.pendingRtcSignals.splice(0);
    let sent = 0;
    for (let index = 0; index < queued.length; index += 1) {
      const message = queued[index];
      if ('to' in message && message.to && !this.peers.has(message.to)) continue;
      try {
        ws.send(JSON.stringify(message));
        sent += 1;
      } catch (error) {
        this.pendingRtcSignals.unshift(...queued.slice(index));
        this.log(`RTC signaling recovery flush paused: ${String((error as Error)?.message || error)}`, 'error');
        break;
      }
    }
    if (sent) this.log(`Recovered ${sent} queued RTC signaling message${sent === 1 ? '' : 's'} after reconnect`);
  }

  private publicProfile(): PeerProfile {
    return {
      peerId: this.peerId,
      displayName: this.profile.display_name || 'Mhlko User',
      avatarVersion: profileAvatarVersion(this.profile.avatar_data_url),
      status: this.profile.status,
      capabilities: { rtpVoice: false, voiceCompanion: true, rtcDiagnosticsVersion: 2 }
    };
  }

  private emitPeers() {
    this.callbacks.onPeers([...this.peers.values()].map((peer) => ({
      ...(peer.profile || { peerId: peer.peerId, displayName: 'Friend', status: 'Online' }),
      peerId: peer.profile?.peerId || peer.peerId,
      connectionStatus: peer.connectionStatus
    })));
  }

  private removePeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.disposePeer(peer);
    this.peers.delete(peerId);
    this.pendingRtcSignals = this.pendingRtcSignals.filter((message) => !('to' in message) || message.to !== peerId);
    this.emitPeers();
    this.callbacks.onPeerLeft(peerId);
  }

  async cleanDisconnect(): Promise<void> {
    await this.stopScreen(false);
    await this.stopCameraShare(false);
    await this.stopVoice(false);
    await this.stopVoiceCompanion();
    this.close();
  }

  close() {
    this.closedByUser = true;
    this.pendingRtcSignals = [];
    this.pendingStateRefresh = false;
    this.peerSignalChains.clear();
    this.callbacks.onProfileAssetAccess?.(null);
    this.detachRecoveryListeners();
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopSignalingHeartbeat();
    if (this.voiceMicRestoreTimer) window.clearTimeout(this.voiceMicRestoreTimer);
    this.voiceMicRestoreTimer = undefined;
    if (this.rtcStatsTimer) window.clearInterval(this.rtcStatsTimer);
    this.rtcStatsTimer = undefined;
    this.stopEventLoopMonitor();
    this.stopVoiceCompanionHealthMonitor();
    this.stopVoice(false);
    this.stopScreen(false);
    this.stopCameraShare(false);
    this.stopNativeExcludedSystemAudio().catch(() => undefined);
    this.stopVoiceCompanion().catch(() => undefined);
    try { this.voiceCompanionUnlisten?.(); } catch { /* ignore */ }
    this.voiceCompanionUnlisten = undefined;
    for (const peer of this.peers.values()) this.disposePeer(peer);
    this.peers.clear();
    const oldSocket = this.ws;
    this.ws = undefined;
    this.socketGeneration += 1;
    if (oldSocket) {
      oldSocket.onopen = null;
      oldSocket.onmessage = null;
      oldSocket.onerror = null;
      oldSocket.onclose = null;
      try { oldSocket.close(1000, 'room-closed'); } catch { /* ignore */ }
    }
  }
}


function createVoiceCompanionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function getStableClientId(): string {
  const key = 'mhlko.stableClientId';
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.localStorage.setItem(key, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

function candidateKey(candidate: RTCIceCandidateInit): string {
  return [candidate.sdpMid || '', candidate.sdpMLineIndex ?? '', candidate.usernameFragment || '', candidate.candidate || ''].join('|');
}

function qualityToParams(quality: ScreenQuality): { width: number; height: number; bitrate: number } {
  const screenWidth = Math.max(window.screen.width, window.screen.height);
  const screenHeight = Math.min(window.screen.width, window.screen.height);
  // Real-time safe caps: the previous 16-80 Mbps defaults could saturate normal home upload
  // and force voice/data to wait. These values still preserve screen detail while leaving headroom.
  if (quality === 'auto-max') return { width: screenWidth, height: screenHeight, bitrate: screenWidth >= 3000 ? 14_000_000 : screenWidth >= 2200 ? 9_000_000 : screenWidth >= 1600 ? 5_500_000 : 2_800_000 };
  switch (quality) {
    case '4k': return { width: 3840, height: 2160, bitrate: 14_000_000 };
    case '1440p': return { width: 2560, height: 1440, bitrate: 9_000_000 };
    case '1080p': return { width: 1920, height: 1080, bitrate: 5_500_000 };
    case '720p': return { width: 1280, height: 720, bitrate: 2_800_000 };
    case '480p': return { width: 854, height: 480, bitrate: 1_200_000 };
    case '360p': return { width: 640, height: 360, bitrate: 700_000 };
    default: return { width: 854, height: 480, bitrate: 1_200_000 };
  }
}

export async function listMediaDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
  try { await navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((stream) => stream.getTracks().forEach((t) => t.stop())); }
  catch { /* Permission can be requested later. */ }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((device) => device.kind === 'audioinput'),
    outputs: devices.filter((device) => device.kind === 'audiooutput'),
    cameras: devices.filter((device) => device.kind === 'videoinput')
  };
}

export async function setAudioOutput(element: HTMLMediaElement | null, sinkId: string): Promise<void> {
  const media = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (media?.setSinkId && sinkId) await media.setSinkId(sinkId);
}

export function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  code += '-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `MHLKO-${code}`;
}

export function normalizeRoomId(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

export function applyLowMode(settings: AppSettings): AppSettings {
  if (!settings.lowInternetMode && !settings.lowPcMode) return settings;
  return {
    ...settings,
    screenQuality: settings.lowInternetMode ? '480p' : settings.screenQuality,
    screenFps: settings.lowPcMode ? 8 : 15
  };
}
