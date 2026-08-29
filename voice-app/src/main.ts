import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type BootstrapConfig = {
  roomId: string;
  signalingUrl: string;
  parentPeerId: string;
  voiceToken: string;
  displayName: string;
  iceServers?: RTCIceServer[];
};

type EngineCommand = { type: string; payload?: Record<string, unknown> };
type VoicePeerInfo = { peerId: string; parentPeerId: string; displayName?: string };
type VolumeState = { volume: number; muted: boolean };

type VoiceRuntime = {
  voicePeerId: string;
  parentPeerId: string;
  pc: RTCPeerConnection;
  transceiver: RTCRtpTransceiver;
  sender: RTCRtpSender;
  stream: MediaStream;
  audio: HTMLAudioElement;
  remoteTrack?: MediaStreamTrack;
  boostContext?: AudioContext;
  boostSource?: MediaStreamAudioSourceNode;
  boostGain?: GainNode;
  makingOffer: boolean;
  ignoreOffer: boolean;
  polite: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  candidateKeys: Set<string>;
  connected: boolean;
  playbackRecoveryPromise?: Promise<boolean>;
  playbackRecoveryTimer?: number;
  disconnectRecoveryTimer?: number;
  remoteMuteRecoveryTimer?: number;
  lastPlaybackAttemptAt: number;
  playbackFailureCount: number;
  lastAudioCurrentTime: number;
  lastAudioProgressAt: number;
  audioProgressObserved: boolean;
  lastInboundBytes: number;
  lastInboundProgressAt: number;
  remoteTrackAttachedAt: number;
};

type SignalMessage =
  | { type: 'voice-hello'; from: string; to?: string; parentPeerId: string; displayName: string }
  | { type: 'description'; from: string; to: string; description: RTCSessionDescriptionInit }
  | { type: 'candidate'; from: string; to: string; candidate: RTCIceCandidateInit | null }
  | { type: 'voice-media'; from: string; to?: string; parentPeerId: string; micEnabled: boolean };

const BASE_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

const VOICE_SIGNALING_HEARTBEAT_INTERVAL_MS = 15_000;
const VOICE_SIGNALING_STALE_AFTER_MS = 45_000;

async function notifyMain(payload: Record<string, unknown>): Promise<void> {
  try { await invoke('voice_notify_main', { payload }); } catch { /* parent may already be closing */ }
}

function safeText(error: unknown): string {
  return String((error as Error)?.message || error || 'unknown error');
}

function isMLineOrderMismatch(error: unknown): boolean {
  const message = safeText(error).toLowerCase();
  return message.includes('order of m-lines') && message.includes('subsequent offer');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
  }
  return btoa(binary);
}

function pickVoiceMessageMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus'
  ];
  return candidates.find((candidate) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate));
}

type InteractionKind = 'microphone' | 'playback';
let pendingInteraction: { kind: InteractionKind; micPayload?: Record<string, unknown> } | undefined;

async function showInteraction(kind: InteractionKind, message: string, micPayload?: Record<string, unknown>) {
  pendingInteraction = { kind, micPayload };
  const panel = document.getElementById('permission-panel');
  const title = document.getElementById('permission-title');
  const body = document.getElementById('permission-message');
  const retry = document.getElementById('permission-retry');
  if (title) title.textContent = kind === 'microphone' ? 'Microphone permission' : 'Enable call audio';
  if (body) body.textContent = message;
  if (retry) retry.textContent = kind === 'microphone' ? 'Allow microphone' : 'Enable audio';
  if (panel) panel.hidden = false;
  await invoke('voice_show_interaction_window').catch(() => undefined);
  await notifyMain({ type: 'USER_ACTION_REQUIRED', action: kind, message });
}

async function hideInteraction() {
  pendingInteraction = undefined;
  const panel = document.getElementById('permission-panel');
  if (panel) panel.hidden = true;
  await invoke('voice_hide_interaction_window').catch(() => undefined);
}

class VoiceCompanionRoom {
  private readonly config: BootstrapConfig;
  private readonly peerId = `voice-${crypto.randomUUID()}`;
  private ws?: WebSocket;
  private peers = new Map<string, VoiceRuntime>();
  private peerSignalChains = new Map<string, Promise<void>>();
  private localStream?: MediaStream;
  private inputDeviceId?: string;
  private outputDeviceId?: string;
  private enhance = true;
  private desiredMicActive = false;
  private desiredMicEnabled = true;
  private micEnabled = false;
  private closed = false;
  private reconnectTimer?: number;
  private signalingHeartbeatTimer?: number;
  private lastSignalingActivityAt = 0;
  private statsTimer?: number;
  private heartbeatTimer?: number;
  private micRecoveryTimer?: number;
  private micSourceMuteRecoveryTimer?: number;
  private micStartPromise?: Promise<void>;
  private socketGeneration = 0;
  private micMonitorContext?: AudioContext;
  private micMonitorSource?: MediaStreamAudioSourceNode;
  private micMonitorAnalyser?: AnalyserNode;
  private micMonitorData?: Uint8Array;
  private volumes = new Map<string, VolumeState>();
  private lastSpeaking = new Map<string, boolean>();
  private deviceListenerAttached = false;
  private voiceMessageRecorder?: MediaRecorder;
  private voiceMessageRecordingId?: string;
  private voiceMessageSourceTrack?: MediaStreamTrack;
  private voiceMessageTemporaryStream?: MediaStream;
  private voiceMessageChunks: Blob[] = [];
  private voiceMessageMaxTimer?: number;
  private readonly deviceChangeHandler = () => {
    this.handleAudioDeviceChange().catch((error) => notifyMain({ type: 'VOICE_LOG', message: `Audio device refresh failed: ${safeText(error)}` }));
  };

  constructor(config: BootstrapConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.closed = false;
    if (!this.deviceListenerAttached) {
      navigator.mediaDevices?.addEventListener?.('devicechange', this.deviceChangeHandler);
      this.deviceListenerAttached = true;
    }
    this.openSocket();
    this.startStats();
    this.startHeartbeat();
  }

  private openSocket() {
    if (this.closed) return;
    const base = this.config.signalingUrl.replace(/\/$/, '');
    const url = `${base}/room/${encodeURIComponent(this.config.roomId)}/ws?peerId=${encodeURIComponent(this.peerId)}&kind=voice&parentPeerId=${encodeURIComponent(this.config.parentPeerId)}&voiceToken=${encodeURIComponent(this.config.voiceToken)}&name=${encodeURIComponent(this.config.displayName || 'MHTalk User')}`;
    const ws = new WebSocket(url);
    const socketGeneration = ++this.socketGeneration;
    this.ws = ws;

    ws.onopen = () => {
      if (this.closed || this.ws !== ws || socketGeneration !== this.socketGeneration) return;
      this.lastSignalingActivityAt = Date.now();
      this.startSignalingHeartbeat(ws, socketGeneration);
      notifyMain({ type: 'VOICE_LOG', message: 'MHTalkVoice signaling connected' });
    };

    ws.onmessage = (event) => {
      if (this.closed || this.ws !== ws || socketGeneration !== this.socketGeneration) return;
      this.lastSignalingActivityAt = Date.now();
      this.handleSocketMessage(String(event.data), socketGeneration).catch((error) => {
        notifyMain({ type: 'VOICE_ERROR', message: `voice signaling message failed: ${safeText(error)}` });
      });
    };

    ws.onerror = () => {
      if (this.closed || this.ws !== ws || socketGeneration !== this.socketGeneration) return;
      notifyMain({ type: 'VOICE_ERROR', message: 'MHTalkVoice signaling socket error' });
    };

    ws.onclose = () => {
      if (this.closed || this.ws !== ws || socketGeneration !== this.socketGeneration) return;
      this.stopSignalingHeartbeat();
      this.ws = undefined;
      notifyMain({ type: 'VOICE_DISCONNECTED', reason: 'signaling-closed' });
      if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.openSocket(), 1200);
    };
  }

  private startSignalingHeartbeat(ws: WebSocket, socketGeneration: number) {
    this.stopSignalingHeartbeat();
    this.signalingHeartbeatTimer = window.setInterval(() => {
      if (this.closed || this.ws !== ws || socketGeneration !== this.socketGeneration) {
        this.stopSignalingHeartbeat();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const silenceMs = Date.now() - this.lastSignalingActivityAt;
      if (silenceMs >= VOICE_SIGNALING_STALE_AFTER_MS) {
        notifyMain({ type: 'VOICE_LOG', message: `MHTalkVoice signaling heartbeat timed out after ${silenceMs}ms; reconnecting.` });
        try { ws.close(4000, 'heartbeat-timeout'); } catch { /* onclose repairs */ }
        return;
      }
      try { ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); } catch { /* onclose repairs */ }
    }, VOICE_SIGNALING_HEARTBEAT_INTERVAL_MS);
  }

  private stopSignalingHeartbeat() {
    if (this.signalingHeartbeatTimer) window.clearInterval(this.signalingHeartbeatTimer);
    this.signalingHeartbeatTimer = undefined;
  }

  ensureConnected() {
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.openSocket();
  }

  private async handleSocketMessage(raw: string, socketGeneration: number) {
    if (socketGeneration !== this.socketGeneration) return;
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.type === 'server') {
      const event = String(data.event || '');
      if (event === 'pong') return;
      if (event === 'voice-joined') {
        const voicePeers = Array.isArray(data.voicePeers) ? data.voicePeers as VoicePeerInfo[] : [];
        // Reconcile instead of destroying healthy media transports. Recreating every peer on
        // a signaling reconnect caused one-way audio until a second negotiation/rejoin.
        const joinedIds = new Set(voicePeers.map((info) => info.peerId));
        for (const peerId of [...this.peers.keys()]) if (!joinedIds.has(peerId)) this.removePeer(peerId);
        for (const info of voicePeers) {
          this.ensurePeer(info);
          await this.enqueuePeerSignal(info.peerId, async (peer) => {
            peer.parentPeerId = info.parentPeerId;
            if (peer.pc.connectionState === 'failed' || peer.pc.iceConnectionState === 'failed') {
              await this.restartPeer(peer);
            } else if (peer.pc.connectionState === 'disconnected') {
              try { peer.pc.restartIce(); } catch { /* negotiation below recovers */ }
            }
            if (this.shouldCreateOffer(info.peerId) && peer.pc.signalingState === 'stable') await this.negotiate(peer);
            this.schedulePlaybackRecovery(peer, 'signaling-rejoined');
          });
        }
        this.broadcastHello();
        await notifyMain({
          type: 'VOICE_READY',
          processId: await invoke<number>('voice_process_id'),
          peerId: this.peerId,
          micActive: Boolean(this.localStream),
          micEnabled: this.micEnabled
        });
        return;
      }
      if (event === 'voice-peer-joined') {
        const info: VoicePeerInfo = { peerId: String(data.peerId || ''), parentPeerId: String(data.parentPeerId || ''), displayName: String(data.displayName || '') };
        if (info.peerId && info.parentPeerId) {
          this.ensurePeer(info);
          await this.enqueuePeerSignal(info.peerId, async (peer) => {
            this.sendSignal({ type: 'voice-hello', from: this.peerId, to: info.peerId, parentPeerId: this.config.parentPeerId, displayName: this.config.displayName });
            if (this.shouldCreateOffer(info.peerId)) await this.negotiate(peer);
          });
        }
        return;
      }
      if (event === 'voice-peer-left') {
        this.removePeer(String(data.peerId || ''));
        return;
      }
      if (event === 'voice-auth-failed') {
        await notifyMain({ type: 'VOICE_ERROR', message: 'MHTalkVoice authentication failed' });
        this.close();
        return;
      }
      return;
    }

    const signal = data as unknown as SignalMessage;
    if (!signal.from || signal.from === this.peerId) return;
    if (signal.type === 'voice-hello') {
      this.ensurePeer({ peerId: signal.from, parentPeerId: signal.parentPeerId, displayName: signal.displayName });
      await this.enqueuePeerSignal(signal.from, async (peer) => {
        if (this.shouldCreateOffer(signal.from) && peer.pc.signalingState === 'stable') await this.negotiate(peer);
      });
      return;
    }
    if (signal.type === 'description') {
      await this.enqueuePeerSignal(signal.from, (peer) => this.handleDescription(peer, signal.description));
      return;
    }
    if (signal.type === 'candidate') {
      if (!signal.candidate) return;
      await this.enqueuePeerSignal(signal.from, async (peer) => {
        const key = candidateKey(signal.candidate!);
        if (peer.candidateKeys.has(key)) return;
        peer.candidateKeys.add(key);
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate!).catch(() => undefined);
        else peer.pendingCandidates.push(signal.candidate!);
      });
      return;
    }
    if (signal.type === 'voice-media') {
      await notifyMain({ type: 'REMOTE_MIC_STATE', peerId: signal.parentPeerId, enabled: signal.micEnabled });
    }
  }

  private ensurePeer(info: VoicePeerInfo): VoiceRuntime {
    const existing = this.peers.get(info.peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: Array.isArray(this.config.iceServers) && this.config.iceServers.length ? this.config.iceServers : BASE_ICE_SERVERS,
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 6,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    preferOpus(transceiver);
    const audio = this.createAudioElement(info.parentPeerId);

    const peer: VoiceRuntime = {
      voicePeerId: info.peerId,
      parentPeerId: info.parentPeerId,
      pc,
      transceiver,
      sender: transceiver.sender,
      stream: new MediaStream(),
      audio,
      makingOffer: false,
      ignoreOffer: false,
      polite: this.peerId > info.peerId,
      pendingCandidates: [],
      candidateKeys: new Set(),
      connected: false,
      lastPlaybackAttemptAt: 0,
      playbackFailureCount: 0,
      lastAudioCurrentTime: 0,
      lastAudioProgressAt: Date.now(),
      audioProgressObserved: false,
      lastInboundBytes: 0,
      lastInboundProgressAt: Date.now(),
      remoteTrackAttachedAt: 0
    };

    pc.onicecandidate = ({ candidate }) => {
      this.sendSignal({ type: 'candidate', from: this.peerId, to: info.peerId, candidate: candidate ? candidate.toJSON() : null });
    };
    pc.onnegotiationneeded = () => this.enqueuePeerSignal(peer.voicePeerId, (current) => this.negotiate(current))
      .catch((error) => notifyMain({ type: 'VOICE_ERROR', message: `voice negotiation failed: ${safeText(error)}` }));
    pc.onconnectionstatechange = () => {
      peer.connected = pc.connectionState === 'connected';
      notifyMain({ type: 'VOICE_PEER_STATE', peerId: peer.parentPeerId, state: pc.connectionState });

      if (pc.connectionState === 'connected') {
        if (peer.disconnectRecoveryTimer) window.clearTimeout(peer.disconnectRecoveryTimer);
        peer.disconnectRecoveryTimer = undefined;
        if (this.localStream) this.attachLocalTrack(peer).catch(() => undefined);
        this.schedulePlaybackRecovery(peer, 'peer-connected');
      } else if (pc.connectionState === 'disconnected') {
        if (peer.disconnectRecoveryTimer) window.clearTimeout(peer.disconnectRecoveryTimer);
        peer.disconnectRecoveryTimer = window.setTimeout(() => {
          peer.disconnectRecoveryTimer = undefined;
          if (this.peers.get(peer.voicePeerId) === peer && peer.pc.connectionState === 'disconnected') {
            this.queuePeerRestart(peer);
          }
        }, 4000);
      } else if (pc.connectionState === 'failed') {
        if (peer.disconnectRecoveryTimer) window.clearTimeout(peer.disconnectRecoveryTimer);
        peer.disconnectRecoveryTimer = undefined;
        this.queuePeerRestart(peer);
      }
    };
    pc.ontrack = (event) => this.attachRemoteTrack(peer, event.track);

    this.peers.set(info.peerId, peer);
    this.bindAudioRecoveryEvents(peer, audio);
    if (this.localStream) this.attachLocalTrack(peer).catch(() => undefined);
    this.applyVolume(peer);
    return peer;
  }

  private createAudioElement(parentPeerId: string): HTMLAudioElement {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', 'true');
    audio.dataset.peerId = parentPeerId;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    return audio;
  }

  private bindAudioRecoveryEvents(peer: VoiceRuntime, audio: HTMLAudioElement) {
    const recover = (reason: string, rebuild = false) => {
      if (this.closed || this.peers.get(peer.voicePeerId) !== peer || peer.audio !== audio) return;
      this.schedulePlaybackRecovery(peer, reason, rebuild);
    };
    audio.addEventListener('stalled', () => recover('media-element-stalled', true));
    audio.addEventListener('error', () => recover('media-element-error', true));
    audio.addEventListener('emptied', () => recover('media-element-emptied'));
    audio.addEventListener('pause', () => {
      const state = this.volumes.get(peer.parentPeerId) || { volume: 1, muted: false };
      if (!state.muted && peer.stream.getAudioTracks().some((track) => track.readyState === 'live')) recover('media-element-paused');
    });
  }

  private async attachRemoteTrack(peer: VoiceRuntime, track: MediaStreamTrack) {
    for (const old of peer.stream.getAudioTracks()) {
      if (old.id === track.id) continue;
      old.onended = null;
      old.onmute = null;
      old.onunmute = null;
      peer.stream.removeTrack(old);
    }
    if (!peer.stream.getTracks().some((item) => item.id === track.id)) peer.stream.addTrack(track);
    peer.remoteTrack = track;
    peer.remoteTrackAttachedAt = Date.now();
    peer.lastAudioCurrentTime = 0;
    peer.lastAudioProgressAt = Date.now();
    peer.audioProgressObserved = false;
    peer.audio.srcObject = peer.stream;

    track.onunmute = () => {
      if (peer.remoteMuteRecoveryTimer) window.clearTimeout(peer.remoteMuteRecoveryTimer);
      peer.remoteMuteRecoveryTimer = undefined;
      this.schedulePlaybackRecovery(peer, 'remote-track-unmuted');
    };
    track.onmute = () => {
      if (peer.remoteMuteRecoveryTimer) window.clearTimeout(peer.remoteMuteRecoveryTimer);
      peer.remoteMuteRecoveryTimer = window.setTimeout(() => {
        peer.remoteMuteRecoveryTimer = undefined;
        if (this.peers.get(peer.voicePeerId) === peer && peer.remoteTrack === track && track.muted && peer.pc.connectionState === 'connected') {
          this.recoverRemotePlayback(peer, 'remote-track-muted', true).then((recovered) => {
            if (!recovered && track.muted) this.queuePeerRestart(peer);
          }).catch(() => this.queuePeerRestart(peer));
        }
      }, 2200);
    };
    track.onended = () => {
      if (peer.remoteTrack === track) peer.remoteTrack = undefined;
      try { peer.stream.removeTrack(track); } catch { /* ignore */ }
      notifyMain({ type: 'SPEAKING', peerId: peer.parentPeerId, speaking: false, level: 0 });
    };

    await this.recoverRemotePlayback(peer, 'remote-track-attached');
  }

  private schedulePlaybackRecovery(peer: VoiceRuntime, reason: string, rebuild = false) {
    if (this.closed || this.peers.get(peer.voicePeerId) !== peer) return;
    if (peer.playbackRecoveryTimer) window.clearTimeout(peer.playbackRecoveryTimer);
    peer.playbackRecoveryTimer = window.setTimeout(() => {
      peer.playbackRecoveryTimer = undefined;
      this.recoverRemotePlayback(peer, reason, rebuild).catch(() => undefined);
    }, rebuild ? 150 : 300);
  }

  private rebuildAudioElement(peer: VoiceRuntime, reason: string) {
    const old = peer.audio;
    this.disposeBoostGraph(peer);
    const replacement = this.createAudioElement(peer.parentPeerId);
    peer.audio = replacement;
    this.bindAudioRecoveryEvents(peer, replacement);
    replacement.srcObject = peer.stream;
    try { old.pause(); } catch { /* ignore */ }
    old.srcObject = null;
    old.remove();
    peer.lastAudioCurrentTime = 0;
    peer.lastAudioProgressAt = Date.now();
    peer.audioProgressObserved = false;
    notifyMain({ type: 'VOICE_LOG', message: `Rebuilt remote playback for ${peer.parentPeerId}: ${reason}` });
  }

  private async recoverRemotePlayback(peer: VoiceRuntime, reason: string, rebuild = false): Promise<boolean> {
    if (this.closed || this.peers.get(peer.voicePeerId) !== peer || peer.pc.connectionState === 'closed') return false;
    if (peer.playbackRecoveryPromise) return peer.playbackRecoveryPromise;
    if (!rebuild && Date.now() - peer.lastPlaybackAttemptAt < 700) return false;

    const task = (async () => {
      peer.lastPlaybackAttemptAt = Date.now();
      const liveTrack = peer.stream.getAudioTracks().find((track) => track.readyState === 'live');
      if (!liveTrack) return false;
      if (rebuild) this.rebuildAudioElement(peer, reason);

      const audio = peer.audio;
      audio.autoplay = true;
      audio.preload = 'auto';
      audio.setAttribute('playsinline', 'true');
      if (audio.srcObject !== peer.stream) audio.srcObject = peer.stream;

      await this.applyOutput(audio);
      this.applyVolume(peer);

      const state = this.volumes.get(peer.parentPeerId) || { volume: 1, muted: false };
      if (state.volume > 1) {
        try {
          await this.ensureBoostGraph(peer);
          if (peer.boostContext?.state === 'suspended') await peer.boostContext.resume();
          if (peer.boostGain) peer.boostGain.gain.value = state.muted ? 0 : Math.max(1, Math.min(2, state.volume));
          audio.muted = true;
        } catch (error) {
          this.disposeBoostGraph(peer);
          audio.muted = state.muted;
          audio.volume = 1;
          await notifyMain({ type: 'VOICE_LOG', message: `Voice boost fallback for ${peer.parentPeerId}: ${safeText(error)}` });
        }
      }

      await audio.play();
      peer.playbackFailureCount = 0;
      if (pendingInteraction?.kind === 'playback') await hideInteraction();
      await notifyMain({ type: 'REMOTE_AUDIO_PLAYING', peerId: peer.parentPeerId, recovered: reason !== 'remote-track-attached', reason });
      return true;
    })().catch(async (error) => {
      peer.playbackFailureCount += 1;
      const message = safeText(error);
      if (isAutoplayError(error)) {
        await notifyMain({ type: 'VOICE_ERROR', message: `Remote audio autoplay failed for ${peer.parentPeerId}: ${message}`, code: 'AUTOPLAY_FAILED' });
        await showInteraction('playback', `Call audio is ready, but WebView2 requires one click to enable playback. (${message})`);
      } else {
        await notifyMain({ type: 'VOICE_LOG', message: `Remote playback recovery failed for ${peer.parentPeerId}: ${message}` });
        if (!rebuild && peer.playbackFailureCount <= 2) this.schedulePlaybackRecovery(peer, 'playback-retry', true);
      }
      return false;
    });

    peer.playbackRecoveryPromise = task;
    try { return await task; }
    finally { if (peer.playbackRecoveryPromise === task) peer.playbackRecoveryPromise = undefined; }
  }

  private enqueuePeerSignal(voicePeerId: string, operation: (peer: VoiceRuntime) => Promise<void>): Promise<void> {
    const previous = this.peerSignalChains.get(voicePeerId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) return;
        const peer = this.peers.get(voicePeerId);
        if (peer) await operation(peer);
      });
    this.peerSignalChains.set(voicePeerId, next);
    void next.then(
      () => { if (this.peerSignalChains.get(voicePeerId) === next) this.peerSignalChains.delete(voicePeerId); },
      () => { if (this.peerSignalChains.get(voicePeerId) === next) this.peerSignalChains.delete(voicePeerId); }
    );
    return next;
  }

  private queuePeerRestart(peer: VoiceRuntime): void {
    void this.enqueuePeerSignal(peer.voicePeerId, (current) => this.restartPeer(current))
      .catch((error) => notifyMain({ type: 'VOICE_LOG', message: `Voice transport restart deferred: ${safeText(error)}` }));
  }

  private recreatePeerForRemoteOffer(peer: VoiceRuntime): VoiceRuntime {
    const voicePeerId = peer.voicePeerId;
    const parentPeerId = peer.parentPeerId;
    const pendingCandidates = peer.pendingCandidates.splice(0);
    this.removePeer(voicePeerId);
    const replacement = this.ensurePeer({ peerId: voicePeerId, parentPeerId });
    replacement.pendingCandidates.push(...pendingCandidates);
    return replacement;
  }

  private async handleDescription(peer: VoiceRuntime, description: RTCSessionDescriptionInit) {
    const offerCollision = description.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;
    if (offerCollision && peer.polite) await peer.pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
    try {
      await peer.pc.setRemoteDescription(description);
    } catch (error) {
      if (description.type !== 'offer' || !isMLineOrderMismatch(error) || this.peers.get(peer.voicePeerId) !== peer) throw error;
      peer = this.recreatePeerForRemoteOffer(peer);
      await peer.pc.setRemoteDescription(description);
      await notifyMain({ type: 'VOICE_LOG', message: `Rebuilt voice transport for ${peer.parentPeerId} after remote SDP lineage changed.` });
    }
    for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => undefined);
    if (description.type === 'offer') {
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      this.sendSignal({ type: 'description', from: this.peerId, to: peer.voicePeerId, description: peer.pc.localDescription! });
    }
  }

  private async negotiate(peer: VoiceRuntime) {
    if (peer.makingOffer || peer.pc.signalingState !== 'stable' || peer.pc.connectionState === 'closed') return;
    peer.makingOffer = true;
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      if (peer.pc.localDescription) this.sendSignal({ type: 'description', from: this.peerId, to: peer.voicePeerId, description: peer.pc.localDescription });
    } finally {
      peer.makingOffer = false;
    }
  }

  private async restartPeer(peer: VoiceRuntime) {
    if (peer.pc.connectionState === 'closed' || this.peers.get(peer.voicePeerId) !== peer) return;
    try {
      await notifyMain({ type: 'VOICE_LOG', message: `Restarting voice transport for ${peer.parentPeerId}` });
      peer.pc.restartIce();
      await this.negotiate(peer);
      this.schedulePlaybackRecovery(peer, 'ice-restart');
    } catch { /* socket reconnect will rebuild if needed */ }
  }

  private shouldCreateOffer(remoteVoicePeerId: string): boolean { return this.peerId < remoteVoicePeerId; }

  private sendSignal(message: SignalMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private broadcastHello() {
    this.sendSignal({ type: 'voice-hello', from: this.peerId, parentPeerId: this.config.parentPeerId, displayName: this.config.displayName });
  }

  async startMic(payload: Record<string, unknown>) {
    if (this.micStartPromise) return this.micStartPromise;
    const task = this.startMicInternal(payload);
    this.micStartPromise = task;
    try { await task; }
    finally { if (this.micStartPromise === task) this.micStartPromise = undefined; }
  }

  private async startMicInternal(payload: Record<string, unknown>) {
    this.inputDeviceId = stringOrUndefined(payload.inputDeviceId);
    this.outputDeviceId = stringOrUndefined(payload.outputDeviceId) || this.outputDeviceId;
    this.enhance = payload.voiceEnhanceEnabled !== false;
    this.desiredMicActive = true;
    if (typeof payload.micEnabled === 'boolean') this.desiredMicEnabled = Boolean(payload.micEnabled);
    if (this.micRecoveryTimer) window.clearTimeout(this.micRecoveryTimer);
    if (this.micSourceMuteRecoveryTimer) window.clearTimeout(this.micSourceMuteRecoveryTimer);
    this.micSourceMuteRecoveryTimer = undefined;

    let permissionState: PermissionState | undefined;
    try {
      const permission = await navigator.permissions?.query?.({ name: 'microphone' as PermissionName });
      permissionState = permission?.state;
    } catch { /* WebView2 versions differ; getUserMedia remains the source of truth. */ }
    if (permissionState === 'prompt') {
      await showInteraction('microphone', 'Allow microphone access for the isolated MHTalk Voice Engine. This window closes automatically after permission is granted.', payload);
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints(this.inputDeviceId, this.enhance),
        video: false
      });
    } catch (firstError) {
      // USB/Bluetooth device IDs can become stale after reconnecting. Retry once with
      // Windows' default device without tearing down the room.
      if (this.inputDeviceId && !isPermissionError(firstError)) {
        this.inputDeviceId = undefined;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints(undefined, this.enhance),
          video: false
        });
        await notifyMain({ type: 'VOICE_LOG', message: 'Configured microphone was unavailable; switched to the Windows default input.' });
      } else {
        if (isPermissionError(firstError)) {
          await showInteraction('microphone', 'Microphone access is blocked. Choose Allow, or enable microphone access for MHTalkVoice in Windows privacy settings, then press Continue.', payload);
          await notifyMain({ type: 'MIC_PERMISSION_REQUIRED', message: safeText(firstError) });
        }
        throw firstError;
      }
    }

    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('No microphone track returned by WebView2');
    }
    track.enabled = this.desiredMicEnabled;
    try { track.contentHint = 'speech'; } catch { /* optional */ }
    track.onended = () => {
      if (!this.desiredMicActive || this.closed) return;
      if (this.micRecoveryTimer) window.clearTimeout(this.micRecoveryTimer);
      this.micRecoveryTimer = window.setTimeout(() => {
        this.startMic({
          inputDeviceId: this.inputDeviceId || null,
          outputDeviceId: this.outputDeviceId || null,
          voiceEnhanceEnabled: this.enhance,
          micEnabled: this.desiredMicEnabled,
          recoveryReason: 'track-ended'
        }).catch((error) => notifyMain({ type: 'VOICE_ERROR', message: `microphone recovery failed: ${safeText(error)}` }));
      }, 500);
    };
    track.onmute = () => {
      if (!this.desiredMicActive || this.closed) return;
      if (this.micSourceMuteRecoveryTimer) window.clearTimeout(this.micSourceMuteRecoveryTimer);
      this.micSourceMuteRecoveryTimer = window.setTimeout(() => {
        this.micSourceMuteRecoveryTimer = undefined;
        const activeTrack = this.localStream?.getAudioTracks()[0];
        if (!this.desiredMicActive || this.closed || activeTrack !== track || !track.muted) return;
        this.startMic({
          inputDeviceId: this.inputDeviceId || null,
          outputDeviceId: this.outputDeviceId || null,
          voiceEnhanceEnabled: this.enhance,
          micEnabled: this.desiredMicEnabled,
          recoveryReason: 'source-muted'
        }).then(() => notifyMain({ type: 'VOICE_LOG', message: 'Microphone source recovered after Windows temporarily muted the capture track.' }))
          .catch((error) => notifyMain({ type: 'VOICE_ERROR', message: `microphone source-mute recovery failed: ${safeText(error)}` }));
      }, 1200);
    };
    track.onunmute = () => {
      if (this.micSourceMuteRecoveryTimer) window.clearTimeout(this.micSourceMuteRecoveryTimer);
      this.micSourceMuteRecoveryTimer = undefined;
    };

    const previous = this.localStream;
    previous?.getAudioTracks().forEach((item) => {
      item.onended = null;
      item.onmute = null;
      item.onunmute = null;
    });
    this.localStream = stream;
    this.micEnabled = this.desiredMicEnabled;
    for (const peer of this.peers.values()) await this.attachLocalTrack(peer);
    previous?.getTracks().forEach((item) => item.stop());
    this.startLocalMicMonitor(stream);
    this.sendSignal({ type: 'voice-media', from: this.peerId, parentPeerId: this.config.parentPeerId, micEnabled: this.micEnabled });
    await hideInteraction();
    await notifyMain({ type: 'MIC_STATE', enabled: this.micEnabled });
  }

  private async attachLocalTrack(peer: VoiceRuntime) {
    const track = this.localStream?.getAudioTracks().find((item) => item.readyState === 'live');
    if (!track) return;
    // Keep a stable sendrecv transceiver for the lifetime of the peer. Track replacement
    // normally does not need SDP renegotiation and avoids direction-flip races.
    if (peer.transceiver.direction !== 'sendrecv') peer.transceiver.direction = 'sendrecv';
    await peer.sender.replaceTrack(track);
    await applyVoiceSenderParameters(peer.sender);
  }

  async stopMic() {
    this.desiredMicActive = false;
    this.desiredMicEnabled = false;
    this.micEnabled = false;
    if (this.micRecoveryTimer) window.clearTimeout(this.micRecoveryTimer);
    this.micRecoveryTimer = undefined;
    if (this.micSourceMuteRecoveryTimer) window.clearTimeout(this.micSourceMuteRecoveryTimer);
    this.micSourceMuteRecoveryTimer = undefined;
    for (const peer of this.peers.values()) {
      // Nulling the sender stops microphone RTP without changing the receive direction.
      // The remote track remains subscribed and startMic can replace the track without a
      // disruptive negotiation cycle.
      try { await peer.sender.replaceTrack(null); } catch { /* ignore */ }
      if (peer.transceiver.direction !== 'sendrecv') peer.transceiver.direction = 'sendrecv';
    }
    this.localStream?.getAudioTracks().forEach((item) => {
      item.onended = null;
      item.onmute = null;
      item.onunmute = null;
    });
    this.localStream?.getTracks().forEach((item) => item.stop());
    this.localStream = undefined;
    this.stopLocalMicMonitor();
    this.sendSignal({ type: 'voice-media', from: this.peerId, parentPeerId: this.config.parentPeerId, micEnabled: false });
    await notifyMain({ type: 'MIC_STATE', enabled: false });
    await notifyMain({ type: 'SPEAKING', peerId: this.config.parentPeerId, speaking: false, level: 0 });
  }

  setMicEnabled(enabled: boolean) {
    this.desiredMicEnabled = enabled;
    this.micEnabled = enabled;
    this.localStream?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    this.sendSignal({ type: 'voice-media', from: this.peerId, parentPeerId: this.config.parentPeerId, micEnabled: enabled });
    notifyMain({ type: 'MIC_STATE', enabled });
    if (!enabled) notifyMain({ type: 'SPEAKING', peerId: this.config.parentPeerId, speaking: false, level: 0 });
  }

  async startVoiceMessageRecording(payload: Record<string, unknown>) {
    const recordingId = String(payload.recordingId || '').trim();
    if (!recordingId) throw new Error('voice message recording id is missing');
    if (this.voiceMessageRecorder && this.voiceMessageRecorder.state !== 'inactive') {
      throw new Error('a voice message is already being recorded');
    }

    this.cleanupVoiceMessageRecording(false);
    let recordingTrack = this.localStream?.getAudioTracks().find((track) => track.readyState === 'live')?.clone();
    let temporaryStream: MediaStream | undefined;

    if (!recordingTrack) {
      const requestedInput = stringOrUndefined(payload.inputDeviceId) || this.inputDeviceId;
      try {
        temporaryStream = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints(requestedInput, payload.voiceEnhanceEnabled !== false && this.enhance),
          video: false
        });
      } catch (firstError) {
        if (!requestedInput || isPermissionError(firstError)) throw firstError;
        temporaryStream = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints(undefined, payload.voiceEnhanceEnabled !== false && this.enhance),
          video: false
        });
        await notifyMain({ type: 'VOICE_LOG', message: 'Voice-message microphone was unavailable; switched to the Windows default input.' });
      }
      recordingTrack = temporaryStream.getAudioTracks()[0];
    }

    if (!recordingTrack) {
      temporaryStream?.getTracks().forEach((track) => track.stop());
      throw new Error('no microphone track is available for the voice message');
    }

    recordingTrack.enabled = true;
    try { recordingTrack.contentHint = 'speech'; } catch { /* optional */ }
    const recordingStream = new MediaStream([recordingTrack]);
    const mimeType = pickVoiceMessageMimeType();
    const recorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);

    this.voiceMessageRecorder = recorder;
    this.voiceMessageRecordingId = recordingId;
    this.voiceMessageSourceTrack = recordingTrack;
    this.voiceMessageTemporaryStream = temporaryStream;
    this.voiceMessageChunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && this.voiceMessageRecordingId === recordingId) this.voiceMessageChunks.push(event.data);
    };
    recorder.onerror = (event) => {
      const message = safeText((event as Event & { error?: unknown }).error || 'voice message recorder failed');
      notifyMain({ type: 'VOICE_MESSAGE_ERROR', recordingId, message });
      this.cleanupVoiceMessageRecording(true);
    };
    recorder.onstop = async () => {
      const chunks = this.voiceMessageChunks;
      const finalType = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: finalType });
      try {
        if (this.voiceMessageRecordingId === recordingId) {
          const data = arrayBufferToBase64(await blob.arrayBuffer());
          await notifyMain({
            type: 'VOICE_MESSAGE_COMPLETE',
            recordingId,
            mimeType: blob.type || finalType,
            size: blob.size,
            data
          });
        }
      } catch (error) {
        await notifyMain({ type: 'VOICE_MESSAGE_ERROR', recordingId, message: `voice message finalization failed: ${safeText(error)}` });
      } finally {
        this.cleanupVoiceMessageRecording(false);
      }
    };

    recorder.start();
    this.voiceMessageMaxTimer = window.setTimeout(() => {
      if (this.voiceMessageRecordingId === recordingId && this.voiceMessageRecorder?.state === 'recording') {
        this.voiceMessageRecorder.stop();
      }
    }, 5 * 60 * 1000);

    await notifyMain({
      type: 'VOICE_MESSAGE_STARTED',
      recordingId,
      mimeType: recorder.mimeType || mimeType || 'audio/webm',
      reusedCallMicrophone: Boolean(this.localStream)
    });
  }

  async stopVoiceMessageRecording(payload: Record<string, unknown>) {
    const recordingId = String(payload.recordingId || '').trim();
    if (!this.voiceMessageRecorder || this.voiceMessageRecorder.state === 'inactive') {
      if (recordingId) await notifyMain({ type: 'VOICE_MESSAGE_ERROR', recordingId, message: 'voice message recorder is not active' });
      return;
    }
    if (recordingId && this.voiceMessageRecordingId && recordingId !== this.voiceMessageRecordingId) return;
    this.voiceMessageRecorder.stop();
  }

  async cancelVoiceMessageRecording(payload: Record<string, unknown>) {
    const recordingId = String(payload.recordingId || this.voiceMessageRecordingId || '').trim();
    if (this.voiceMessageRecorder && this.voiceMessageRecorder.state !== 'inactive') {
      this.voiceMessageRecorder.onstop = null;
      try { this.voiceMessageRecorder.stop(); } catch { /* ignore */ }
    }
    this.cleanupVoiceMessageRecording(true);
    if (recordingId) await notifyMain({ type: 'VOICE_MESSAGE_CANCELED', recordingId });
  }

  private cleanupVoiceMessageRecording(clearHandlers: boolean) {
    if (this.voiceMessageMaxTimer) window.clearTimeout(this.voiceMessageMaxTimer);
    this.voiceMessageMaxTimer = undefined;
    if (clearHandlers && this.voiceMessageRecorder) {
      this.voiceMessageRecorder.ondataavailable = null;
      this.voiceMessageRecorder.onerror = null;
      this.voiceMessageRecorder.onstop = null;
    }
    try { this.voiceMessageSourceTrack?.stop(); } catch { /* ignore */ }
    this.voiceMessageTemporaryStream?.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* ignore */ }
    });
    this.voiceMessageRecorder = undefined;
    this.voiceMessageRecordingId = undefined;
    this.voiceMessageSourceTrack = undefined;
    this.voiceMessageTemporaryStream = undefined;
    this.voiceMessageChunks = [];
  }

  async setEnhance(enabled: boolean) {
    this.enhance = enabled;
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return;
    await track.applyConstraints({ echoCancellation: true, noiseSuppression: enabled, autoGainControl: enabled, channelCount: { ideal: 1 }, sampleRate: { ideal: 48_000 } }).catch(() => undefined);
  }

  async resumeRemotePlayback(): Promise<boolean> {
    let ok = true;
    for (const peer of this.peers.values()) {
      const recovered = await this.recoverRemotePlayback(peer, 'user-resume', true);
      if (!recovered) ok = false;
    }
    if (ok) await hideInteraction();
    return ok;
  }

  async setOutputDevice(outputDeviceId?: string) {
    this.outputDeviceId = outputDeviceId || undefined;
    for (const peer of this.peers.values()) {
      await this.applyOutput(peer.audio);
      this.schedulePlaybackRecovery(peer, 'output-device-changed', true);
    }
  }

  private async handleAudioDeviceChange() {
    if (this.closed) return;
    let devices: MediaDeviceInfo[] = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* recovery still continues */ }

    if (this.outputDeviceId) {
      const selectedOutputExists = devices.some((device) => device.kind === 'audiooutput' && device.deviceId === this.outputDeviceId);
      if (devices.length && !selectedOutputExists) {
        this.outputDeviceId = undefined;
        await notifyMain({ type: 'VOICE_LOG', message: 'The selected output device disappeared; switched to the Windows default output.' });
      }
    }
    for (const peer of this.peers.values()) {
      await this.applyOutput(peer.audio).catch(() => undefined);
      this.schedulePlaybackRecovery(peer, 'audio-device-change', true);
    }

    if (!this.desiredMicActive) return;
    if (this.inputDeviceId) {
      const selectedInputExists = devices.some((device) => device.kind === 'audioinput' && device.deviceId === this.inputDeviceId);
      if (devices.length && !selectedInputExists) {
        this.inputDeviceId = undefined;
        await notifyMain({ type: 'VOICE_LOG', message: 'The selected microphone disappeared; switched to the Windows default input.' });
      }
    }

    // Games, Bluetooth profile switches and driver resets can leave a MediaStreamTrack
    // "live" while it produces no samples. Re-acquire the microphone inside the same
    // isolated process and atomically replace the RTP sender track. The user's mute state
    // is preserved, so device recovery can never unmute them.
    if (this.micRecoveryTimer) window.clearTimeout(this.micRecoveryTimer);
    if (this.micSourceMuteRecoveryTimer) window.clearTimeout(this.micSourceMuteRecoveryTimer);
    this.micRecoveryTimer = window.setTimeout(() => {
      this.micRecoveryTimer = undefined;
      if (!this.desiredMicActive || this.closed) return;
      this.startMic({
        inputDeviceId: this.inputDeviceId || null,
        outputDeviceId: this.outputDeviceId || null,
        voiceEnhanceEnabled: this.enhance,
        micEnabled: this.desiredMicEnabled,
        recoveryReason: 'device-change'
      }).then(() => notifyMain({ type: 'VOICE_LOG', message: 'Microphone track recovered after an audio-device change.' }))
        .catch((error) => notifyMain({ type: 'VOICE_ERROR', message: `microphone device-change recovery failed: ${safeText(error)}` }));
    }, 650);
  }

  setPeerVolume(parentPeerId: string, volume: number, muted: boolean) {
    this.volumes.set(parentPeerId, { volume: Math.max(0, Math.min(2, Number.isFinite(volume) ? volume : 1)), muted });
    for (const peer of this.peers.values()) if (peer.parentPeerId === parentPeerId) this.applyVolume(peer);
  }

  private applyVolume(peer: VoiceRuntime) {
    const state = this.volumes.get(peer.parentPeerId) || { volume: 1, muted: false };
    const volume = Math.max(0, Math.min(2, state.volume));
    if (volume <= 1) {
      this.disposeBoostGraph(peer);
      peer.audio.muted = state.muted;
      peer.audio.volume = volume;
      return;
    }

    // Never silence the normal audio element before the boost graph is actually running.
    // This fallback prevents a suspended/failed AudioContext from producing one-way audio.
    peer.audio.volume = 1;
    peer.audio.muted = state.muted;
    this.ensureBoostGraph(peer).then(() => {
      if (this.peers.get(peer.voicePeerId) !== peer || !peer.boostGain) return;
      peer.boostGain.gain.value = state.muted ? 0 : volume;
      peer.audio.muted = true;
    }).catch((error) => {
      this.disposeBoostGraph(peer);
      peer.audio.muted = state.muted;
      peer.audio.volume = 1;
      notifyMain({ type: 'VOICE_LOG', message: `Voice boost fallback for ${peer.parentPeerId}: ${safeText(error)}` });
    });
  }

  private async ensureBoostGraph(peer: VoiceRuntime) {
    if (!peer.stream.getAudioTracks().some((track) => track.readyState === 'live')) throw new Error('No live remote audio track');
    if (!peer.boostContext) {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio is unavailable');
      const context = new AudioContextClass({ sampleRate: 48_000 });
      const source = context.createMediaStreamSource(peer.stream);
      const gain = context.createGain();
      source.connect(gain).connect(context.destination);
      peer.boostContext = context;
      peer.boostSource = source;
      peer.boostGain = gain;
      context.onstatechange = () => {
        if (this.peers.get(peer.voicePeerId) === peer && peer.boostContext === context && context.state === 'suspended') {
          this.schedulePlaybackRecovery(peer, 'boost-context-suspended');
        }
      };
    }
    await this.applyContextOutput(peer.boostContext);
    if (peer.boostContext.state === 'suspended') await peer.boostContext.resume();
    if (peer.boostContext.state !== 'running') throw new Error(`Voice boost context is ${peer.boostContext.state}`);
  }

  private disposeBoostGraph(peer: VoiceRuntime) {
    try { peer.boostSource?.disconnect(); } catch { /* ignore */ }
    try { peer.boostGain?.disconnect(); } catch { /* ignore */ }
    if (peer.boostContext) peer.boostContext.onstatechange = null;
    peer.boostContext?.close().catch(() => undefined);
    peer.boostContext = undefined;
    peer.boostSource = undefined;
    peer.boostGain = undefined;
  }

  private async applyContextOutput(context: AudioContext) {
    const sinkContext = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
    if (!sinkContext.setSinkId) return;
    const requested = this.outputDeviceId || '';
    try {
      await sinkContext.setSinkId(requested);
    } catch (error) {
      if (!requested) throw error;
      this.outputDeviceId = undefined;
      await notifyMain({ type: 'VOICE_LOG', message: `Selected output device was unavailable; switched to the Windows default output. (${safeText(error)})` });
      await sinkContext.setSinkId('');
    }
  }

  private async applyOutput(audio: HTMLAudioElement) {
    const media = audio as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
    if (media.setSinkId) {
      const requested = this.outputDeviceId || '';
      try {
        await media.setSinkId(requested);
      } catch (error) {
        if (!requested) throw error;
        this.outputDeviceId = undefined;
        await notifyMain({ type: 'VOICE_LOG', message: `Selected output device was unavailable; switched to the Windows default output. (${safeText(error)})` });
        await media.setSinkId('');
      }
    }
    const peer = [...this.peers.values()].find((item) => item.audio === audio);
    if (peer?.boostContext) await this.applyContextOutput(peer.boostContext);
  }

  private startStats() {
    if (this.statsTimer) window.clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(() => this.collectStats().catch(() => undefined), 350);
  }

  private async collectStats() {
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState === 'closed') continue;
      const stats = await peer.pc.getStats();
      let level = 0;
      let inboundBytes = 0;
      stats.forEach((report) => {
        if (report.type === 'media-source' && report.kind === 'audio') level = Math.max(level, Number(report.audioLevel || 0));
        if (report.type === 'inbound-rtp' && report.kind === 'audio' && !report.isRemote) {
          level = Math.max(level, Number(report.audioLevel || 0));
          inboundBytes += Number(report.bytesReceived || 0);
        }
      });

      const now = Date.now();
      const inboundAdvanced = inboundBytes > peer.lastInboundBytes;
      if (inboundBytes < peer.lastInboundBytes) peer.lastInboundBytes = 0;
      if (inboundAdvanced) peer.lastInboundProgressAt = now;
      peer.lastInboundBytes = Math.max(peer.lastInboundBytes, inboundBytes);

      const currentTime = Number.isFinite(peer.audio.currentTime) ? peer.audio.currentTime : 0;
      if (currentTime > peer.lastAudioCurrentTime + 0.02) {
        peer.lastAudioCurrentTime = currentTime;
        peer.lastAudioProgressAt = now;
        peer.audioProgressObserved = true;
      }

      const state = this.volumes.get(peer.parentPeerId) || { volume: 1, muted: false };
      const liveTrack = peer.stream.getAudioTracks().find((track) => track.readyState === 'live');
      if (inboundAdvanced && liveTrack && !state.muted && now - peer.remoteTrackAttachedAt > 900) {
        const usesBoost = state.volume > 1 && Boolean(peer.boostContext);
        const boostBroken = usesBoost && peer.boostContext?.state !== 'running';
        const mediaBroken = !usesBoost && (peer.audio.paused || peer.audio.ended || Boolean(peer.audio.error));
        const progressStalled = !usesBoost && peer.audioProgressObserved && now - peer.lastAudioProgressAt > 3500;
        if (boostBroken || mediaBroken || progressStalled) {
          this.schedulePlaybackRecovery(peer, boostBroken ? 'boost-context-stopped' : progressStalled ? 'media-clock-stalled' : 'media-element-not-playing', progressStalled);
        }
      }

      const speaking = level > 0.018 && !state.muted;
      if (this.lastSpeaking.get(peer.parentPeerId) !== speaking) {
        this.lastSpeaking.set(peer.parentPeerId, speaking);
        await notifyMain({ type: 'SPEAKING', peerId: peer.parentPeerId, speaking, level });
      }
    }
    if (this.micMonitorAnalyser && this.micMonitorData) {
      this.micMonitorAnalyser.getByteTimeDomainData(this.micMonitorData);
      let sum = 0;
      for (const value of this.micMonitorData) { const centered = (value - 128) / 128; sum += centered * centered; }
      const level = Math.sqrt(sum / Math.max(1, this.micMonitorData.length));
      const speaking = this.micEnabled && level > 0.018;
      if (this.lastSpeaking.get(this.config.parentPeerId) !== speaking) {
        this.lastSpeaking.set(this.config.parentPeerId, speaking);
        await notifyMain({ type: 'SPEAKING', peerId: this.config.parentPeerId, speaking, level });
      }
    }
  }

  private startLocalMicMonitor(stream: MediaStream) {
    this.stopLocalMicMonitor();
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass({ sampleRate: 48_000 });
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    context.resume().catch(() => undefined);
    this.micMonitorContext = context;
    this.micMonitorSource = source;
    this.micMonitorAnalyser = analyser;
    this.micMonitorData = new Uint8Array(analyser.fftSize);
  }

  private stopLocalMicMonitor() {
    try { this.micMonitorSource?.disconnect(); } catch { /* ignore */ }
    try { this.micMonitorAnalyser?.disconnect(); } catch { /* ignore */ }
    this.micMonitorContext?.close().catch(() => undefined);
    this.micMonitorContext = undefined;
    this.micMonitorSource = undefined;
    this.micMonitorAnalyser = undefined;
    this.micMonitorData = undefined;
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => {
      notifyMain({
        type: 'VOICE_HEARTBEAT',
        at: Date.now(),
        peers: this.peers.size,
        micActive: Boolean(this.localStream),
        micEnabled: this.micEnabled,
        signalingConnected: this.ws?.readyState === WebSocket.OPEN
      });
    }, 2000);
  }

  private removePeer(voicePeerId: string) {
    const peer = this.peers.get(voicePeerId);
    if (!peer) return;
    this.peers.delete(voicePeerId);
    if (peer.playbackRecoveryTimer) window.clearTimeout(peer.playbackRecoveryTimer);
    if (peer.disconnectRecoveryTimer) window.clearTimeout(peer.disconnectRecoveryTimer);
    if (peer.remoteMuteRecoveryTimer) window.clearTimeout(peer.remoteMuteRecoveryTimer);
    if (peer.remoteTrack) {
      peer.remoteTrack.onended = null;
      peer.remoteTrack.onmute = null;
      peer.remoteTrack.onunmute = null;
    }
    try { peer.pc.close(); } catch { /* ignore */ }
    this.disposeBoostGraph(peer);
    try { peer.audio.pause(); } catch { /* ignore */ }
    peer.audio.srcObject = null;
    peer.audio.remove();
    this.lastSpeaking.delete(peer.parentPeerId);
    notifyMain({ type: 'SPEAKING', peerId: peer.parentPeerId, speaking: false, level: 0 });
  }

  close() {
    this.closed = true;
    this.socketGeneration += 1;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.stopSignalingHeartbeat();
    if (this.statsTimer) window.clearInterval(this.statsTimer);
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    if (this.micRecoveryTimer) window.clearTimeout(this.micRecoveryTimer);
    if (this.deviceListenerAttached) {
      navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceChangeHandler);
      this.deviceListenerAttached = false;
    }
    this.stopLocalMicMonitor();
    if (this.voiceMessageRecorder && this.voiceMessageRecorder.state !== 'inactive') {
      this.voiceMessageRecorder.onstop = null;
      try { this.voiceMessageRecorder.stop(); } catch { /* ignore */ }
    }
    this.cleanupVoiceMessageRecording(true);
    this.localStream?.getAudioTracks().forEach((item) => {
      item.onended = null;
      item.onmute = null;
      item.onunmute = null;
    });
    this.localStream?.getTracks().forEach((item) => item.stop());
    this.localStream = undefined;
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

function microphoneConstraints(inputDeviceId?: string, enhance = true): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: enhance,
    autoGainControl: enhance,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 }
  };
  if (inputDeviceId) constraints.deviceId = { ideal: inputDeviceId };
  return constraints;
}

function preferOpus(transceiver: RTCRtpTransceiver) {
  try {
    const codecs = RTCRtpReceiver.getCapabilities('audio')?.codecs || [];
    const opus = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus');
    if (opus.length) transceiver.setCodecPreferences([...opus, ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'audio/opus')]);
  } catch { /* optional on older WebView2 */ }
}

async function applyVoiceSenderParameters(sender: RTCRtpSender) {
  const params = sender.getParameters();
  params.encodings = params.encodings?.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = 32_000;
  const encoding = params.encodings[0] as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string; dtx?: string };
  if ('priority' in encoding) encoding.priority = 'high';
  if ('networkPriority' in encoding) encoding.networkPriority = 'high';
  if ('dtx' in encoding) encoding.dtx = 'enabled';
  await sender.setParameters(params).catch(() => undefined);
}

function candidateKey(candidate: RTCIceCandidateInit): string {
  return [candidate.sdpMid || '', candidate.sdpMLineIndex ?? '', candidate.usernameFragment || '', candidate.candidate || ''].join('|');
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function isPermissionError(error: unknown): boolean {
  const name = String((error as DOMException)?.name || '');
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
}

function isAutoplayError(error: unknown): boolean {
  const name = String((error as DOMException)?.name || '');
  const message = safeText(error).toLowerCase();
  return name === 'NotAllowedError' || message.includes('user gesture') || message.includes('play() failed');
}

let engine: VoiceCompanionRoom | undefined;
let currentBootstrap: BootstrapConfig | undefined;

async function handleCommand(command: EngineCommand) {
  const payload = command.payload || {};
  switch (command.type) {
    case 'BOOTSTRAP': {
      const next = payload as unknown as BootstrapConfig;
      if (!next.roomId || !next.signalingUrl || !next.parentPeerId || !next.voiceToken) throw new Error('invalid voice bootstrap');
      const sameSession = Boolean(
        engine && currentBootstrap
        && currentBootstrap.roomId === next.roomId
        && currentBootstrap.signalingUrl.replace(/\/$/, '') === next.signalingUrl.replace(/\/$/, '')
        && currentBootstrap.parentPeerId === next.parentPeerId
        && currentBootstrap.voiceToken === next.voiceToken
      );
      if (sameSession) {
        currentBootstrap = next;
        engine!.ensureConnected();
        await notifyMain({ type: 'VOICE_LOG', message: 'Reused the existing MHTalkVoice session after signaling recovery.' });
        break;
      }
      engine?.close();
      currentBootstrap = next;
      engine = new VoiceCompanionRoom(next);
      await engine.connect();
      break;
    }
    case 'START_MIC':
      if (!engine) throw new Error('voice engine not bootstrapped');
      await engine.startMic(payload);
      break;
    case 'STOP_MIC':
      await engine?.stopMic();
      break;
    case 'SET_MIC_ENABLED':
      engine?.setMicEnabled(Boolean(payload.enabled));
      break;
    case 'START_VOICE_MESSAGE_RECORDING':
      if (!engine) throw new Error('voice engine not bootstrapped');
      await engine.startVoiceMessageRecording(payload);
      break;
    case 'STOP_VOICE_MESSAGE_RECORDING':
      await engine?.stopVoiceMessageRecording(payload);
      break;
    case 'CANCEL_VOICE_MESSAGE_RECORDING':
      await engine?.cancelVoiceMessageRecording(payload);
      break;
    case 'SET_VOICE_ENHANCE':
      await engine?.setEnhance(Boolean(payload.enabled));
      break;
    case 'SET_OUTPUT_DEVICE':
      await engine?.setOutputDevice(stringOrUndefined(payload.outputDeviceId));
      break;
    case 'SET_PEER_VOLUME':
      engine?.setPeerVolume(String(payload.peerId || ''), Number(payload.volume ?? 1), Boolean(payload.muted));
      break;
    case 'PING':
      await notifyMain({ type: 'PONG', at: Date.now(), roomId: currentBootstrap?.roomId || '' });
      break;
    case 'SHUTDOWN':
      engine?.close();
      await notifyMain({ type: 'ENGINE_STOPPED' });
      window.close();
      break;
  }
}

async function dispatch(command: EngineCommand) {
  try { await handleCommand(command); }
  catch (error) { await notifyMain({ type: 'VOICE_ERROR', message: safeText(error), command: command.type }); }
}

async function boot() {
  document.documentElement.dataset.engine = 'mhtalk-voice';
  document.getElementById('permission-retry')?.addEventListener('click', () => {
    const pending = pendingInteraction;
    if (!pending || !engine) return;
    if (pending.kind === 'microphone') {
      engine.startMic(pending.micPayload || {}).catch((error) => notifyMain({ type: 'VOICE_ERROR', message: `microphone permission retry failed: ${safeText(error)}` }));
    } else {
      engine.resumeRemotePlayback().then((ok) => {
        if (!ok) notifyMain({ type: 'VOICE_ERROR', message: 'Call audio is still blocked by WebView2 autoplay policy.' });
      }).catch(() => undefined);
    }
  });
  document.getElementById('permission-hide')?.addEventListener('click', () => hideInteraction());
  await listen<EngineCommand>('mhtalk://voice-command', (event) => dispatch(event.payload));
  const pending = await invoke<EngineCommand[]>('voice_mark_ready_and_take_pending');
  for (const command of pending) await dispatch(command);
  await notifyMain({ type: 'ENGINE_READY', processId: await invoke<number>('voice_process_id'), version: '0.9.3' });
}

boot().catch((error) => notifyMain({ type: 'VOICE_ERROR', message: `voice boot failed: ${safeText(error)}` }));
