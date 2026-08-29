import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, MouseEvent as ReactMouseEvent, ChangeEvent, ClipboardEvent as ReactClipboardEvent, PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, CSSProperties } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { availableMonitors, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';
import { check } from '@tauri-apps/plugin-updater';
import { exit, relaunch } from '@tauri-apps/plugin-process';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  register as registerGlobalShortcut,
  unregister as unregisterGlobalShortcut,
  unregisterAll as unregisterAllGlobalShortcuts
} from '@tauri-apps/plugin-global-shortcut';
import './styles.css';
import {
  applyLowMode,
  generateRoomId,
  listMediaDevices,
  normalizeRoomId,
  MAX_ATTACHMENT_BYTES,
  INLINE_PREVIEW_MAX_BYTES
} from './services/realtime';
import { createRoomSession, type RoomSession } from './services/roomSession';
import {
  clearAllLocalData,
  clearRoomMessages,
  acknowledgeMessageOutbox,
  enqueueMessageOutbox,
  initDb,
  loadDueMessageOutbox,
  loadMessageOutbox,
  loadMessages,
  loadProfile,
  loadSettings,
  markMessageDeleted,
  markMessageOutboxAttempt,
  saveMessage,
  saveProfile,
  saveSettings,
  setMessageOutboxRecipients,
  DEFAULT_SETTINGS,
  DEFAULT_HOTKEYS,
  DEFAULT_CAMERA_OVERLAY,
  DEFAULT_SCREEN_RECORDER
} from './services/db';
import {
  ScreenRecorderController,
  finalizeRecoverableScreenRecording,
  getScreenRecorderDependencyStatus,
  listRecoverableScreenRecordings,
  openScreenRecordingsFolder,
  prepareScreenRecorderDependencies
} from './services/screenRecorder';
import type {
  RecoverableScreenRecording,
  RecorderDependencyStatus,
  ScreenRecorderRuntimeState,
  ScreenRecorderSourceInfo,
  ScreenRecorderAudioLevels
} from './services/screenRecorder';
import type { AppSettings, ChatMessage, ChatOverlaySettings, CameraOverlaySettings, ConnectionState, PeerProfile, ScreenFps, ScreenQuality, ScreenRecorderSettings, UserProfile } from './types/models';
import {
  fetchProfileAssets,
  MAX_PROFILE_SOURCE_IMAGE_BYTES,
  profileAvatarVersion,
  publishProfileAvatar,
  type ProfileAssetAccess
} from './services/profileAssets';
import { AsyncCommandGate } from './core/asyncCommandGate';
import { BoundedMessageIdCache, outboxRetryDelayMs, pendingOutboxRecipients } from './core/outboxPolicy';
import { ENGLISH_COPY } from './copy/en';
import { appendDiagnostic, clearDiagnostics, loadDiagnostics, subscribeDiagnostics, type DiagnosticEntry } from './core/diagnostics';
import { validateHotkeyMap } from './core/hotkeyPolicy';
import { supportedRecorderResolutions } from './core/recordingQuality';

const TEXT: Readonly<Record<string, string>> = ENGLISH_COPY;

const EMOJIS = ['😀', '😂', '😍', '🔥', '❤️', '👍', '👏', '😎', '😢', '😡', '🙏', '🎉', '💯', '✨', '👀', '✅', '❌', '⚡', '🌟', '😴', '🤝', '💪', '🎮', '🫡', '🤣', '🥲', '😅', '🙌', '🌹', '💙'];
const INSTAGRAM_URL = 'https://www.instagram.com/m.ed1t/';
const APP_VERSION = '0.9.3';


type PeerVolume = { voice: number; screen: number; voiceMuted: boolean; screenMuted: boolean };
type PendingAttachment = { id: string; file: File; preview?: string };
type OutgoingAttachmentSource = {
  file: File;
  targetPeerId?: string;
  replyTo?: Pick<ChatMessage, 'id' | 'body' | 'senderName'>;
};
type CameraBox = { x: number; y: number; width: number; height: number };

type MediaPreview = { src: string; name?: string; kind: 'image' | 'video'; localPath?: string };
type ImagePreview = { src: string; name?: string };
type MediaContextMenu = MediaPreview & { x: number; y: number };
type FileContextMenu = { message: ChatMessage; x: number; y: number };
type FileSaveProgress = { operationId: string; written: number; total: number; targetPath: string };
type SelfMediaMenu = { x: number; y: number };
type BannedMember = { peerId: string; displayName: string; kickedAt: number };
type JoinRequest = { peerId: string; displayName: string; requestedAt: number };
type SpeakRequest = { peerId: string; displayName: string; requestedAt: number };
type SettingsTab = 'voice' | 'camera' | 'recorder' | 'hotkeys' | 'others';
const SETTINGS_TAB_ORDER: SettingsTab[] = ['voice', 'camera', 'recorder', 'hotkeys', 'others'];
type RoomRole = 'owner' | 'moderator' | 'member';
type HotkeyAction = 'muteMic' | 'toggleScreen' | 'endCall' | 'toggleFullscreen' | 'toggleSettings' | 'toggleOverlayMode';
type PendingVoiceMessage = { blob: Blob; dataUrl: string; waveform: number[] };
type LogEntry = DiagnosticEntry;
type VoiceEngineStatus = { supported: boolean; ready: boolean; phase: string; processName: string; note: string; voiceEnhanceEnabled?: boolean };

let currentVoiceMessageAudio: HTMLAudioElement | null = null;

type MediaVideoProps = { stream?: MediaStream; active: boolean; videoRef?: RefObject<HTMLVideoElement | null>; audioEnabled?: boolean; muted?: boolean; volume?: number; outputId?: string; refreshToken?: number };
function MediaVideo({ stream, active, videoRef, audioEnabled = false, muted = true, volume = 1, outputId, refreshToken = 0 }: MediaVideoProps) {
  const localRef = useRef<HTMLVideoElement | null>(null);
  const ref = videoRef || localRef;
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let cancelled = false;
    const bind = () => {
      if (cancelled) return;
      if (!stream || !active) {
        video.pause();
        video.muted = true;
        video.srcObject = null;
        return;
      }
      video.srcObject = stream || null;
      // Normal app playback is handled by the separate screen-audio sink.
      // Only PiP enables the video element audio so the PiP mute button actually works.
      video.muted = !audioEnabled || muted || !stream;
      video.volume = Math.min(1, Math.max(0, volume));
      const sink = video as HTMLVideoElement & { setSinkId?: (sinkId: string) => Promise<void> };
      if (sink.setSinkId && outputId) sink.setSinkId(outputId).catch(() => undefined);
      video.play().catch(() => undefined);
    };
    if (refreshToken > 0) {
      video.pause();
      video.srcObject = null;
      window.requestAnimationFrame(bind);
    } else {
      bind();
    }
    return () => { cancelled = true; };
  }, [stream, active, ref, audioEnabled, muted, volume, outputId, refreshToken]);
  useEffect(() => () => {
    const video = ref.current;
    if (!video) return;
    video.pause();
    video.srcObject = null;
  }, [ref]);
  return <video ref={ref} autoPlay playsInline className={active ? 'screen-video active' : 'screen-video'} />;
}

type AudioSinkProps = { stream?: MediaStream; muted: boolean; volume: number; outputId?: string; refreshToken?: number };

function LocalMediaPreview({ stream, className = 'self-preview-video', style }: { stream?: MediaStream | null; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream || null;
    if (stream) video.play().catch(() => undefined);
    return () => { if (video) video.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className={className} style={style} autoPlay playsInline muted />;
}

function AudioSink({ stream, muted, volume, outputId, refreshToken = 0 }: AudioSinkProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const sink = audio as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
    let cancelled = false;

    const startPlayback = async () => {
      if (cancelled) return;
      audio.srcObject = stream || null;
      audio.volume = Math.min(1, Math.max(0, volume));
      audio.muted = muted || !stream;
      if (!stream || audio.muted) {
        audio.pause();
        return;
      }
      try {
        if (sink.setSinkId && outputId) await sink.setSinkId(outputId);
      } catch {
        // Ignore sink selection failures and fall back to default output.
      }
      try {
        await audio.play();
      } catch {
        // Browsers can reject play() until the user interacts, which is expected.
      }
    };

    if (refreshToken > 0) {
      audio.pause();
      audio.srcObject = null;
      window.requestAnimationFrame(() => startPlayback().catch(() => undefined));
    } else {
      startPlayback().catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [stream, muted, volume, outputId, refreshToken]);
  useEffect(() => () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.srcObject = null;
  }, []);
  return <audio ref={audioRef} autoPlay playsInline />;
}

function BoostedAudioSink({ stream, muted, volume, outputId, refreshToken = 0 }: AudioSinkProps) {
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const [boostedStream, setBoostedStream] = useState<MediaStream | undefined>(undefined);
  const shouldBoost = Boolean(stream?.getAudioTracks().length) && volume > 1;

  useEffect(() => {
    try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
    sourceRef.current = null;
    setBoostedStream(undefined);
    if (!stream || !stream.getAudioTracks().length || !shouldBoost) return;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = ctxRef.current || new AudioContextClass();
    const gain = gainRef.current || ctx.createGain();
    const destination = destinationRef.current || ctx.createMediaStreamDestination();
    ctxRef.current = ctx;
    gainRef.current = gain;
    destinationRef.current = destination;
    gain.gain.value = muted ? 0 : Math.min(2, Math.max(0, volume));
    try { ctx.resume().catch(() => undefined); } catch { /* ignore */ }
    try {
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      source.connect(gain);
      gain.connect(destination);
      setBoostedStream(destination.stream);
      return () => {
        try { source.disconnect(); } catch { /* ignore */ }
        try { gain.disconnect(destination); } catch { /* ignore */ }
      };
    } catch {
      return;
    }
  }, [stream, shouldBoost, refreshToken]);

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = muted ? 0 : Math.min(2, Math.max(0, volume));
  }, [muted, volume]);

  useEffect(() => () => {
    try { sourceRef.current?.disconnect(); } catch { /* ignore */ }
    try { gainRef.current?.disconnect(); } catch { /* ignore */ }
    sourceRef.current = null;
    gainRef.current = null;
    destinationRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => undefined);
  }, []);

  return <AudioSink stream={shouldBoost ? boostedStream : stream} muted={muted || (shouldBoost && !boostedStream)} volume={shouldBoost ? 1 : Math.min(1, volume)} outputId={outputId} refreshToken={refreshToken} />;
}

function SpeakingDetector({ stream, peerId, onSpeaking }: { stream?: MediaStream; peerId: string; onSpeaking: (peerId: string, active: boolean) => void }) {
  useEffect(() => {
    if (!stream?.getAudioTracks().length) {
      onSpeaking(peerId, false);
      return;
    }
    let stopped = false;
    let raf = 0;
    let activeFrames = 0;
    let inactiveFrames = 0;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    const data = new Float32Array(analyser.fftSize);
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch {
      ctx.close().catch(() => undefined);
      return;
    }
    const tick = () => {
      if (stopped) return;
      try {
        ctx.resume().catch(() => undefined);
        analyser.getFloatTimeDomainData(data);
        let sumSquares = 0;
        for (let index = 0; index < data.length; index += 1) {
          const value = data[index] || 0;
          sumSquares += value * value;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const active = rms > 0.02;
        if (active) {
          activeFrames += 1;
          inactiveFrames = 0;
          if (activeFrames >= 2) onSpeaking(peerId, true);
        } else {
          inactiveFrames += 1;
          activeFrames = 0;
          if (inactiveFrames >= 4) onSpeaking(peerId, false);
        }
      } catch {
        onSpeaking(peerId, false);
      }
      raf = window.setTimeout(tick, 120) as unknown as number;
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(raf);
      onSpeaking(peerId, false);
      try { source?.disconnect(); } catch { /* ignore */ }
      ctx.close().catch(() => undefined);
    };
  }, [stream, peerId, onSpeaking]);
  return null;
}

function nowId() { return `${Date.now()}-${crypto.randomUUID()}`; }

function messageKindFromMime(mimeType: string): ChatMessage['kind'] {
  return mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'file';
}

function normalizeHotkeyCombo(combo = ''): string {
  if (!combo) return '';
  const parts = combo.split('+').filter(Boolean);
  const last = parts.pop();
  if (!last) return '';
  const legacyMap: Record<string, string> = {
    ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote', ' ': 'Space'
  };
  let code = last;
  if (/^[A-Z]$/i.test(last)) code = `Key${last.toUpperCase()}`;
  else if (/^[0-9]$/.test(last)) code = `Digit${last}`;
  else if (legacyMap[last]) code = legacyMap[last];
  return [...parts, code].join('+');
}

function hotkeyCodeLabel(code: string): string {
  const named: Record<string, string> = {
    Space: 'Space', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab'
  };
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return code.replace('Numpad', 'Num ');
  return named[code] || code.replace(/(Left|Right)$/, '');
}

function displayHotkey(combo = ''): string {
  const normalized = normalizeHotkeyCombo(combo);
  if (!normalized) return '?';
  const parts = normalized.split('+');
  const code = parts.pop() || '';
  return [...parts, hotkeyCodeLabel(code)].join('+');
}

function toTauriShortcut(combo = ''): string {
  const normalized = normalizeHotkeyCombo(combo);
  if (!normalized) return '';
  return normalized
    .replace(/^Ctrl(?=\+|$)/, 'CommandOrControl')
    .replace(/\+Key([A-Z])$/i, '+$1')
    .replace(/\+Digit([0-9])$/, '+$1')
    .replace(/\+Comma$/, '+Comma')
    .replace(/\+Period$/, '+Period')
    .replace(/\+Space$/, '+Space');
}

function formatHotkeyEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  const code = event.code || event.key;
  if (!['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'Control', 'Shift', 'Alt', 'Meta'].includes(code)) parts.push(code);
  return parts.length && parts[parts.length - 1] ? parts.join('+') : '';
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return Boolean(element.closest('input, textarea, [contenteditable="true"]'));
}

function systemMessage(roomId: string, body: string): ChatMessage {
  return { id: nowId(), roomId, sender: 'system', senderName: 'MHTalk', body, createdAt: Date.now(), kind: 'text' };
}

function formatBytes(value = 0): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatRecorderDuration(totalSeconds = 0): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getScreenCapability() {
  const width = Math.max(window.screen.width || 0, window.screen.availWidth || 0);
  const height = Math.max(window.screen.height || 0, window.screen.availHeight || 0);
  const longEdge = Math.max(width, height);
  const refreshRate = Number((window.screen as Screen & { refreshRate?: number }).refreshRate || 60);
  return { width, height, longEdge, refreshRate: Number.isFinite(refreshRate) ? refreshRate : 60 };
}

function qualityOptionsForScreen(): ScreenQuality[] {
  const { longEdge } = getScreenCapability();
  const options: ScreenQuality[] = ['auto-max'];
  if (longEdge >= 3840) options.push('4k');
  if (longEdge >= 2560) options.push('1440p');
  if (longEdge >= 1920) options.push('1080p');
  if (longEdge >= 1280) options.push('720p');
  options.push('480p', '360p', 'audio-only');
  return Array.from(new Set(options));
}

function fpsOptionsForScreen(): ScreenFps[] {
  const { refreshRate } = getScreenCapability();
  const options: ScreenFps[] = [];
  if (refreshRate >= 140) options.push(144);
  if (refreshRate >= 115) options.push(120);
  options.push(60, 30, 15, 8);
  return Array.from(new Set(options));
}

function readFileAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return readFileAsDataUrl(blob);
}

async function mediaSourceToDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src;
  const response = await fetch(src);
  const blob = await response.blob();
  return blobToDataUrl(blob);
}

function pickVoiceRecorderMimeType(): string | undefined {
  const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return preferred.find((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
}

function buildRecorderMicConstraints(inputDeviceId?: string): MediaTrackConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: 1 }
  };
  if (inputDeviceId) audio.deviceId = { ideal: inputDeviceId };
  return audio;
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function youtubeIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.replace('/', '') || null;
    if (parsed.hostname.includes('youtube.com')) return parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop() || null;
  } catch { /* ignore */ }
  return null;
}

function linkPreviewFromText(body: string): ChatMessage['linkPreview'] | undefined {
  const url = extractFirstUrl(body);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const yt = youtubeIdFromUrl(url);
    return {
      url,
      title: yt ? 'YouTube' : parsed.hostname.replace(/^www\./, ''),
      provider: parsed.hostname.replace(/^www\./, ''),
      image: yt ? `https://img.youtube.com/vi/${yt}/hqdefault.jpg` : undefined
    };
  } catch {
    return undefined;
  }
}



const DESKTOP_CHAT_OVERLAY_WIDTH = 420;
const DESKTOP_CHAT_OVERLAY_HEIGHT = 245;
type OverlayMessageItem = { senderName: string; body: string; kind?: string; dataUrl?: string };

function clampOverlaySettings(settings?: Partial<ChatOverlaySettings>): ChatOverlaySettings {
  const base = DEFAULT_SETTINGS.chatOverlay;
  const merged = { ...base, ...(settings || {}) };
  const widthPercent = Math.min(90, Math.max(12, Number(merged.widthPercent)));
  const heightPercent = Math.min(60, Math.max(8, Number(merged.heightPercent)));
  return {
    ...merged,
    xPercent: Math.min(100 - widthPercent, Math.max(0, Number(merged.xPercent))),
    yPercent: Math.min(100 - heightPercent, Math.max(0, Number(merged.yPercent))),
    widthPercent,
    heightPercent,
    opacity: Math.min(1, Math.max(0.15, Number(merged.opacity))),
    borderRadius: Math.min(40, Math.max(0, Number(merged.borderRadius)))
  };
}


function clampCameraSettings(settings?: Partial<CameraOverlaySettings>): CameraOverlaySettings {
  const base = DEFAULT_CAMERA_OVERLAY;
  const merged = { ...base, ...(settings || {}) };
  const widthPercent = Math.min(70, Math.max(10, Number(merged.widthPercent)));
  const heightPercent = Math.min(70, Math.max(10, Number(merged.heightPercent)));
  return {
    ...merged,
    xPercent: Math.min(100 - widthPercent, Math.max(0, Number(merged.xPercent))),
    yPercent: Math.min(100 - heightPercent, Math.max(0, Number(merged.yPercent))),
    widthPercent,
    heightPercent,
    borderRadius: Math.min(50, Math.max(0, Number(merged.borderRadius))),
    mirror: merged.mirror !== false,
    fitMode: merged.fitMode === 'contain' ? 'contain' : 'cover',
    cropXPercent: Math.min(100, Math.max(0, Number(merged.cropXPercent))),
    cropYPercent: Math.min(100, Math.max(0, Number(merged.cropYPercent))),
    cropTopPercent: Math.min(40, Math.max(0, Number(merged.cropTopPercent))),
    cropRightPercent: Math.min(40, Math.max(0, Number(merged.cropRightPercent))),
    cropBottomPercent: Math.min(40, Math.max(0, Number(merged.cropBottomPercent))),
    cropLeftPercent: Math.min(40, Math.max(0, Number(merged.cropLeftPercent))),
    opacity: Math.min(1, Math.max(0.1, Number(merged.opacity)))
  };
}

async function desktopChatOverlayGeometry(overlaySettings?: Partial<ChatOverlaySettings>) {
  const normalized = clampOverlaySettings(overlaySettings);
  const fallbackW = DESKTOP_CHAT_OVERLAY_WIDTH;
  const fallbackH = DESKTOP_CHAT_OVERLAY_HEIGHT;
  try {
    const monitors = await availableMonitors();
    const monitor = monitors.find((item) => item.name === normalized.monitorName)
      || monitors.find((item) => item.position.x === 0 && item.position.y === 0)
      || monitors[0];
    if (monitor) {
      const scale = Math.max(0.5, Number(monitor.scaleFactor || 1));
      const originX = Math.round(monitor.position.x / scale);
      const originY = Math.round(monitor.position.y / scale);
      const screenW = Math.max(320, Math.round(monitor.size.width / scale));
      const screenH = Math.max(240, Math.round(monitor.size.height / scale));
      const width = Math.min(screenW, Math.max(180, Math.round(screenW * normalized.widthPercent / 100)));
      const height = Math.min(screenH, Math.max(90, Math.round(screenH * normalized.heightPercent / 100)));
      const rawX = originX + Math.round((screenW - width) * normalized.xPercent / 100);
      const rawY = originY + Math.round((screenH - height) * normalized.yPercent / 100);
      const x = Math.min(originX + screenW - width, Math.max(originX, rawX));
      const y = Math.min(originY + screenH - height, Math.max(originY, rawY));
      return { width, height, x, y, monitorName: monitor.name || '' };
    }
  } catch {
    // Browser/dev fallback below.
  }
  const screenW = window.screen?.availWidth || 1280;
  const screenH = window.screen?.availHeight || 720;
  const width = Math.max(180, Math.round(screenW * normalized.widthPercent / 100)) || fallbackW;
  const height = Math.max(90, Math.round(screenH * normalized.heightPercent / 100)) || fallbackH;
  return { width, height, x: Math.round((screenW - width) * normalized.xPercent / 100), y: Math.round((screenH - height) * normalized.yPercent / 100), monitorName: '' };
}

async function hardenDesktopChatOverlayWindow(
  overlay: WebviewWindow,
  geometry: { width: number; height: number; x: number; y: number },
  interactive = false
) {
  const overlayApi = overlay as any;
  await Promise.allSettled([
    overlayApi.setAlwaysOnTop?.(true),
    overlayApi.setSkipTaskbar?.(true),
    overlayApi.setIgnoreCursorEvents?.(!interactive),
    overlayApi.setResizable?.(interactive),
    overlayApi.setVisibleOnAllWorkspaces?.(true),
    overlayApi.setSize?.(new LogicalSize(geometry.width, geometry.height)),
    overlayApi.setPosition?.(new LogicalPosition(geometry.x, geometry.y)),
    overlayApi.show?.()
  ]);
}

function ChatOverlayWindow() {
  const [items, setItems] = useState<OverlayMessageItem[]>([]);
  const [overlaySettings, setOverlaySettings] = useState<ChatOverlaySettings>(DEFAULT_SETTINGS.chatOverlay);
  useEffect(() => {
    document.documentElement.classList.add('chat-overlay-root');
    document.body.classList.add('chat-overlay-body');
    return () => {
      document.documentElement.classList.remove('chat-overlay-root');
      document.body.classList.remove('chat-overlay-body');
    };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<OverlayMessageItem[]>('mhlko://chat-overlay-update', (event) => {
      setItems(Array.isArray(event.payload) ? event.payload.slice(-5) : []);
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ChatOverlaySettings>('mhlko://chat-overlay-settings', (event) => {
      setOverlaySettings(clampOverlaySettings(event.payload));
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, []);
  return <main className={`desktop-chat-overlay-window ${overlaySettings.interactive ? 'interactive' : 'click-through'}`} aria-label="MHTalk Chat Overlay" style={{ opacity: overlaySettings.opacity, borderRadius: `${overlaySettings.borderRadius}px`, pointerEvents: overlaySettings.interactive ? 'auto' : 'none' }}>
    {overlaySettings.interactive && <div className="desktop-overlay-mode-badge">MHTalk • Interactive</div>}
    {items.length === 0 && <div className="desktop-chat-overlay-empty"><b>MHTalk</b><span>{TEXT.chatOverlayEmpty}</span></div>}
    {items.map((message, index) => <div key={`${message.senderName}-${index}`} className={`overlay-item ${message.kind || 'text'}`}><b>{message.senderName}</b>{message.kind === 'image' ? <img src={message.dataUrl} alt={message.body || 'media'} /> : message.kind === 'audio' ? <span>🎙️ {message.body}</span> : <span>{message.body}</span>}</div>)}
  </main>;
}

function VoiceMessagePlayer({ message }: { message: ChatMessage }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const waveform = message.waveform?.length ? message.waveform : Array.from({ length: 36 }, () => 0.22);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    const onTime = () => setProgress(audio.duration > 0 ? Math.min(1, audio.currentTime / audio.duration) : 0);
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    const onEnded = () => {
      audio.currentTime = 0;
      setProgress(0);
      setPlaying(false);
      if (currentVoiceMessageAudio === audio) currentVoiceMessageAudio = null;
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('ended', onEnded);
      if (currentVoiceMessageAudio === audio) currentVoiceMessageAudio = null;
    };
  }, [message.dataUrl]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (currentVoiceMessageAudio && currentVoiceMessageAudio !== audio) {
      try { currentVoiceMessageAudio.pause(); } catch { /* ignore */ }
    }
    currentVoiceMessageAudio = audio;
    audio.play().catch(() => undefined);
  };

  return <div className="voice-message old-voice-message">
    <button className={`voice-play-button ${playing ? 'playing' : ''}`} onClick={toggle} aria-label={playing ? 'Stop voice message' : 'Play voice message'} title={playing ? 'Stop' : 'Play'}>▶</button>
    <div className="waveform voice-waveform" style={{ '--voice-progress': progress } as CSSProperties}>
      {waveform.map((bar, index) => <i key={index} className={index / Math.max(1, waveform.length - 1) <= progress ? 'played' : ''} style={{ height: `${Math.max(8, Math.round(bar * 34))}px` }} />)}
    </div>
    <audio ref={audioRef} className="hidden-audio voice-message-audio" src={message.dataUrl} preload="metadata" controls={false} hidden aria-hidden="true" tabIndex={-1} style={{ display: 'none' }} />
  </div>;
}

function mediaSrcFromMessage(message: ChatMessage): string | undefined {
  if (message.dataUrl) return message.dataUrl;
  if (message.localPath) return convertFileSrc(message.localPath);
  return undefined;
}

function renderMessageContent(message: ChatMessage, args?: { onImageOpen?: (preview: ImagePreview) => void; onMediaContextMenu?: (event: ReactMouseEvent<HTMLElement>, media: MediaPreview) => void; onFileMenu?: (event: ReactMouseEvent<HTMLElement>, message: ChatMessage) => void; onRetryFile?: (message: ChatMessage) => void; onCancelFile?: (message: ChatMessage) => void; t?: (key: string) => string }) {
  if (message.deletedAt) return <p className="deleted-message">{args?.t?.('deletedMessage') || 'Message deleted'}</p>;
  const mediaSrc = mediaSrcFromMessage(message);
  const transferStatus = message.fileStatus;
  const canCancelTransfer = Boolean(transferStatus && ['queued', 'preparing', 'sending', 'receiving', 'retrying'].includes(transferStatus));
  const transferState = transferStatus && transferStatus !== 'completed'
    ? <div className={`media-transfer-state ${transferStatus}`}>
        <span>{args?.t?.(`status_${transferStatus}`) || transferStatus}</span>
        {message.fileError && <small>{message.fileError}</small>}
        {canCancelTransfer && <button className="cancel-transfer-btn" onClick={() => args?.onCancelFile?.(message)}>{args?.t?.('stopTransfer') || 'Stop transfer'}</button>}
        {transferStatus === 'failed' && message.sender === 'me' && message.retryable && <button onClick={() => args?.onRetryFile?.(message)}>{args?.t?.('retry') || 'Retry'}</button>}
      </div>
    : null;
  const isVoiceMessage = Boolean(message.dataUrl) && (message.kind === 'audio' || Boolean(message.waveform?.length) || Boolean(message.mimeType?.startsWith('audio/')) || /^voice-\d+\.webm$/i.test(message.fileName || ''));
  if (isVoiceMessage) return <VoiceMessagePlayer message={message} />;
  const isImageMessage = message.kind === 'image' || Boolean(message.mimeType?.startsWith('image/'));
  const isVideoMessage = message.kind === 'video' || Boolean(message.mimeType?.startsWith('video/')) || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(message.fileName || '');
  if (isImageMessage && mediaSrc) {
    const media: MediaPreview = { src: mediaSrc, name: message.fileName, kind: 'image', localPath: message.localPath };
    return <div className="chat-media-transfer"><button className="media-open image-context-target" data-image-context="true" onClick={() => args?.onImageOpen?.({ src: mediaSrc, name: message.fileName })} onContextMenu={(event) => args?.onMediaContextMenu?.(event, media)} title={args?.t?.('openImage') || 'Open image'}><img className="chat-media" src={mediaSrc} alt={message.fileName || 'image'} /></button>{transferState}</div>;
  }
  if (isVideoMessage && mediaSrc) {
    return <div className="chat-media-transfer"><div className="chat-video-wrap"><video className="chat-media chat-video-player" src={mediaSrc} controls playsInline preload="metadata" /></div>{transferState}</div>;
  }
  if (message.localPath || message.transferId || typeof message.fileSize === 'number') {
    const status = message.fileStatus || (message.localPath ? 'completed' : 'sending');
    const progress = Math.max(0, Math.min(100, Number(message.uploadProgress || (status === 'completed' ? 100 : 0))));
    return <div className={`file-transfer-card ${status}`}>
      <div className="file-transfer-head"><strong>{message.fileName || message.body || (args?.t?.('fileLabel') || 'file')}</strong>{status === 'completed' && <button className="file-kebab" aria-label={args?.t?.('fileActions') || 'File actions'} title={args?.t?.('fileActions') || 'File actions'} onClick={(event) => args?.onFileMenu?.(event, message)}>⋮</button>}</div>
      <small>{formatBytes(message.transferredBytes || 0)} / {formatBytes(message.fileSize || 0)} • {args?.t?.(`status_${status}`) || status}</small>
      {status !== 'completed' && <div className="file-progress"><i style={{ width: `${progress}%` }} /></div>}
      {message.fileError && <small className="file-transfer-error">{message.fileError}</small>}
      {canCancelTransfer && <button className="cancel-transfer-btn" onClick={() => args?.onCancelFile?.(message)}>{args?.t?.('stopTransfer') || 'Stop transfer'}</button>}
      {status === 'failed' && message.sender === 'me' && message.retryable && <button onClick={() => args?.onRetryFile?.(message)}>{args?.t?.('retry') || 'Retry'}</button>}
      {message.localPath && status === 'completed' && <button onClick={() => invoke('open_received_file', { path: message.localPath }).catch(() => undefined)}>{args?.t?.('openFile') || 'Open'}</button>}
    </div>;
  }
  if (message.kind === 'file' && message.dataUrl) return <div className="file-transfer-card completed"><div className="file-transfer-head"><a className="file-link" href={message.dataUrl} download={message.fileName || 'file'}>{message.fileName || 'file'}</a><button className="file-kebab" aria-label={args?.t?.('fileActions') || 'File actions'} title={args?.t?.('fileActions') || 'File actions'} onClick={(event) => args?.onFileMenu?.(event, message)}>⋮</button></div></div>;
  const preview = message.linkPreview || linkPreviewFromText(message.body);
  return <div className="text-with-preview"><p>{message.body}</p>{preview && <a className="link-preview-card" href={preview.url} target="_blank" rel="noreferrer">{preview.image && <img src={preview.image} alt="thumbnail" />}<span><b>{preview.title}</b><small>{preview.provider || preview.url}</small></span></a>}</div>;
}

function peerInitial(peer?: PeerProfile | null) {
  return (peer?.displayName || 'M').slice(0, 1).toUpperCase();
}

export default function App() {
  if (new URLSearchParams(window.location.search).get('overlay') === 'chat') return <ChatOverlayWindow />;
  const queryClient = useQueryClient();
  const roomRef = useRef<RoomSession | null>(null);
  const activeRoomIdRef = useRef('');
  const commandGateRef = useRef(new AsyncCommandGate());
  const activeVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaBoxRef = useRef<HTMLDivElement | null>(null);
  const joinBellRef = useRef<HTMLButtonElement | null>(null);
  const joinPopoverRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderReleaseRef = useRef<(() => void) | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const companionVoiceRecordingIdRef = useRef('');
  const voiceRecordStopRequestedRef = useRef(false);
  const voiceRecordStopInFlightRef = useRef(false);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const typingTimersRef = useRef<Record<string, number>>({});
  const typingStopTimerRef = useRef<number | null>(null);
  const lastTypingSentRef = useRef(0);
  const previousPeerIdsRef = useRef<Set<string>>(new Set());
  const closedStreamPeersRef = useRef<Set<string>>(new Set());
  const updaterAutoCheckedRef = useRef(false);
  const pendingUpdateRef = useRef<any | null>(null);
  const micTestUnlistenRef = useRef<(() => void) | null>(null);
  const micTestErrorUnlistenRef = useRef<(() => void) | null>(null);
  const autoOpenedJoinRequestIdsRef = useRef<Set<string>>(new Set());
  const pendingAttachmentKeysRef = useRef<Set<string>>(new Set());
  const outgoingAttachmentSourcesRef = useRef<Map<string, OutgoingAttachmentSource>>(new Map());
  const canceledAttachmentIdsRef = useRef<Set<string>>(new Set());
  const attachmentReceiptTimersRef = useRef<Map<string, number>>(new Map());
  const sendingAttachmentsRef = useRef(false);
  const shutdownInProgressRef = useRef(false);
  const allowWindowCloseRef = useRef(false);
  const chatOverlayWindowRef = useRef<WebviewWindow | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraDragRef = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; start: CameraBox } | null>(null);
  const isRoomOwnerRef = useRef(false);
  const micEnabledRef = useRef(false);
  const voiceActiveRef = useRef(false);
  const forcedMutedByAdminRef = useRef(false);
  const preForcedLocalMicEnabledRef = useRef<boolean | null>(null);
  const globalMuteSnapshotRef = useRef<Record<string, boolean> | null>(null);
  const globalMuteActiveRef = useRef(false);
  const seenReceiptSentRef = useRef<Set<string>>(new Set());
  const receivedMessageIdsRef = useRef(new BoundedMessageIdCache(5_000));
  const messagesRef = useRef<ChatMessage[]>([]);
  const outboxFlushInFlightRef = useRef(false);
  const outboxAckChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const historySyncedPeerIdsRef = useRef<Set<string>>(new Set());
  const micPromptShownForRoomRef = useRef(false);
  const cameraWithStreamArmedRef = useRef(false);
  const cameraOverlayStartPromiseRef = useRef<Promise<MediaStream | null> | null>(null);
  const screenRecorderControllerRef = useRef<ScreenRecorderController | null>(null);
  const screenRecorderAutoStreamIdRef = useRef('');
  const screenRecorderManualStartRef = useRef(false);
  const screenRecorderResumeSessionRef = useRef('');
  const screenRecorderPriorOutputDeviceRef = useRef<string | null>(null);
  const registeredGlobalHotkeysRef = useRef<Set<string>>(new Set());
  const hotkeyRegistrationGenerationRef = useRef(0);
  const hotkeyActionHandlerRef = useRef<(action: HotkeyAction) => void>(() => undefined);
  const voiceRecordStartInFlightRef = useRef(false);
  const overlayInteractiveRef = useRef(DEFAULT_SETTINGS.chatOverlay.interactive);
  const lastPublishedProfileAssetRef = useRef('');

  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [settings, setSettingsState] = useState<AppSettings | null>(null);
  const [draftSettings, setDraftSettings] = useState<AppSettings | null>(null);
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }>({ inputs: [], outputs: [], cameras: [] });
  const [roomId, setRoomId] = useState('');
  const [roomCopied, setRoomCopied] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [connectionLabel, setConnectionLabel] = useState('state_idle');
  const [peers, setPeers] = useState<Record<string, PeerProfile>>({});
  const [profileAssetAccess, setProfileAssetAccess] = useState<ProfileAssetAccess | null>(null);
  const [peerMedia, setPeerMedia] = useState<Record<string, { micEnabled: boolean; screenSharing: boolean; cameraSharing?: boolean }>>({});
  const [screenStreams, setScreenStreams] = useState<Record<string, MediaStream>>({});
  const [peerVolumes, setPeerVolumes] = useState<Record<string, PeerVolume>>({});
  const [activePeerId, setActivePeerId] = useState('');
  const [privateTarget, setPrivateTarget] = useState<string>('');
  const [peerMenuId, setPeerMenuId] = useState<string>('');
  const [voiceActive, setVoiceActive] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [selectedProfilePeerId, setSelectedProfilePeerId] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [windowFocused, setWindowFocused] = useState(true);
  const [localPeerId, setLocalPeerId] = useState('');
  const [isRoomOwner, setIsRoomOwner] = useState(false);
  const [ownerPeerId, setOwnerPeerId] = useState('');
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [highlightedMessageId, setHighlightedMessageId] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [mediaContextMenu, setMediaContextMenu] = useState<MediaContextMenu | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenu | null>(null);
  const [fileSaveProgress, setFileSaveProgress] = useState<FileSaveProgress | null>(null);
  const [selfMediaMenu, setSelfMediaMenu] = useState<SelfMediaMenu | null>(null);
  const [selfPreviewOpen, setSelfPreviewOpen] = useState(false);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('voice');
  const [bannedMembers, setBannedMembers] = useState<BannedMember[]>([]);
  const [banModalOpen, setBanModalOpen] = useState(false);
  const [speakingPeers, setSpeakingPeers] = useState<Record<string, boolean>>({});
  const [joinRequests, setJoinRequests] = useState<Record<string, JoinRequest>>({});
  const [joinRequestsOpen, setJoinRequestsOpen] = useState(false);
  const [roomRoles, setRoomRoles] = useState<Record<string, RoomRole>>({});
  const [pendingVoice, setPendingVoice] = useState<PendingVoiceMessage | null>(null);
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [learningHotkey, setLearningHotkey] = useState<HotkeyAction | null>(null);
  const [hotkeyDraft, setHotkeyDraft] = useState<Record<HotkeyAction, string>>({ ...DEFAULT_HOTKEYS });
  const [hotkeyValidationError, setHotkeyValidationError] = useState('');
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [errorLog, setErrorLog] = useState<LogEntry[]>(() => loadDiagnostics());
  const [streamVolumeOpen, setStreamVolumeOpen] = useState(false);
  const [pipPeerId, setPipPeerId] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState('');
  const [requiredUpdate, setRequiredUpdate] = useState<{ version: string; notes: string } | null>(null);
  const [updateGateChecked, setUpdateGateChecked] = useState(false);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [streamRefreshTokens, setStreamRefreshTokens] = useState<Record<string, number>>({});
  const [voiceEngineStatus, setVoiceEngineStatus] = useState<VoiceEngineStatus | null>(null);
  const [chatOverlayOpen, setChatOverlayOpen] = useState(false);
  const [chatOverlayExternal, setChatOverlayExternal] = useState(false);
  const [overlayEditorOpen, setOverlayEditorOpen] = useState(false);
  const [overlayDraft, setOverlayDraft] = useState<ChatOverlaySettings | null>(null);
  const [overlayMonitors, setOverlayMonitors] = useState<Array<{ name: string; label: string }>>([]);
  const [cameraSettingsOpen, setCameraSettingsOpen] = useState(false);
  const [cameraModeChoiceOpen, setCameraModeChoiceOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<'camera-only' | 'camera-with-stream'>('camera-only');
  const [cameraDraft, setCameraDraft] = useState<CameraOverlaySettings | null>(null);
  const [cameraCustomizationMode, setCameraCustomizationMode] = useState<'resize' | 'crop'>('resize');
  const [activeMediaMode, setActiveMediaMode] = useState<'screen' | 'camera'>('screen');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraWithStreamArmed, setCameraWithStreamArmed] = useState(false);
  const [screenRecorderOpen, setScreenRecorderOpen] = useState(false);
  const [screenRecorderDraft, setScreenRecorderDraft] = useState<ScreenRecorderSettings>({ ...DEFAULT_SCREEN_RECORDER });
  const [screenRecorderState, setScreenRecorderState] = useState<ScreenRecorderRuntimeState>('idle');
  const [screenRecorderInfo, setScreenRecorderInfo] = useState<ScreenRecorderSourceInfo | null>(null);
  const [screenRecorderBytes, setScreenRecorderBytes] = useState(0);
  const [screenRecorderElapsed, setScreenRecorderElapsed] = useState(0);
  const [screenRecorderSavedPath, setScreenRecorderSavedPath] = useState('');
  const [screenRecorderPlayerOpen, setScreenRecorderPlayerOpen] = useState(false);
  const [screenRecorderError, setScreenRecorderError] = useState('');
  const [screenRecorderArmed, setScreenRecorderArmed] = useState(false);
  const [screenRecorderRecoveryOpen, setScreenRecorderRecoveryOpen] = useState(false);
  const [recoverableScreenRecordings, setRecoverableScreenRecordings] = useState<RecoverableScreenRecording[]>([]);
  const [screenRecorderRecoveryBusy, setScreenRecorderRecoveryBusy] = useState('');
  const [screenRecorderDependency, setScreenRecorderDependency] = useState<RecorderDependencyStatus>({ state: 'missing', message: '' });
  const [screenRecorderLevels, setScreenRecorderLevels] = useState<ScreenRecorderAudioLevels>({ mic: 0, members: 0, system: 0, mixed: 0 });
  const [screenRecorderFinalization, setScreenRecorderFinalization] = useState('');
  const [micJoinPromptOpen, setMicJoinPromptOpen] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraSetupPreviewStream, setCameraSetupPreviewStream] = useState<MediaStream | null>(null);
  const [cameraStreams, setCameraStreams] = useState<Record<string, MediaStream>>({});
  const [cameraBox, setCameraBox] = useState<CameraBox>({ x: DEFAULT_CAMERA_OVERLAY.xPercent, y: DEFAULT_CAMERA_OVERLAY.yPercent, width: DEFAULT_CAMERA_OVERLAY.widthPercent, height: DEFAULT_CAMERA_OVERLAY.heightPercent });
  const [adminMutedPeers, setAdminMutedPeers] = useState<Record<string, boolean>>({});
  const [forcedMutedByAdmin, setForcedMutedByAdmin] = useState(false);
  const [globalMuteActive, setGlobalMuteActive] = useState(false);
  const [speakRequests, setSpeakRequests] = useState<Record<string, SpeakRequest>>({});
  const [raiseHandLastAt, setRaiseHandLastAt] = useState(0);
  const [voiceProfile, setVoiceProfile] = useState<'high' | 'balanced' | 'low'>('balanced');
  const [voicePressure, setVoicePressure] = useState<'normal' | 'pressure' | 'severe'>('normal');
  const voicePressureRef = useRef<'normal' | 'pressure' | 'severe'>('normal');
  const lastOverlayPublishRef = useRef(0);
  const cameraReducedForVoiceRef = useRef(false);
  const speakingTimersRef = useRef<Record<string, number>>({});

  const activeSettings = useMemo(() => settings ? applyLowMode(settings) : null, [settings]);
  const hotkeysDirty = useMemo(
    () => JSON.stringify(hotkeyDraft) !== JSON.stringify(settings?.hotkeys || DEFAULT_HOTKEYS),
    [hotkeyDraft, settings?.hotkeys]
  );
  const selectedInputLabel = useCallback((deviceId?: string) => devices.inputs.find((device) => device.deviceId === deviceId)?.label || '', [devices.inputs]);
  const selectedOutputLabel = useCallback((deviceId?: string) => devices.outputs.find((device) => device.deviceId === deviceId)?.label || '', [devices.outputs]);
  const startRoomVoice = useCallback((room: RoomSession) => room.startVoice(
    activeSettings?.audioInputId || undefined,
    activeSettings?.audioOutputId || undefined,
    selectedInputLabel(activeSettings?.audioInputId),
    selectedOutputLabel(activeSettings?.audioOutputId),
    Boolean(activeSettings?.voiceEnhanceEnabled)
  ), [activeSettings?.audioInputId, activeSettings?.audioOutputId, activeSettings?.voiceEnhanceEnabled, selectedInputLabel, selectedOutputLabel]);

  const t = (key: string) => TEXT[key] ?? key;
  const peerList = useMemo(() => Object.values(peers), [peers]);
  const selectedProfilePeer = selectedProfilePeerId ? peers[selectedProfilePeerId] || null : null;
  const profileAssetDescriptors = useMemo(
    () => peerList.map((peer) => ({ peerId: peer.peerId, avatarVersion: peer.avatarVersion })).sort((left, right) => left.peerId.localeCompare(right.peerId)),
    [peerList]
  );
  const profileAssetSignature = useMemo(
    () => profileAssetDescriptors.map((peer) => `${peer.peerId}:${peer.avatarVersion || 'none'}`).join('|'),
    [profileAssetDescriptors]
  );
  const profileAssetsQuery = useQuery({
    queryKey: ['profile-assets', roomId, profileAssetAccess?.generation || 0, profileAssetSignature],
    queryFn: ({ signal }) => fetchProfileAssets(profileAssetAccess!, profileAssetDescriptors, signal),
    enabled: Boolean(profileAssetAccess && profileAssetDescriptors.length > 0),
    staleTime: Number.POSITIVE_INFINITY
  });
  const publishProfileAssetMutation = useMutation({
    mutationFn: (input: { access: ProfileAssetAccess; avatar: string | null; version: string }) => publishProfileAvatar(input.access, input.avatar, input.version),
    retry: (failureCount, error) => failureCount < 2 && (error instanceof TypeError || /failed to fetch/i.test(String((error as Error)?.message || error))),
    retryDelay: (attempt) => Math.min(2500, 500 * (2 ** attempt))
  });

  useEffect(() => {
    const assets = profileAssetsQuery.data;
    if (!assets) return;
    setPeers((current) => {
      let changed = false;
      const next: Record<string, PeerProfile> = {};
      for (const [peerId, peer] of Object.entries(current)) {
        const asset = assets[peerId];
        const avatar = asset && asset.version === peer.avatarVersion ? asset.avatar : null;
        const peerChanged = (peer.avatar || null) !== avatar;
        if (peerChanged) changed = true;
        next[peerId] = peerChanged ? { ...peer, avatar } : peer;
      }
      return changed ? next : current;
    });
  }, [profileAssetsQuery.data]);

  useEffect(() => {
    if (!profileAssetAccess || !profile) return;
    const version = profileAvatarVersion(profile.avatar_data_url);
    const publishKey = `${profileAssetAccess.endpointUrl}|${profileAssetAccess.generation}|${version}`;
    if (lastPublishedProfileAssetRef.current === publishKey) return;
    lastPublishedProfileAssetRef.current = publishKey;
    publishProfileAssetMutation.mutate(
      { access: profileAssetAccess, avatar: profile.avatar_data_url, version },
      {
        onSuccess: () => {
          roomRef.current?.announceProfile();
          queryClient.invalidateQueries({ queryKey: ['profile-assets', roomId] }).catch(() => undefined);
        },
        onError: (error) => {
          lastPublishedProfileAssetRef.current = '';
          addLog(`Profile asset publish failed: ${String((error as Error)?.message || error)}`, 'error');
        }
      }
    );
  }, [profileAssetAccess, profile?.avatar_data_url, publishProfileAssetMutation, profile, queryClient, roomId]);
  const displayConnectionLabel = t(connectionLabel) || t(`state_${connection}`) || connectionLabel;
  const typingNames = Object.values(typingUsers);
  const activePeer = activePeerId ? peers[activePeerId] : undefined;
  const activeStream = activePeer?.peerId ? (activeMediaMode === 'camera' ? cameraStreams[activePeer.peerId] : screenStreams[activePeer.peerId]) : undefined;
  const activeHasScreen = activePeer?.peerId ? Boolean(peerMedia[activePeer.peerId]?.screenSharing && screenStreams[activePeer.peerId]?.getVideoTracks().some((track) => track.readyState === 'live')) : false;
  const activeHasCamera = activePeer?.peerId ? Boolean(peerMedia[activePeer.peerId]?.cameraSharing && cameraStreams[activePeer.peerId]?.getVideoTracks().some((track) => track.readyState === 'live')) : false;
  const activeHasMedia = activeMediaMode === 'camera' ? activeHasCamera : activeHasScreen;
  const streamViewerOpen = Boolean(activePeerId && activeHasMedia);
  const activeScreenAudioPeerId = streamViewerOpen && activeMediaMode === 'screen' ? activePeerId : '';
  const localCameraPanelOpen = false;
  const mediaPanelOpen = streamViewerOpen;
  const streamingPeerIds = useMemo(() => peerList.filter((peer) => peerMedia[peer.peerId]?.screenSharing || peerMedia[peer.peerId]?.cameraSharing).map((peer) => peer.peerId), [peerList, peerMedia]);
  const activePeerVolume = activePeer?.peerId ? (peerVolumes[activePeer.peerId] || defaultVolume()) : defaultVolume();
  const canModerate = isRoomOwner || roomRoles[localPeerId] === 'moderator';
  const waitingForApproval = roomId && connectionLabel === 'state_waiting_approval';
  const overlayMessages = useMemo<OverlayMessageItem[]>(() => {
    const config = settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay;
    const protectVoice = voicePressure !== 'normal';
    const visibleLimit = protectVoice ? 3 : 5;
    return messages.filter((message) => {
      if (message.sender === 'system' || message.deletedAt) return false;
      const kind = message.kind || 'text';
      if (kind === 'text') return config.showText;
      if (kind === 'image') return config.showImages;
      if (kind === 'audio') return config.showAudio;
      return config.showText;
    }).slice(-visibleLimit).map((message) => {
      const kind = message.kind || 'text';
      const shouldRenderMedia = !protectVoice && kind === 'image';
      return {
        senderName: message.senderName,
        body: kind === 'audio' ? (message.fileName || 'Voice message') : kind === 'image' ? (message.body || 'Media') : message.body,
        kind: protectVoice && kind === 'image' ? 'text' : kind,
        dataUrl: shouldRenderMedia ? message.dataUrl : undefined
      };
    });
  }, [messages, settings?.chatOverlay, voicePressure]);
  const availableQualityOptions = useMemo(() => qualityOptionsForScreen(), []);
  const availableFpsOptions = useMemo(() => fpsOptionsForScreen(), []);
  const availableRecorderResolutions = useMemo(() => {
    const trackSettings = localScreenStream?.getVideoTracks()[0]?.getSettings();
    const width = Number(trackSettings?.width || window.screen.width || 1920);
    const height = Number(trackSettings?.height || window.screen.height || 1080);
    return supportedRecorderResolutions(width, height);
  }, [localScreenStream, screenRecorderOpen]);
  const settingsForm = draftSettings || settings || DEFAULT_SETTINGS;
  const settingsDirty = Boolean(settings && JSON.stringify(settingsForm) !== JSON.stringify(settings));
  useEffect(() => {
    if (!screenRecorderOpen && settings?.screenRecorder) setScreenRecorderDraft({ ...settings.screenRecorder });
  }, [settings?.screenRecorder, screenRecorderOpen]);

  useEffect(() => {
    if (!cameraSettingsOpen) setCameraCustomizationMode('resize');
  }, [cameraSettingsOpen]);

  useEffect(() => {
    if (!screenRecorderOpen || availableRecorderResolutions.includes(screenRecorderDraft.resolution || 'auto')) return;
    setScreenRecorderDraft((current) => ({ ...current, resolution: 'auto' }));
  }, [availableRecorderResolutions, screenRecorderDraft.resolution, screenRecorderOpen]);

  useEffect(() => {
    if (!['recording', 'paused'].includes(screenRecorderState)) return;
    screenRecorderControllerRef.current?.updateAudioMix(screenRecorderDraft);
  }, [
    screenRecorderState,
    screenRecorderDraft.includeMic,
    screenRecorderDraft.includeMembers,
    screenRecorderDraft.includeSystem,
    screenRecorderDraft.micVolume,
    screenRecorderDraft.membersVolume,
    screenRecorderDraft.systemVolume,
    screenRecorderDraft.autoDuckSystem
  ]);

  useEffect(() => {
    if (screenRecorderState !== 'recording') return;
    const timer = window.setInterval(() => setScreenRecorderElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [screenRecorderState]);

  useEffect(() => {
    roomRef.current?.setRecordingActive(['starting', 'recording', 'paused', 'stopping'].includes(screenRecorderState));
  }, [screenRecorderState]);

  useEffect(() => {
    const stream = localScreenStream || roomRef.current?.getLocalScreenStream() || null;
    if (!screenSharing || !stream) {
      screenRecorderAutoStreamIdRef.current = '';
      if (screenRecorderState === 'recording' || screenRecorderState === 'paused') {
        stopScreenRecording(true).catch(() => undefined);
      }
      return;
    }
    // A manual toolbar click owns this start cycle. This prevents auto-start from racing it.
    if (screenRecorderManualStartRef.current || screenRecorderArmed) return;
    if (cameraWithStreamArmedRef.current && !cameraOpen) return;
    if (!settings?.screenRecorder?.autoStart) return;
    const streamId = stream.id || stream.getVideoTracks()[0]?.id || 'screen';
    if (screenRecorderAutoStreamIdRef.current === streamId) return;
    if (screenRecorderState !== 'idle' && screenRecorderState !== 'error') return;
    screenRecorderAutoStreamIdRef.current = streamId;
    setScreenRecorderDraft({ ...settings.screenRecorder });
    startScreenRecording(settings.screenRecorder, '', stream).catch(() => undefined);
  }, [screenSharing, localScreenStream, settings?.screenRecorder, screenRecorderState, screenRecorderArmed, cameraOpen]);

  useEffect(() => {
    let cancelled = false;
    prepareScreenRecorderDependencies()
      .then((status) => { if (!cancelled) setScreenRecorderDependency(status); })
      .catch(() => undefined);
    listRecoverableScreenRecordings()
      .then((items) => { if (!cancelled) setRecoverableScreenRecordings(items); })
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      getScreenRecorderDependencyStatus()
        .then((status) => {
          if (cancelled) return;
          setScreenRecorderDependency(status);
          if (status.state === 'ready' || status.state === 'error') window.clearInterval(timer);
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => () => {
    const controller = screenRecorderControllerRef.current;
    if (controller && controller.getState() !== 'idle') controller.preserve().catch(() => undefined);
  }, []);
  useEffect(() => { isRoomOwnerRef.current = isRoomOwner; }, [isRoomOwner]);
  useEffect(() => { micEnabledRef.current = micEnabled; }, [micEnabled]);
  useEffect(() => { voiceActiveRef.current = voiceActive; }, [voiceActive]);
  useEffect(() => { forcedMutedByAdminRef.current = forcedMutedByAdmin; }, [forcedMutedByAdmin]);
  useEffect(() => {
    if (chatOverlayOpen && chatOverlayExternal) {
      const minInterval = voicePressure === 'normal' ? 250 : 1500;
      const now = Date.now();
      if (now - lastOverlayPublishRef.current < minInterval) return;
      lastOverlayPublishRef.current = now;
      emit('mhlko://chat-overlay-update', overlayMessages).catch(() => undefined);
      emit('mhlko://chat-overlay-settings', settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay).catch(() => undefined);
    }
  }, [chatOverlayOpen, chatOverlayExternal, overlayMessages, settings?.chatOverlay, voicePressure]);

  useEffect(() => {
    if (!cameraOpen || !cameraStream) return;
    const track = cameraStream.getVideoTracks()[0];
    if (!track) return;
    if (voicePressure !== 'normal' && !cameraReducedForVoiceRef.current) {
      cameraReducedForVoiceRef.current = true;
      const severe = voicePressure === 'severe';
      track.applyConstraints({ width: { ideal: severe ? 160 : 320 }, height: { ideal: severe ? 90 : 180 }, frameRate: { ideal: severe ? 8 : 12, max: severe ? 8 : 12 } }).catch(() => undefined);
      addLog('Camera overlay reduced to protect microphone voice priority.', 'info');
    } else if (voicePressure === 'normal' && cameraReducedForVoiceRef.current) {
      cameraReducedForVoiceRef.current = false;
      // Return to source/default behavior instead of forcing a heavy camera mode.
      track.applyConstraints({}).catch(() => undefined);
      addLog('Camera overlay returned to source-default behavior after voice pressure cleared.', 'info');
    }
  }, [voicePressure, cameraOpen, cameraStream]);


  useEffect(() => {
    if (screenSharing && cameraWithStreamArmedRef.current && !cameraOpen) {
      ensureCameraWithStreamOverlay().catch(() => undefined);
    }
    if (!screenSharing && cameraMode === 'camera-with-stream' && cameraOpen) {
      toggleCameraOverlay('camera-with-stream').catch(() => undefined);
    }
  }, [screenSharing]);

  useEffect(() => {
    if (voicePressure === 'normal' && screenSharing && activeSettings) {
      roomRef.current?.updateScreenQuality(activeSettings.screenQuality, activeSettings.screenFps).catch(() => undefined);
    }
  }, [voicePressure, screenSharing, activeSettings?.screenQuality, activeSettings?.screenFps]);

  useEffect(() => {
    if (settings?.cameraOverlay) {
      const cam = clampCameraSettings(settings.cameraOverlay);
      setCameraBox({ x: cam.xPercent, y: cam.yPercent, width: cam.widthPercent, height: cam.heightPercent });
    }
  }, [settings?.cameraOverlay]);

  useEffect(() => {
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = cameraStream;
    if (cameraStream && cameraOpen) cameraVideoRef.current?.play().catch(() => undefined);
  }, [cameraStream, cameraOpen]);

  useEffect(() => () => {
    try { cameraStream?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
  }, [cameraStream]);

  function speakingColor(peerId: string) {
    const palette = ['#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#a855f7', '#3b82f6', '#84cc16'];
    let hash = 0;
    for (const char of peerId || 'local') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return palette[hash % palette.length];
  }

  const updateSpeaking = useCallback((peerId: string, active: boolean) => {
    if (!peerId) return;
    const timers = speakingTimersRef.current;
    if (timers[peerId]) {
      window.clearTimeout(timers[peerId]);
      delete timers[peerId];
    }
    setSpeakingPeers((current) => current[peerId] === active ? current : { ...current, [peerId]: active });
    if (active) {
      timers[peerId] = window.setTimeout(() => {
        delete timers[peerId];
        setSpeakingPeers((current) => current[peerId] ? { ...current, [peerId]: false } : current);
      }, 850);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await initDb();
        const [loadedProfile, loadedSettings] = await Promise.all([loadProfile(), loadSettings()]);
        setProfile(loadedProfile);
        setSettingsState(loadedSettings);
        setDevices(await listMediaDevices());
        setReady(true);
      } catch (error) {
        setToast(TEXT.dataProblem ?? 'dataProblem');
        console.error(error);
      }
    })();

    return () => roomRef.current?.close();
  }, []);

  useEffect(() => { messagesRef.current = messages; chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    if (!roomId) return;
    const timer = window.setInterval(() => flushMessageOutbox(roomId), 5_000);
    return () => window.clearInterval(timer);
  }, [roomId]);
  useEffect(() => () => { Object.values(speakingTimersRef.current).forEach((timer) => window.clearTimeout(timer)); }, []);
  useEffect(() => {
    if (isRoomOwner && forcedMutedByAdmin) {
      setForcedMutedByAdmin(false);
      setMicEnabled(true);
      roomRef.current?.setMicEnabled(true);
      addLog('Admin forced mute state repaired', 'info');
    }
  }, [isRoomOwner, forcedMutedByAdmin]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    const onVisibilityChange = () => setWindowFocused(!document.hidden);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenClose: (() => void) | undefined;
    let unlistenTray: (() => void) | undefined;
    (async () => {
      unlistenClose = await getCurrentWindow().onCloseRequested(async (event) => {
        if (allowWindowCloseRef.current) return;
        event.preventDefault();
        await closeWindow(false);
      });
      unlistenTray = await listen('mhlko://tray-quit-requested', () => { closeWindow(false).catch(() => undefined); });
      if (disposed) {
        try { unlistenClose?.(); } catch { /* ignore */ }
        try { unlistenTray?.(); } catch { /* ignore */ }
      }
    })().catch(() => undefined);
    return () => {
      disposed = true;
      try { unlistenClose?.(); } catch { /* ignore */ }
      try { unlistenTray?.(); } catch { /* ignore */ }
    };
  }, [roomId]);


  useEffect(() => {
    setStreamVolumeOpen(false);
    if (pipPeerId && activePeerId !== pipPeerId) setPipPeerId('');
  }, [activePeerId]);

  useEffect(() => {
    if (screenSharing && activeSettings) roomRef.current?.updateScreenQuality(activeSettings.screenQuality, activeSettings.screenFps).catch(() => undefined);
  }, [activeSettings?.screenQuality, activeSettings?.screenFps, screenSharing]);

  useEffect(() => {
    if (settings?.notificationsEnabled) requestNotificationsIfNeeded(true);
  }, [settings?.notificationsEnabled]);

  useEffect(() => {
    if (settingsOpen && settings) setDraftSettings({ ...settings });
    if (!settingsOpen) setDraftSettings(null);
  }, [settingsOpen]);
  useEffect(() => {
    resizeComposerTextarea(messageInputRef.current);
  }, [draft]);


  useEffect(() => {
    if (!ready) return;
    invoke<VoiceEngineStatus>('voice_companion_status')
      .then((status) => setVoiceEngineStatus(status))
      .catch(() => setVoiceEngineStatus(null));
  }, [ready]);


  useEffect(() => {
    if (!ready || !settings) return;
    const enabled = Boolean(settings.voiceEnhanceEnabled);
    roomRef.current?.setVoiceEnhanceEnabled(enabled).catch((error) => addLog(String((error as Error)?.message || error || 'Voice Enhance error'), 'error'));
    setVoiceEngineStatus((current) => current ? { ...current, voiceEnhanceEnabled: enabled } : current);
  }, [ready, settings?.voiceEnhanceEnabled]);

  useEffect(() => {
    if (!ready || !settings) return;
    roomRef.current?.setVoiceOutputDevice(settings.audioOutputId || undefined).catch(() => undefined);
  }, [ready, settings?.audioOutputId]);

  useEffect(() => {
    if (!ready || updaterAutoCheckedRef.current) return;
    updaterAutoCheckedRef.current = true;
    const timer = window.setTimeout(() => {
      checkForUpdates(false).catch(() => { setUpdateGateChecked(true); });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [ready]);

  useEffect(() => () => stopMicTest(), []);

  useEffect(() => {
    if (!settingsOpen && !selfPreviewOpen && micTestActive) stopMicTest();
  }, [settingsOpen, selfPreviewOpen, micTestActive]);

  useEffect(() => {
    if (micTestActive) stopMicTest();
  }, [settings?.audioInputId, settings?.audioOutputId]);

  useEffect(() => () => {
    Object.values(typingTimersRef.current).forEach((timer) => window.clearTimeout(Number(timer)));
    if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
  }, []);

  useEffect(() => {
    const blockNativeContextMenu = (event: Event) => {
      // 0.7.6: Chromium/WebView native context entries (Back, Refresh, Save as,
      // Print, More tools, Inspect, etc.) must never leak into the app. The only
      // right-click menu we intentionally show is the app's custom image menu.
      event.preventDefault();
    };
    document.addEventListener('contextmenu', blockNativeContextMenu, true);
    return () => document.removeEventListener('contextmenu', blockNativeContextMenu, true);
  }, []);

  useEffect(() => {
    if (!mediaContextMenu && !fileContextMenu && !selfMediaMenu) return;
    const closeMenus = () => { setMediaContextMenu(null); setFileContextMenu(null); setSelfMediaMenu(null); };
    const closeOnEsc = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenus(); };
    document.addEventListener('mousedown', closeMenus);
    document.addEventListener('keydown', closeOnEsc);
    return () => {
      document.removeEventListener('mousedown', closeMenus);
      document.removeEventListener('keydown', closeOnEsc);
    };
  }, [mediaContextMenu, fileContextMenu, selfMediaMenu]);

  useEffect(() => subscribeDiagnostics((entry) => {
    setErrorLog((current) => current.some((item) => item.id === entry.id)
      ? current
      : [entry, ...current].slice(0, 300));
  }), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('mhlko://native-voice-info', (event) => addLog(String(event.payload || 'Native voice info'), 'info'))
      .then((fn) => { unlisten = fn; })
      .catch(() => undefined);
    return () => { try { unlisten?.(); } catch { /* ignore */ } };
  }, []);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenStage: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    listen<FileSaveProgress>('mhlko://file-save-progress', (event) => setFileSaveProgress(event.payload))
      .then((fn) => { unlistenProgress = fn; }).catch(() => undefined);
    listen<{ stage?: string; message?: string }>('mhlko://recording-finalization-stage', (event) => {
      const stageId = String(event.payload?.stage || 'unknown');
      const stage = String(event.payload?.message || stageId);
      setScreenRecorderFinalization(stage);
      addLog(`[recording:${stageId}] ${stage}`, 'info');
    }).then((fn) => { unlistenStage = fn; }).catch(() => undefined);
    listen<{ path?: string; size?: number }>('mhlko://recording-finalization-complete', (event) => {
      if (event.payload?.path) setScreenRecorderSavedPath(String(event.payload.path));
      if (Number.isFinite(Number(event.payload?.size))) setScreenRecorderBytes(Number(event.payload?.size));
      setScreenRecorderFinalization('');
      addLog(`[recording:complete] ${String(event.payload?.path || 'MP4 finalization complete')}`, 'info');
    }).then((fn) => { unlistenComplete = fn; }).catch(() => undefined);
    listen<{ message?: string; path?: string }>('mhlko://recording-finalization-error', (event) => {
      const message = String(event.payload?.message || 'MP4 finalization failed');
      setScreenRecorderFinalization('');
      addLog(`${message}${event.payload?.path ? ` • ${event.payload.path}` : ''}`, 'error');
    }).then((fn) => { unlistenError = fn; }).catch(() => undefined);
    return () => {
      for (const unlisten of [unlistenProgress, unlistenStage, unlistenComplete, unlistenError]) {
        try { unlisten?.(); } catch { /* ignore */ }
      }
    };
  }, []);

  useEffect(() => {
    overlayInteractiveRef.current = Boolean(settings?.chatOverlay?.interactive);
  }, [settings?.chatOverlay?.interactive]);

  useEffect(() => {
    if (!overlayEditorOpen) return;
    availableMonitors()
      .then((items) => setOverlayMonitors(items
        .filter((item) => Boolean(item.name))
        .map((item) => ({ name: String(item.name), label: String(item.name) }))))
      .catch(() => setOverlayMonitors([]));
  }, [overlayEditorOpen]);

  useEffect(() => {
    if (!cameraSettingsOpen || cameraOpen) {
      setCameraSetupPreviewStream((current) => {
        current?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
        return null;
      });
      return;
    }
    let cancelled = false;
    let preview: MediaStream | null = null;
    const deviceId = settingsForm.cameraInputId || undefined;
    navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? { deviceId: { ideal: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false
    }).then((stream) => {
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      preview = stream;
      setCameraSetupPreviewStream(stream);
    }).catch((error) => addLog(`Camera preview unavailable: ${String((error as Error)?.message || error)}`, 'error'));
    return () => {
      cancelled = true;
      preview?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
      setCameraSetupPreviewStream((current) => current === preview ? null : current);
    };
  }, [cameraSettingsOpen, cameraOpen, settingsForm.cameraInputId]);

  useEffect(() => {
    if (!joinRequestsOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (joinPopoverRef.current?.contains(target) || joinBellRef.current?.contains(target)) return;
      setJoinRequestsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setJoinRequestsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [joinRequestsOpen]);

  hotkeyActionHandlerRef.current = (action: HotkeyAction) => {
    if (document.hasFocus() && isTypingTarget(document.activeElement)) return;
    if (action === 'muteMic') toggleMicMute().catch(() => undefined);
    if (action === 'toggleScreen') toggleScreen().catch(() => undefined);
    if (action === 'endCall') leaveRoom(true).catch(() => undefined);
    if (action === 'toggleFullscreen') toggleFullscreen().catch(() => undefined);
    if (action === 'toggleSettings') setSettingsOpen((open) => !open);
    if (action === 'toggleOverlayMode') setDesktopOverlayInteractive(!overlayInteractiveRef.current).catch(() => undefined);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (learningHotkey || isTypingTarget(event.target)) return;
      const hotkeys: Record<HotkeyAction, string> = settings?.hotkeys || DEFAULT_HOTKEYS;
      const combo = formatHotkeyEvent(event);
      if (!combo) return;
      const matched = (Object.entries(hotkeys) as Array<[HotkeyAction, string]>).find(([, value]) => value && normalizeHotkeyCombo(value) === combo)?.[0];
      if (!matched) return;

      const nativeShortcut = toTauriShortcut(hotkeys[matched] || '');
      // When native global registration succeeded, its callback is the single source of
      // truth. This prevents a focused window from toggling the same action twice.
      if (nativeShortcut && registeredGlobalHotkeysRef.current.has(nativeShortcut)) return;

      event.preventDefault();
      hotkeyActionHandlerRef.current(matched);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settings?.hotkeys, learningHotkey]);

  useEffect(() => {
    const generation = ++hotkeyRegistrationGenerationRef.current;
    registeredGlobalHotkeysRef.current = new Set();

    const registerAll = async () => {
      // Registration is rebuilt as one atomic set. This prevents an older React
      // effect cleanup from unregistering shortcuts that a newer settings save
      // has just installed.
      await unregisterAllGlobalShortcuts().catch((error) => {
        addLog(`Could not clear previous global hotkeys: ${String((error as Error)?.message || error)}`, 'error');
      });
      if (hotkeyRegistrationGenerationRef.current !== generation) return;

      const seen = new Set<string>();
      for (const [action, combo] of Object.entries(settings?.hotkeys || DEFAULT_HOTKEYS) as Array<[HotkeyAction, string]>) {
        if (hotkeyRegistrationGenerationRef.current !== generation) return;
        const shortcut = toTauriShortcut(combo);
        if (!shortcut || seen.has(shortcut)) continue;
        seen.add(shortcut);
        try {
          await registerGlobalShortcut(shortcut, (event) => {
            if (event.state !== 'Pressed') return;
            hotkeyActionHandlerRef.current(action);
          });
          if (hotkeyRegistrationGenerationRef.current !== generation) {
            await unregisterGlobalShortcut(shortcut).catch(() => undefined);
            return;
          }
          registeredGlobalHotkeysRef.current.add(shortcut);
          addLog(`Global hotkey registered: ${action}=${shortcut}`, 'info');
        } catch (error) {
          addLog(`Global hotkey unavailable: ${action}=${shortcut}: ${String((error as Error)?.message || error)}`, 'error');
        }
      }
    };

    registerAll().catch((error) => addLog(`Global hotkey registration failed: ${String((error as Error)?.message || error)}`, 'error'));
    return () => {
      if (hotkeyRegistrationGenerationRef.current === generation) {
        hotkeyRegistrationGenerationRef.current += 1;
        registeredGlobalHotkeysRef.current = new Set();
      }
    };
  }, [settings?.hotkeys]);

  useEffect(() => () => {
    hotkeyRegistrationGenerationRef.current += 1;
    registeredGlobalHotkeysRef.current = new Set();
    unregisterAllGlobalShortcuts().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!learningHotkey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        setLearningHotkey(null);
        return;
      }
      const combo = normalizeHotkeyCombo(formatHotkeyEvent(event));
      if (!combo) return;
      const candidate = { ...hotkeyDraft, [learningHotkey]: combo };
      setHotkeyDraft(candidate);
      setHotkeyValidationError(validateHotkeyMap(candidate) || '');
      setLearningHotkey(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [learningHotkey, hotkeyDraft]);


  useEffect(() => {
    if (replyTo || editingMessage || privateTarget) {
      window.setTimeout(() => messageInputRef.current?.focus(), 20);
    }
  }, [replyTo, editingMessage, privateTarget]);

  function displayToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(''), 3500);
  }

  function showToast(message: string) {
    addLog(message, 'info');
    displayToast(message);
  }

  function addLog(message: string, level: LogEntry['level'] = 'info') {
    appendDiagnostic(message, level);
  }

  async function runGuardedCommand(command: string, action: () => Promise<void>): Promise<void> {
    if (!commandGateRef.current.tryEnter(command)) return;
    try {
      await action();
    } catch (error) {
      const message = String((error as Error)?.message || error || `${command} failed`);
      addLog(`${command}: ${message}`, 'error');
      displayToast(message);
    } finally {
      commandGateRef.current.leave(command);
    }
  }

  function logLevelText(level: LogEntry['level']) {
    return t(level === 'error' ? 'log_error' : 'log_info');
  }

  function localizeLogMessage(message: string) {
    const raw = String(message || '');
    const direct = TEXT[raw];
    if (direct) return direct;
    const common: Array<[RegExp, string]> = [
      [/^File transfer cancel requested$/i, t('fileFailed')],
      [/^Media download failed$/i, t('mediaDownloadFailed')],
      [/^Media copy failed$/i, t('mediaCopyFailed')],
      [/^Event log downloaded/i, t('logDownloaded')],
      [/^Camera share stopped/i, t('cameraStop')],
      [/^Starting camera share/i, t('cameraStart')],
      [/^Remote camera available/i, t('viewCamera')],
      [/^Remote camera ended/i, t('cameraStop')],
      [/^Stream switched/i, t('switchStream')],
      [/^Camera view switched/i, t('viewCamera')],
      [/^Voice output device fallback/i, t('defaultDevice')],
      [/^Oversized file rejected/i, t('attachmentRejected') || t('fileTooLarge')]
    ];
    for (const [pattern, label] of common) if (pattern.test(raw)) return label;
    return raw;
  }

  function openMediaContext(event: ReactMouseEvent<HTMLElement>, media: MediaPreview) {
    event.preventDefault();
    event.stopPropagation();
    if (media.kind !== 'image') return;
    setMediaContextMenu({ ...media, x: event.clientX, y: event.clientY });
  }

  function mediaDefaultName(media: MediaPreview) {
    const fallback = media.kind === 'video' ? 'mhlkotalk-video.mp4' : 'mhlkotalk-image.png';
    return (media.name || fallback).replace(/[\\/:*?"<>|]/g, '_');
  }

  async function downloadMediaToDesktop(media: MediaPreview) {
    try {
      const fileName = mediaDefaultName(media);
      if (media.localPath) await invoke('copy_file_to_desktop', { path: media.localPath, fileName });
      else await invoke('save_data_url_to_desktop', { fileName, dataUrl: await mediaSourceToDataUrl(media.src) });
      showToast(t('mediaSavedToDesktop'));
    } catch (error) {
      addLog(String((error as Error)?.message || error || 'Media download failed'), 'error');
      showToast(t('mediaDownloadFailed'));
    } finally {
      setMediaContextMenu(null);
    }
  }

  async function copyMediaToClipboard(media: MediaPreview) {
    try {
      if (media.kind === 'image' && 'ClipboardItem' in window) {
        const response = await fetch(media.src);
        const blob = await response.blob();
        const ClipboardItemClass = (window as typeof window & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
        if (ClipboardItemClass) {
          await navigator.clipboard.write([new ClipboardItemClass({ [blob.type || 'image/png']: blob })]);
          showToast(t('mediaCopied'));
          setMediaContextMenu(null);
          return;
        }
      }
      await navigator.clipboard.writeText(media.localPath || media.src);
      showToast(t('mediaCopied'));
    } catch (error) {
      addLog(String((error as Error)?.message || error || 'Media copy failed'), 'error');
      showToast(t('mediaCopyFailed'));
    } finally {
      setMediaContextMenu(null);
    }
  }

  function openFileContext(event: ReactMouseEvent<HTMLElement>, message: ChatMessage) {
    event.preventDefault();
    event.stopPropagation();
    const width = 250;
    const height = 190;
    setFileContextMenu({
      message,
      x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX)),
      y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY))
    });
  }

  function safeDownloadName(message: ChatMessage): string {
    const raw = message.fileName || message.body || 'MHTalk-file';
    const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
    return cleaned || 'MHTalk-file';
  }

  async function persistMessageFile(message: ChatMessage, mode: 'desktop' | 'save-as') {
    const fileName = safeDownloadName(message);
    const operationId = `file-save-${crypto.randomUUID()}`;
    setFileSaveProgress({ operationId, written: 0, total: Number(message.fileSize || 0), targetPath: '' });
    try {
      if (mode === 'desktop') {
        if (message.localPath) {
          await invoke<string>('copy_file_to_desktop', { path: message.localPath, fileName, operationId });
        } else if (message.dataUrl) {
          await invoke<string>('save_data_url_to_desktop', { fileName, dataUrl: message.dataUrl, operationId });
        } else {
          throw new Error('The completed file is not available locally.');
        }
      } else {
        const targetPath = await saveDialog({ title: t('saveAs'), defaultPath: fileName });
        if (!targetPath) {
          setFileSaveProgress(null);
          return;
        }
        if (message.localPath) {
          await invoke<string>('save_received_file_as', {
            sourcePath: message.localPath,
            targetPath,
            originalName: fileName,
            operationId,
            overwrite: true
          });
        } else if (message.dataUrl) {
          await invoke<string>('save_data_url_as', {
            dataUrl: message.dataUrl,
            targetPath,
            originalName: fileName,
            operationId,
            overwrite: true
          });
        } else {
          throw new Error('The completed file is not available locally.');
        }
      }
      showToast(t('fileSaved'));
      setFileContextMenu(null);
    } catch (error) {
      const messageText = String((error as Error)?.message || error || t('fileSaveFailed'));
      addLog(`File save failed: ${messageText}`, 'error');
      showToast(`${t('fileSaveFailed')}: ${messageText}`);
    } finally {
      window.setTimeout(() => setFileSaveProgress((current) => current?.operationId === operationId ? null : current), 800);
    }
  }

  function showError(message: string) {
    addLog(message, 'error');
    displayToast(message);
  }

  async function refreshRecoverableRecordings() {
    try {
      setRecoverableScreenRecordings(await listRecoverableScreenRecordings());
    } catch (error) {
      addLog(`Screen recorder recovery scan: ${String((error as Error)?.message || error)}`, 'error');
    }
  }

  async function restoreScreenRecorderOutputDevice(): Promise<void> {
    const prior = screenRecorderPriorOutputDeviceRef.current;
    screenRecorderPriorOutputDeviceRef.current = null;
    if (prior === null || !roomRef.current) return;
    try {
      await roomRef.current.setVoiceOutputDevice(prior || undefined);
      addLog(`[recording:audio-route] restored call output device ${prior || 'default'}`, 'info');
    } catch (error) {
      addLog(`[recording:audio-route] could not restore call output device: ${String((error as Error)?.message || error)}`, 'error');
    }
  }

  function configureScreenRecorderController(): ScreenRecorderController {
    if (!screenRecorderControllerRef.current) screenRecorderControllerRef.current = new ScreenRecorderController();
    screenRecorderControllerRef.current.setCallbacks({
      onState: setScreenRecorderState,
      onBytes: setScreenRecorderBytes,
      onInfo: setScreenRecorderInfo,
      onSaved: (result) => {
        setScreenRecorderSavedPath(result.path);
        setScreenRecorderBytes(result.size);
        setScreenRecorderFinalization(result.finalizingMp4 ? t('recorderFinalizationSafe') : '');
        addLog(`${t('screenRecorderSaved')}: ${result.path}`, 'info');
        refreshRecoverableRecordings().catch(() => undefined);
      },
      onAudioLevels: setScreenRecorderLevels,
      onFinalizationStage: (stage, message) => {
        const detail = message || t('screenRecorderFinalizingMp4');
        setScreenRecorderFinalization(detail);
        addLog(`[recording:${stage}] ${detail}`, 'info');
      },
      onError: (message) => {
        setScreenRecorderError(message);
        addLog(`Screen recorder: ${message}`, 'error');
        refreshRecoverableRecordings().catch(() => undefined);
      }
    });
    return screenRecorderControllerRef.current;
  }

  async function startScreenRecording(overrideSettings?: ScreenRecorderSettings, resumeSessionId = '', sourceOverride?: MediaStream | null) {
    const source = sourceOverride || localScreenStream || roomRef.current?.getLocalScreenStream() || null;
    if (!source || !source.getVideoTracks().some((track) => track.readyState === 'live')) {
      showToast(t('screenRecorderNeedsStream'));
      return;
    }
    const controller = configureScreenRecorderController();
    if (!['idle', 'error'].includes(controller.getState())) return;
    screenRecorderAutoStreamIdRef.current = source.id || source.getVideoTracks()[0]?.id || 'screen';
    const recorderSettings = overrideSettings || settings?.screenRecorder || screenRecorderDraft || DEFAULT_SCREEN_RECORDER;
    setScreenRecorderError('');
    setScreenRecorderSavedPath('');
    setScreenRecorderBytes(0);
    setScreenRecorderElapsed(0);
    try {
      // Mic Test intentionally plays the microphone through the speakers. Stop it before
      // recording so the new direct microphone track is not captured twice.
      if (micTestActive) {
        stopMicTest();
        await invoke('native_voice_stop_mic_test').catch(() => undefined);
      }
      const requestedOutputDevice = recorderSettings.outputDeviceId || settings?.audioOutputId || '';
      const currentOutputDevice = settings?.audioOutputId || '';
      if (roomRef.current && requestedOutputDevice !== currentOutputDevice) {
        screenRecorderPriorOutputDeviceRef.current = currentOutputDevice;
        await roomRef.current.setVoiceOutputDevice(requestedOutputDevice || undefined);
        addLog(`[recording:audio-route] member output device set to ${requestedOutputDevice || 'default'}`, 'info');
      }

      const info = await controller.start(
        source,
        recorderSettings,
        Boolean(settings?.lowPcMode || voicePressure !== 'normal'),
        resumeSessionId,
        {
          inputDeviceId: recorderSettings.micDeviceId || settings?.audioInputId || undefined,
          outputDeviceId: recorderSettings.outputDeviceId || settings?.audioOutputId || undefined,
          voiceEnhanceEnabled: settings?.voiceEnhanceEnabled ?? true
        }
      );
      setScreenRecorderInfo(info);
      screenRecorderResumeSessionRef.current = resumeSessionId;
      if (recorderSettings.includeAudio && info.audioBitrate <= 0) showToast(t('screenRecorderAudioUnavailable'));
      addLog(`${resumeSessionId ? t('screenRecorderRecoveryStarted') : t('screenRecorderRecording')} ${info.width}x${info.height}@${Math.round(info.recordingFps)} ${info.codecLabel}`, 'info');
      await refreshRecoverableRecordings();
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderSaveFailed'));
      setScreenRecorderError(message);
      setScreenRecorderState('error');
      showError(`${t('screenRecorderSaveFailed')}: ${message}`);
      await restoreScreenRecorderOutputDevice();
      await refreshRecoverableRecordings();
    }
  }

  function pauseScreenRecording() {
    configureScreenRecorderController().pause();
  }

  function resumeScreenRecording() {
    configureScreenRecorderController().resume();
  }

  async function stopScreenRecording(showSavedToast = true) {
    const controller = screenRecorderControllerRef.current;
    if (!controller || !['recording', 'paused', 'starting', 'stopping'].includes(controller.getState())) {
      await restoreScreenRecorderOutputDevice();
      return null;
    }
    try {
      const result = await controller.stop();
      screenRecorderResumeSessionRef.current = '';
      if (result && showSavedToast) showToast(`${t('screenRecorderSaved')}: ${result.path}`);
      await refreshRecoverableRecordings();
      return result;
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderSaveFailed'));
      setScreenRecorderError(message);
      showError(`${t('screenRecorderSaveFailed')}: ${message}`);
      await refreshRecoverableRecordings();
      return null;
    } finally {
      await restoreScreenRecorderOutputDevice();
    }
  }

  async function saveScreenRecorderSettings() {
    if (!settings) return;
    const next = { ...settings, screenRecorder: { ...screenRecorderDraft } };
    await updateSettings(next);
    setDraftSettings((current) => current ? { ...current, screenRecorder: { ...screenRecorderDraft } } : current);
    showToast(t('screenRecorderSettingsSaved'));
  }

  async function openScreenRecorderPanel() {
    setScreenRecorderDraft({ ...(settingsForm.screenRecorder || DEFAULT_SCREEN_RECORDER) });
    setScreenRecorderOpen(true);
    prepareScreenRecorderDependencies().then(setScreenRecorderDependency).catch(() => undefined);
    await refreshRecoverableRecordings();
  }

  async function openScreenRecorderRecoveryPanel() {
    await refreshRecoverableRecordings();
    setScreenRecorderRecoveryOpen(true);
  }

  async function toggleScreenRecorderToolbarCommand() {
    const controller = screenRecorderControllerRef.current;
    const active = controller && ['recording', 'paused', 'starting', 'stopping'].includes(controller.getState());
    if (active) {
      await stopScreenRecording(true);
      return;
    }
    if (screenRecorderArmed) return;
    screenRecorderManualStartRef.current = true;
    setScreenRecorderArmed(true);
    try {
      let source = localScreenStream || roomRef.current?.getLocalScreenStream() || null;
      if (!screenSharing || !source) source = await startScreenShareOnly();
      if (!source) throw new Error(t('screenRecorderNeedsStream'));
      await startScreenRecording(settings?.screenRecorder || DEFAULT_SCREEN_RECORDER, '', source);
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderSaveFailed'));
      setScreenRecorderError(message);
      showError(message);
    } finally {
      screenRecorderManualStartRef.current = false;
      setScreenRecorderArmed(false);
    }
  }

  async function toggleScreenRecorderToolbar() {
    await runGuardedCommand('toggle-screen-recorder', toggleScreenRecorderToolbarCommand);
  }

  async function resumeRecoverableRecording(recording: RecoverableScreenRecording) {
    if (screenRecorderRecoveryBusy) return;
    setScreenRecorderRecoveryBusy(recording.sessionId);
    screenRecorderManualStartRef.current = true;
    setScreenRecorderArmed(true);
    try {
      let source = localScreenStream || roomRef.current?.getLocalScreenStream() || null;
      if (!screenSharing || !source) source = await startScreenShareOnly();
      if (!source) throw new Error(t('screenRecorderNeedsStream'));
      setScreenRecorderRecoveryOpen(false);
      await startScreenRecording(settings?.screenRecorder || DEFAULT_SCREEN_RECORDER, recording.sessionId, source);
      showToast(t('screenRecorderRecoveryStarted'));
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderRepairFailed'));
      showError(`${t('screenRecorderRepairFailed')}: ${message}`);
    } finally {
      screenRecorderManualStartRef.current = false;
      setScreenRecorderArmed(false);
      setScreenRecorderRecoveryBusy('');
    }
  }

  async function finalizeRecoverableRecording(recording: RecoverableScreenRecording) {
    if (screenRecorderRecoveryBusy) return;
    setScreenRecorderRecoveryBusy(recording.sessionId);
    setScreenRecorderState('stopping');
    try {
      const result = await finalizeRecoverableScreenRecording(recording.sessionId);
      setScreenRecorderSavedPath(result.path);
      setScreenRecorderBytes(result.size);
      showToast(`${t('screenRecorderRecoverySaved')}: ${result.path}`);
      await refreshRecoverableRecordings();
      if (recoverableScreenRecordings.length <= 1) setScreenRecorderRecoveryOpen(false);
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderRepairFailed'));
      showError(`${t('screenRecorderRepairFailed')}: ${message}`);
    } finally {
      setScreenRecorderState('idle');
      setScreenRecorderRecoveryBusy('');
    }
  }

  async function openScreenRecorderFolder() {
    try {
      const path = await openScreenRecordingsFolder();
      setScreenRecorderSavedPath(path);
    } catch (error) {
      const message = String((error as Error)?.message || error || t('screenRecorderSaveFailed'));
      showError(message);
    }
  }

  async function downloadErrorLog() {
    const lines = [...errorLog].reverse().map((entry) => `[${new Date(entry.at).toLocaleString()}] ${entry.level.toUpperCase()}\n${entry.message}`);
    const contents = lines.join('\n\n') || 'MHTalk log is empty.';
    const fileName = `MHTalk_${APP_VERSION}_log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    try {
      const savedPath = await invoke<string | null>('save_text_file_with_dialog', { defaultName: fileName, contents });
      if (savedPath) showToast(`${t('logDownloaded')} ${savedPath}`);
    } catch (error) {
      addLog(String((error as Error)?.message || error || 'Log save dialog failed'), 'error');
      const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast(t('logDownloaded'));
    }
  }


  async function checkWithTimeout() {
    const timeoutMs = 9000;
    let timeoutId = 0;
    try {
      return await Promise.race([
        check(),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error('Update check timed out, continuing offline.')), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  }

  function continueOfflineFromUpdateGate() {
    addLog(t('updateTimeout'), 'info');
    setRequiredUpdate(null);
    setUpdateProgress('');
    setUpdateGateChecked(true);
    setUpdateBusy(false);
  }

  async function installRequiredUpdate(updateArg?: any) {
    if (updateBusy && !updateArg) return;
    if (!commandGateRef.current.tryEnter('install-update')) return;
    setUpdateBusy(true);
    setUpdateGateChecked(false);
    setUpdateProgress(t('updateInstalling'));
    try {
      const update = updateArg || pendingUpdateRef.current || await checkWithTimeout();
      if (!update) {
        setRequiredUpdate(null);
        setUpdateProgress('');
        setUpdateGateChecked(true);
        showToast(t('updateNone'));
        setUpdateBusy(false);
        return;
      }

      pendingUpdateRef.current = update;
      setRequiredUpdate({ version: String(update.version || ''), notes: String(update.body || '').trim() });
      let downloaded = 0;
      let contentLength = 0;
      await update.downloadAndInstall((event: any) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength || 0;
          setUpdateProgress(contentLength > 0 ? `${t('updateProgress')}: 0%` : t('updateInstalling'));
        }
        if (event.event === 'Progress') {
          downloaded += event.data.chunkLength || 0;
          if (contentLength > 0) setUpdateProgress(`${t('updateProgress')}: ${Math.min(100, Math.round((downloaded / contentLength) * 100))}%`);
        }
        if (event.event === 'Finished') setUpdateProgress(t('updateReady'));
      });

      showToast(t('updateReady'));
      await relaunch();
    } catch (error) {
      const message = String((error as Error)?.message || error || 'Update error');
      addLog(message, 'error');
      showToast(t('updateFailed'));
      setUpdateProgress(t('updateFailed'));
      setUpdateGateChecked(true);
      setUpdateBusy(false);
    } finally {
      commandGateRef.current.leave('install-update');
    }
  }

  async function checkForUpdates(manual = false) {
    if (updateBusy) return;
    if (!commandGateRef.current.tryEnter('check-update')) return;
    setUpdateBusy(true);
    if (manual) setUpdateProgress(t('checkingUpdates'));
    try {
      const update = await checkWithTimeout();
      if (!update) {
        pendingUpdateRef.current = null;
        setRequiredUpdate(null);
        setUpdateProgress('');
        setUpdateGateChecked(true);
        setUpdateBusy(false);
        if (manual) showToast(t('updateNone'));
        return;
      }

      const notes = String(update.body || '').trim();
      pendingUpdateRef.current = update;
      setRequiredUpdate({ version: String(update.version || ''), notes });
      setUpdateProgress(manual ? t('updateInstalling') : t('updateAutoInstalling'));
      setUpdateBusy(false);
      await installRequiredUpdate(update);
    } catch (error) {
      const message = String((error as Error)?.message || error || 'Update error');
      const isTimeout = message.toLowerCase().includes('timed out');
      addLog(isTimeout ? t('updateTimeout') : message, isTimeout ? 'info' : 'error');
      if (manual) showToast(isTimeout ? t('updateTimeout') : t('updateFailed'));
      setRequiredUpdate(null);
      setUpdateProgress(isTimeout ? t('updateTimeout') : '');
      setUpdateGateChecked(true);
      setUpdateBusy(false);
    } finally {
      commandGateRef.current.leave('check-update');
    }
  }

  function stopMicTest() {
    try { micTestUnlistenRef.current?.(); } catch { /* ignore */ }
    try { micTestErrorUnlistenRef.current?.(); } catch { /* ignore */ }
    micTestUnlistenRef.current = null;
    micTestErrorUnlistenRef.current = null;
    invoke('native_voice_stop_mic_test').catch(() => undefined);
    setMicTestActive(false);
    setMicTestLevel(0);
  }

  async function startMicTest() {
    if (!settings) return;
    stopMicTest();
    try {
      micTestUnlistenRef.current = await listen<number>('mhlko://native-voice-mic-test-level', (event) => {
        setMicTestLevel(Math.min(1, Math.max(0, Number(event.payload || 0) * 4)));
      });
      micTestErrorUnlistenRef.current = await listen<string>('mhlko://native-voice-mic-test-error', (event) => {
        addLog(String(event.payload || 'Native mic test error'), 'error');
      });
      await invoke('native_voice_start_mic_test', { inputDeviceId: settings.audioInputId || null, outputDeviceId: settings.audioOutputId || null, inputDeviceLabel: selectedInputLabel(settings.audioInputId), outputDeviceLabel: selectedOutputLabel(settings.audioOutputId) });
      setMicTestActive(true);
    } catch (error) {
      const message = String((error as Error)?.message || error || 'Mic test error');
      addLog(message, 'error');
      showToast(t('micTestFailed'));
      stopMicTest();
    }
  }

  async function toggleMicTest() {
    if (micTestActive) stopMicTest();
    else await startMicTest();
  }

  function playTone(kind: 'screen-on' | 'screen-off' | 'join' | 'leave') {
    // 0.6.8: UI notification sounds are routed through the Native Voice Engine too.
    // No oscillator/AudioContext output is used in WebView.
    invoke('native_voice_play_tone', { kind }).catch(() => undefined);
  }

  async function requestNotificationsIfNeeded(enabled: boolean) {
    if (!enabled || !('Notification' in window)) return;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
  }

  function notifyIncoming(message: ChatMessage) {
    if (!settings?.notificationsEnabled || windowFocused) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const title = message.privateFrom ? `${message.senderName} • ${t('privateLabel')}` : message.senderName || 'MHTalk';
    const body = message.kind === 'text' ? message.body : message.fileName || message.body || 'New message';
    try { new Notification(title, { body, silent: false }); } catch { /* desktop notification unsupported */ }
  }

  function makeReplyPreview(message: ChatMessage): Pick<ChatMessage, 'id' | 'body' | 'senderName'> {
    return {
      id: message.id,
      senderName: message.senderName,
      body: message.kind === 'text' ? message.body : (message.fileName || message.body || 'media')
    };
  }


  function messagePreviewText(message: ChatMessage) {
    return message.kind === 'text' ? message.body : (message.fileName || message.body || t('mediaLabel'));
  }

  function statusFromReceipts(targetCount = 0, deliveredTo: string[] = [], seenBy: string[] = []): ChatMessage['deliveryStatus'] {
    const total = Math.max(0, targetCount);
    if (total <= 0) return 'sent';
    if (seenBy.length >= total) return 'seen';
    if (deliveredTo.length >= total) return 'delivered';
    return 'sent';
  }

  function withReceipt(message: ChatMessage, peerId: string, status: 'delivered' | 'seen'): ChatMessage {
    if (message.sender !== 'me') return message;
    const deliveredTo = new Set(message.deliveredTo || []);
    const seenBy = new Set(message.seenBy || []);
    if (status === 'delivered' || status === 'seen') deliveredTo.add(peerId);
    if (status === 'seen') seenBy.add(peerId);
    const nextDelivered = [...deliveredTo];
    const nextSeen = [...seenBy];
    return {
      ...message,
      deliveredTo: nextDelivered,
      seenBy: nextSeen,
      deliveryStatus: statusFromReceipts(message.targetCount || nextDelivered.length || 0, nextDelivered, nextSeen)
    };
  }

  function messageStatusText(message: ChatMessage) {
    const status = message.deliveryStatus || 'sent';
    if (status === 'sending') return t('messageSending');
    if (status === 'delivered') return t('messageDelivered');
    if (status === 'seen') return t('messageSeen');
    return t('messageSent');
  }

  function markOutgoingSentSoon(messageId: string) {
    window.setTimeout(() => {
      setMessages((current) => {
        const next = current.map((message) => message.id === messageId && message.deliveryStatus === 'sending' ? { ...message, deliveryStatus: 'sent' as const } : message);
        const updated = next.find((message) => message.id === messageId);
        if (updated && settings?.saveChat) saveMessage(updated).catch(() => undefined);
        return next;
      });
    }, 350);
  }

  function clearAttachmentReceiptTimer(messageId: string) {
    const timer = attachmentReceiptTimersRef.current.get(messageId);
    if (timer) window.clearTimeout(timer);
    attachmentReceiptTimersRef.current.delete(messageId);
  }

  function scheduleAttachmentReceiptTimeout(messageId: string) {
    clearAttachmentReceiptTimer(messageId);
    const timer = window.setTimeout(() => {
      attachmentReceiptTimersRef.current.delete(messageId);
      setMessages((current) => {
        const next = current.map((message) => {
          if (message.id !== messageId || message.sender !== 'me' || message.fileStatus !== 'awaiting-delivery') return message;
          return { ...message, fileStatus: 'failed' as const, fileError: 'Delivery confirmation timed out.', retryable: true };
        });
        const updated = next.find((message) => message.id === messageId);
        if (updated?.fileStatus === 'failed' && settings?.saveChat) saveMessage(updated).catch(() => undefined);
        return next;
      });
    }, 30_000);
    attachmentReceiptTimersRef.current.set(messageId, timer);
  }

  function sendSeenReceiptFor(message: ChatMessage): boolean {
    if (message.sender !== 'peer' || !message.peerId || message.deletedAt) return false;
    if (message.kind !== 'text' && message.fileStatus && message.fileStatus !== 'completed') return false;
    roomRef.current?.sendSeenReceipt(message.id, message.peerId);
    return true;
  }


  useEffect(() => {
    if (!windowFocused || !roomRef.current || !roomId) return;
    const candidates = messages.filter((message) => message.sender === 'peer' && message.peerId && !message.deletedAt && !seenReceiptSentRef.current.has(message.id));
    if (!candidates.length) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.55) continue;
        const id = (entry.target as HTMLElement).dataset.messageId || '';
        if (!id || seenReceiptSentRef.current.has(id)) continue;
        const message = messages.find((item) => item.id === id);
        if (!message) continue;
        if (sendSeenReceiptFor(message)) seenReceiptSentRef.current.add(id);
      }
    }, { threshold: [0.55] });
    for (const message of candidates) {
      const node = messageRefs.current[message.id];
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [windowFocused, messages, roomId]);

  function scrollToMessage(messageId?: string) {
    if (!messageId) return;
    const node = messageRefs.current[messageId];
    if (!node) {
      showToast(t('originalMessageMissing'));
      return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedMessageId(messageId);
    window.setTimeout(() => setHighlightedMessageId((current) => current === messageId ? '' : current), 1800);
  }

  function handleRemoteTyping(peerId: string, senderName: string, active: boolean) {
    if (!peerId) return;
    window.clearTimeout(typingTimersRef.current[peerId]);
    if (!active) {
      setTypingUsers((current) => { const next = { ...current }; delete next[peerId]; return next; });
      return;
    }
    setTypingUsers((current) => ({ ...current, [peerId]: senderName }));
    typingTimersRef.current[peerId] = window.setTimeout(() => {
      setTypingUsers((current) => { const next = { ...current }; delete next[peerId]; return next; });
    }, 2600);
  }

  function resizeComposerTextarea(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight || '20') || 20;
    const maxHeight = Math.round(lineHeight * 3 + 18);
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function handleDraftChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setDraft(value);
    resizeComposerTextarea(event.currentTarget);
    if (!roomRef.current || !roomId || editingMessage) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current > 900) {
      roomRef.current.sendTyping(Boolean(value.trim()), privateTarget || undefined);
      lastTypingSentRef.current = now;
    }
    if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = window.setTimeout(() => {
      roomRef.current?.sendTyping(false, privateTarget || undefined);
    }, 1400);
  }

  function beginEditMessage(message: ChatMessage) {
    if (message.sender !== 'me' || message.kind !== 'text') return;
    setEditingMessage(message);
    setReplyTo(null);
    setDraft(message.body);
  }

  function cancelEdit() {
    setEditingMessage(null);
    setDraft('');
  }

  async function makeWaveform(blob: Blob, bars = 36): Promise<number[]> {
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) throw new Error('no-audio-context');
      const ctx = new AudioContextClass();
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      const data = buffer.getChannelData(0);
      const block = Math.max(1, Math.floor(data.length / bars));
      const result: number[] = [];
      for (let i = 0; i < bars; i += 1) {
        let sum = 0;
        const start = i * block;
        for (let j = 0; j < block && start + j < data.length; j += 1) sum += Math.abs(data[start + j]);
        result.push(Math.min(1, Math.max(0.08, (sum / block) * 4)));
      }
      await ctx.close().catch(() => undefined);
      return result;
    } catch {
      addLog('Voice waveform analysis failed; using deterministic low fallback bars.', 'info');
      return Array.from({ length: bars }, () => 0.22);
    }
  }

  async function updateSettings(next: AppSettings) {
    setSettingsState(next);
    await saveSettings(next);
    if (next.notificationsEnabled) await requestNotificationsIfNeeded(true);
  }

  function updateDraftSettings(patch: Partial<AppSettings>) {
    setDraftSettings((current) => ({ ...(current || settings || DEFAULT_SETTINGS), ...patch }));
  }

  async function applySettingsChangesCommand() {
    if (!draftSettings) return;
    const next: AppSettings = {
      ...draftSettings,
      // Hotkeys are saved immediately from their dedicated editor. Preserve the latest
      // committed values so an older settings draft cannot silently overwrite them.
      hotkeys: { ...(settings?.hotkeys || draftSettings.hotkeys) }
    };
    if (!availableQualityOptions.includes(next.screenQuality)) next.screenQuality = availableQualityOptions[0] || 'auto-max';
    if (!availableFpsOptions.includes(next.screenFps)) next.screenFps = availableFpsOptions.includes(60) ? 60 : availableFpsOptions[0] || 60;
    await updateSettings(next);
    setDraftSettings({ ...next });
    showToast(t('settingsSaved'));
  }

  async function applySettingsChanges() {
    await runGuardedCommand('apply-settings', applySettingsChangesCommand);
  }

  async function toggleVoiceEnhance() {
    if (!settings) return;
    const enabled = !settings.voiceEnhanceEnabled;
    try {
      const applied = await invoke<boolean>('native_voice_set_enhance_enabled', { enabled });
      await updateSettings({ ...settings, voiceEnhanceEnabled: applied });
      await roomRef.current?.setVoiceEnhanceEnabled(applied);
      const status = await invoke<VoiceEngineStatus>('voice_companion_status');
      setVoiceEngineStatus(status);
      showToast(applied ? t('voiceEnhanceEnabled') : t('voiceEnhanceDisabled'));
    } catch (error) {
      addLog(String((error as Error)?.message || error || 'Voice Enhance error'), 'error');
      showToast(t('voiceSolutionFailed'));
    }
  }

  function openHotkeysEditor() {
    setHotkeyDraft({ ...(settings?.hotkeys || DEFAULT_HOTKEYS) });
    setHotkeyValidationError('');
    setLearningHotkey(null);
    setHotkeysOpen(true);
  }

  function closeHotkeysEditor() {
    if (hotkeysDirty && !window.confirm(t('discardHotkeyChanges'))) return;
    setHotkeysOpen(false);
    setHotkeyValidationError('');
    setLearningHotkey(null);
  }

  function clearHotkey(action: HotkeyAction) {
    const next = { ...hotkeyDraft, [action]: '' };
    setHotkeyDraft(next);
    setHotkeyValidationError(validateHotkeyMap(next) || '');
    if (learningHotkey === action) setLearningHotkey(null);
  }

  async function saveHotkeys() {
    if (!settings || !hotkeysDirty) return;
    const normalized = Object.fromEntries(
      (Object.entries(hotkeyDraft) as Array<[HotkeyAction, string]>).map(([action, combo]) => [action, normalizeHotkeyCombo(combo)])
    ) as Record<HotkeyAction, string>;
    const validationError = validateHotkeyMap(normalized);
    setHotkeyValidationError(validationError || '');
    if (validationError) return;
    await runGuardedCommand('save-hotkeys', async () => {
      const next = { ...settings, hotkeys: normalized };
      await updateSettings(next);
      setHotkeyDraft({ ...normalized });
      setDraftSettings((current) => current ? { ...current, hotkeys: { ...normalized } } : current);
      showToast(t('hotkeySaved'));
    });
  }

  async function updateProfile(next: UserProfile) {
    const versioned = { ...next, updated_at: Date.now() };
    setProfile(versioned);
    roomRef.current?.updateProfile(versioned);
    await saveProfile(versioned);
  }

  function defaultVolume(): PeerVolume { return { voice: 1, screen: 1, voiceMuted: false, screenMuted: false }; }

  function ensurePeerVolume(peerId: string) {
    setPeerVolumes((current) => current[peerId] ? current : { ...current, [peerId]: defaultVolume() });
  }

  async function shouldAutoStartMicForRoom(): Promise<boolean> {
    try {
      if (window.localStorage.getItem('mhlko.micAutoStartGranted') === 'true') return true;
      const permissions = navigator.permissions as Permissions & { query?: (descriptor: PermissionDescriptor) => Promise<PermissionStatus> };
      if (permissions?.query) {
        const status = await permissions.query({ name: 'microphone' as PermissionName });
        return status.state === 'granted';
      }
    } catch { /* permission query is not supported in every WebView */ }
    return false;
  }

  function rememberMicAutoStartSuccess() {
    try { window.localStorage.setItem('mhlko.micAutoStartGranted', 'true'); } catch { /* ignore */ }
  }

  async function chooseRoomMic(enabled: boolean) {
    setMicJoinPromptOpen(false);
    if (!enabled) {
      roomRef.current?.setMicEnabled(false);
      setMicEnabled(false);
      setVoiceActive(false);
      addLog('User entered room with microphone muted', 'info');
      return;
    }
    if (!roomRef.current || !activeSettings) return;
    try {
      await startRoomVoice(roomRef.current);
      rememberMicAutoStartSuccess();
      setVoiceActive(true);
      setMicEnabled(true);
      roomRef.current.setMicEnabled(true);
      addLog('User enabled microphone from room entry prompt', 'info');
    } catch {
      showToast(t('micPermission'));
      setMicEnabled(false);
      setVoiceActive(false);
    }
  }

  function syncHistoryToPeer(peerId: string) {
    if (!roomRef.current || !settings?.showHistoryForNewMembers || !isRoomOwnerRef.current) return;
    const items = messagesRef.current
      .filter((message) => message.sender !== 'system' && !message.deletedAt && !message.privateTo && !message.privateFrom)
      .slice(-80);
    let sentCount = 0;
    for (const message of items) {
      if (roomRef.current.sendExistingMessageToPeer(message, peerId)) sentCount += 1;
    }
    if (sentCount > 0) addLog(`${t('historySyncedToNewMember')} ${sentCount}`, 'info');
  }

  async function flushMessageOutbox(expectedRoomId: string, connectedPeerIds?: string[]) {
    const room = roomRef.current;
    if (!room || !expectedRoomId || outboxFlushInFlightRef.current) return;
    outboxFlushInFlightRef.current = true;
    try {
      const connected = connectedPeerIds || [...previousPeerIdsRef.current];
      if (activeRoomIdRef.current !== expectedRoomId) return;
      const entries = connectedPeerIds
        ? await loadMessageOutbox(expectedRoomId, 100)
        : await loadDueMessageOutbox(expectedRoomId);
      for (const entry of entries) {
        if (roomRef.current !== room || activeRoomIdRef.current !== expectedRoomId) break;
        let recipients = entry.recipientPeerIds;
        if (!recipients.length && connected.length) {
          recipients = await setMessageOutboxRecipients(entry.messageId, connected);
          if (recipients.length) {
            setMessages((current) => current.map((message) => message.id === entry.messageId
              ? { ...message, targetPeerIds: recipients, targetCount: recipients.length }
              : message));
          }
        }
        const pending = pendingOutboxRecipients(recipients, entry.acknowledgedPeerIds, connected);
        let sent = 0;
        for (const peerId of pending) {
          if (room.sendExistingMessageToPeer({ ...entry.message, targetPeerIds: recipients, targetCount: recipients.length }, peerId)) sent += 1;
        }
        const attempts = entry.attempts + 1;
        await markMessageOutboxAttempt(entry.messageId, attempts, Date.now() + outboxRetryDelayMs(attempts));
        if (sent > 0) addLog(`Pending message retried to ${sent} member${sent === 1 ? '' : 's'}`, 'info');
      }
    } catch (error) {
      addLog(`Message recovery failed: ${String((error as Error)?.message || error)}`, 'error');
    } finally {
      outboxFlushInFlightRef.current = false;
    }
  }

  useEffect(() => {
    // Member voice is rendered only inside the isolated MHTalkVoice process.
    for (const [peerId, volume] of Object.entries(peerVolumes)) {
      if (!peerId || peerId === localPeerId) continue;
      const voiceVolume = Number.isFinite(volume.voice) ? Math.min(2, Math.max(0, volume.voice)) : 1;
      roomRef.current?.setPeerVoiceVolume(peerId, voiceVolume, Boolean(volume.voiceMuted)).catch(() => undefined);
    }
  }, [peerVolumes, localPeerId]);

  async function openRoom(id: string) {
    if (!profile || !activeSettings || !settings) return;
    if (!commandGateRef.current.tryEnter('open-room')) return;
    setBusy(true);
    try {
      await stopScreenRecording(false);
      roomRef.current?.close();
      const cleanId = normalizeRoomId(id);
      activeRoomIdRef.current = cleanId;
      setRoomId(cleanId);
      const [savedMessages, pendingOutbox] = await Promise.all([
        settings.saveChat ? loadMessages(cleanId) : Promise.resolve([]),
        loadMessageOutbox(cleanId)
      ]);
      const restoredMessages = new Map(savedMessages.map((message) => [message.id, message]));
      for (const entry of pendingOutbox) {
        restoredMessages.set(entry.messageId, {
          ...entry.message,
          targetPeerIds: entry.recipientPeerIds,
          targetCount: entry.recipientPeerIds.length || entry.message.targetCount,
          deliveredTo: entry.acknowledgedPeerIds,
          deliveryStatus: entry.acknowledgedPeerIds.length ? 'delivered' : 'sending'
        });
      }
      const initialMessages = [...restoredMessages.values()].sort((a, b) => a.createdAt - b.createdAt);
      receivedMessageIdsRef.current.clear();
      initialMessages.forEach((message) => receivedMessageIdsRef.current.remember(message.id));
      setMessages(initialMessages);
      setPeers({});
      setPeerMedia({});
      setScreenStreams({});
      setPeerVolumes({});
      setActivePeerId('');
      setPrivateTarget('');
      setReplyTo(null);
      setEditingMessage(null);
      setIsRoomOwner(false);
      setOwnerPeerId('');
      setTypingUsers({});
      setHighlightedMessageId('');
      setPendingAttachments([]);
      pendingAttachmentKeysRef.current.clear();
      outgoingAttachmentSourcesRef.current.clear();
      canceledAttachmentIdsRef.current.clear();
      for (const timer of attachmentReceiptTimersRef.current.values()) window.clearTimeout(timer);
      attachmentReceiptTimersRef.current.clear();
      setBannedMembers([]);
      setBanModalOpen(false);
      setSettingsOpen(false);
      setJoinRequests({});
      setJoinRequestsOpen(false);
      setRoomRoles({});
      setPendingVoice(null);
      setChatOverlayOpen(false);
      setAdminMutedPeers({});
      setGlobalMuteActive(false);
      globalMuteActiveRef.current = false;
      globalMuteSnapshotRef.current = null;
      forcedMutedByAdminRef.current = false;
      preForcedLocalMicEnabledRef.current = null;
      setHotkeysOpen(false);
      setErrorLogOpen(false);
      previousPeerIdsRef.current = new Set();
      closedStreamPeersRef.current = new Set();
      autoOpenedJoinRequestIdsRef.current = new Set();
      seenReceiptSentRef.current = new Set();
      historySyncedPeerIdsRef.current = new Set();
      micPromptShownForRoomRef.current = false;
      cameraWithStreamArmedRef.current = false;
      setCameraWithStreamArmed(false);
      setMicJoinPromptOpen(false);
      setCameraOpen(false);
      setCameraMode('camera-only');
      setCameraStream(null);
      setLocalScreenStream(null);
      setCameraStreams({});
      setScreenSharing(false);
      setVoiceActive(false);
      setMicEnabled(false);

      let room: RoomSession;
      const openMicPromptOnce = () => {
        if (micPromptShownForRoomRef.current) return;
        micPromptShownForRoomRef.current = true;
        setMicJoinPromptOpen(true);
        addLog('Room microphone prompt opened', 'info');
      };

      room = await createRoomSession({
        roomId: cleanId,
        signalingUrl: activeSettings.signalingUrl,
        profile,
        callbacks: {
          onState: (state, label) => {
            setConnection(state);
            if (label) setConnectionLabel(label);
          },
          onMessage: async (message) => {
            if (receivedMessageIdsRef.current.remember(message.id)) {
              if (message.peerId) room.sendSeenReceipt(message.id, message.peerId);
              return;
            }
            setMessages((current) => [...current, message]);
            notifyIncoming(message);
            if (windowFocused) window.setTimeout(() => sendSeenReceiptFor(message), 80);
            if (settings.saveChat) await saveMessage(message);
          },
           onPeers: (nextPeers) => {
            const previous = previousPeerIdsRef.current;
            const mapped: Record<string, PeerProfile> = {};
            for (const peer of nextPeers) mapped[peer.peerId] = peer;
            const nextIds = new Set(nextPeers.map((peer) => peer.peerId));
            if (previous.size > 0) {
              if (nextPeers.some((peer) => !previous.has(peer.peerId))) playTone('join');
              if ([...previous].some((peerId) => !nextIds.has(peerId))) playTone('leave');
            }
            previousPeerIdsRef.current = nextIds;
            setPeers(mapped);
            setMessages((current) => current.map((message) => {
              if (message.sender !== 'peer' || !message.peerId || !mapped[message.peerId]) return message;
              const nextName = mapped[message.peerId].displayName;
              return message.senderName === nextName ? message : { ...message, senderName: nextName };
            }));
            window.setTimeout(() => flushMessageOutbox(cleanId, [...nextIds]), 100);
            nextPeers.forEach((peer) => {
              ensurePeerVolume(peer.peerId);
              if (globalMuteActiveRef.current && !previous.has(peer.peerId)) {
                room.mutePeerForRoom(peer.peerId);
                setAdminMutedPeers((current) => ({ ...current, [peer.peerId]: true }));
                setPeerMedia((current) => ({ ...current, [peer.peerId]: { ...(current[peer.peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: false } }));
                addLog(`New member joined during global mute and was muted: ${peer.displayName}`, 'info');
              }
              if (!previous.has(peer.peerId) && settings.showHistoryForNewMembers && isRoomOwnerRef.current && !historySyncedPeerIdsRef.current.has(peer.peerId)) {
                historySyncedPeerIdsRef.current.add(peer.peerId);
                window.setTimeout(() => syncHistoryToPeer(peer.peerId), 900);
              }
             });
           },
          onProfileAssetAccess: (access) => {
            lastPublishedProfileAssetRef.current = '';
            setProfileAssetAccess(access);
          },
          onProfileAssetsStale: () => {
            queryClient.invalidateQueries({ queryKey: ['profile-assets', cleanId] }).catch(() => undefined);
          },
           onRemoteStream: (peerId, streamType, stream) => {
            if (streamType === 'camera') {
              const hasLiveVideo = stream.getVideoTracks().some((track) => track.readyState === 'live');
              setCameraStreams((current) => {
                const next = { ...current };
                if (hasLiveVideo) next[peerId] = stream;
                else delete next[peerId];
                return next;
              });
              if (!hasLiveVideo && activePeerId === peerId && activeMediaMode === 'camera') setActivePeerId('');
            } else {
              const hasLiveVideo = stream.getVideoTracks().some((track) => track.readyState === 'live');
              setStreamRefreshTokens((current) => ({ ...current, [peerId]: (current[peerId] || 0) + 1 }));
              setScreenStreams((current) => {
                const next = { ...current };
                if (hasLiveVideo) next[peerId] = stream;
                else delete next[peerId];
                return next;
              });
              if (hasLiveVideo) addLog(t('streamViewerOpened') + `: available ${peerId}`, 'info');
              else setActivePeerId((current) => current === peerId && activeMediaMode === 'screen' ? '' : current);
            }
          },
          onError: (message) => showError(TEXT[message] ?? message),
          onLog: (message, level = 'info') => addLog(message, level),
          onLocalMedia: (media) => {
            if (typeof media.screenSharing === 'boolean') {
              setScreenSharing(media.screenSharing);
              setLocalScreenStream(media.screenSharing ? room.getLocalScreenStream() || null : null);
              addLog(media.screenSharing ? t('streamStarted') : t('streamEnded'), 'info');
            }
            if (typeof media.cameraSharing === 'boolean') setCameraOpen(media.cameraSharing);
            if (typeof media.micEnabled === 'boolean') setMicEnabled(media.micEnabled);
          },
          onVoiceActivity: (peerId, speaking) => updateSpeaking(peerId, speaking),
          onMedia: (peerId, media) => {
            setPeerMedia((current) => {
              const previous = current[peerId];
              const nextScreenSharing = typeof media.screenSharing === 'boolean' ? media.screenSharing : previous?.screenSharing ?? false;
              const nextCameraSharing = typeof media.cameraSharing === 'boolean' ? media.cameraSharing : previous?.cameraSharing ?? false;
              if (typeof media.screenSharing === 'boolean' && previous && previous.screenSharing !== nextScreenSharing) playTone(nextScreenSharing ? 'screen-on' : 'screen-off');
              return {
                ...current,
                [peerId]: {
                  micEnabled: typeof media.micEnabled === 'boolean' ? media.micEnabled : previous?.micEnabled ?? true,
                  screenSharing: nextScreenSharing,
                  cameraSharing: nextCameraSharing
                }
              };
            });
            if (media.screenSharing === false) {
              setScreenStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setCameraStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
              setStreamRefreshTokens((current) => { const next = { ...current }; delete next[peerId]; return next; });
              closedStreamPeersRef.current.delete(peerId);
              setActivePeerId((current) => current === peerId ? '' : current);
              addLog(`Remote stream ended: ${peers[peerId]?.displayName || peerId}`, 'info');
            }
            if (media.screenSharing === true) addLog(`Remote stream available: ${peers[peerId]?.displayName || peerId}`, 'info');
            if (media.cameraSharing === false) {
              setCameraStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
              if (activePeerId === peerId && activeMediaMode === 'camera') setActivePeerId('');
              addLog(`Remote camera ended: ${peers[peerId]?.displayName || peerId}`, 'info');
            }
            if (media.cameraSharing === true) addLog(`Remote camera available: ${peers[peerId]?.displayName || peerId}`, 'info');
          },
          onPeerLeft: (peerId) => {
            if (previousPeerIdsRef.current.delete(peerId)) playTone('leave');
            closedStreamPeersRef.current.delete(peerId);
            setPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setPeerMedia((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setScreenStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setCameraStreams((current) => { const next = { ...current }; delete next[peerId]; return next; });
            updateSpeaking(peerId, false);
            setSpeakingPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setActivePeerId((current) => current === peerId ? '' : current);
            setPrivateTarget((current) => current === peerId ? '' : current);
            setAdminMutedPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
            setSpeakRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
            handleRemoteTyping(peerId, '', false);
          },
          onMessageEdit: (messageId, body, editedAt) => {
            setMessages((current) => {
              const next = current.map((message) => message.id === messageId ? { ...message, body, editedAt } : message);
              const updated = next.find((message) => message.id === messageId);
              if (updated && settings.saveChat) saveMessage(updated).catch(() => undefined);
              return next;
            });
          },
          onMessageDelete: (messageId, deletedAt) => {
            setMessages((current) => current.map((message) => message.id === messageId ? { ...message, body: '', dataUrl: undefined, deletedAt } : message));
            if (settings.saveChat) markMessageDeleted(messageId, deletedAt).catch(() => undefined);
          },
          onMessageReceipt: (messageId, peerId, status) => {
            outboxAckChainRef.current = outboxAckChainRef.current
              .then(() => acknowledgeMessageOutbox(messageId, peerId))
              .catch(() => undefined);
            setMessages((current) => {
              const next = current.map((message) => {
                if (message.id !== messageId) return message;
                const received = withReceipt(message, peerId, status);
                if (message.kind !== 'text' && (status === 'delivered' || status === 'seen')) {
                  return { ...received, fileStatus: 'completed' as const, fileError: undefined, retryable: false, uploadProgress: 100 };
                }
                return received;
              });
              const updated = next.find((message) => message.id === messageId);
              if (updated?.fileStatus === 'completed') {
                clearAttachmentReceiptTimer(messageId);
                outgoingAttachmentSourcesRef.current.delete(messageId);
              }
              if (updated && settings.saveChat) saveMessage(updated).catch(() => undefined);
              return next;
            });
          },
          onFileProgress: (patch) => {
            setMessages((current) => {
              if (canceledAttachmentIdsRef.current.has(patch.id) && patch.fileStatus !== 'canceled') return current;
              const exists = current.some((message) => message.id === patch.id);
              const next = exists ? current.map((message) => message.id === patch.id ? {
                ...message,
                ...patch,
                sender: message.sender,
                senderName: patch.senderName || message.senderName,
                body: patch.body || message.body,
                kind: message.kind || patch.kind,
                fileName: patch.fileName || message.fileName,
                mimeType: patch.mimeType || message.mimeType,
                fileSize: patch.fileSize ?? message.fileSize,
                createdAt: message.createdAt || patch.createdAt
              } : message) : [...current, patch];
              const updated = next.find((message) => message.id === patch.id);
              if (updated?.fileStatus === 'failed' || updated?.fileStatus === 'canceled') clearAttachmentReceiptTimer(patch.id);
              if (updated && settings.saveChat) saveMessage(updated).catch(() => undefined);
              return next;
            });
          },
          onTyping: handleRemoteTyping,
          onOwner: (owner, ownerId) => {
            setIsRoomOwner(owner);
            setOwnerPeerId(ownerId);
            if (owner) {
              isRoomOwnerRef.current = true;
              setForcedMutedByAdmin(false);
              forcedMutedByAdminRef.current = false;
              preForcedLocalMicEnabledRef.current = null;
              addLog('Admin forced mute state cleared for owner', 'info');
            }
          },
          onRoles: (roles) => setRoomRoles(roles),
          onJoinRequest: (request) => {
            const requestKey = `${request.peerId}:${request.requestedAt}`;
            setJoinRequests((current) => ({ ...current, [request.peerId]: request }));
            if (!autoOpenedJoinRequestIdsRef.current.has(requestKey)) {
              autoOpenedJoinRequestIdsRef.current.add(requestKey);
              setJoinRequestsOpen(true);
              addLog(`Join request auto-opened: ${request.displayName}`, 'info');
            } else {
              addLog(`Join request kept pending: ${request.displayName}`, 'info');
            }
            showToast(`${t('joinRequests')}: ${request.displayName}`);
          },
          onJoinDecision: (accepted) => {
            showToast(accepted ? t('joinAccepted') : t('joinRejected'));
            if (accepted) openMicPromptOnce();
          },
          onKicked: () => {
            showToast(t('kickedOut'));
            leaveRoom(false).catch(() => undefined);
          },
          onAdminMuteAll: (fromPeerId) => {
            if (isRoomOwnerRef.current) {
              setForcedMutedByAdmin(false);
              forcedMutedByAdminRef.current = false;
              preForcedLocalMicEnabledRef.current = null;
              addLog('Mute All ignored for owner/admin', 'info');
              return;
            }
            if (!forcedMutedByAdminRef.current && preForcedLocalMicEnabledRef.current === null) preForcedLocalMicEnabledRef.current = micEnabledRef.current;
            setForcedMutedByAdmin(true);
            forcedMutedByAdminRef.current = true;
            room.setMicEnabled(false);
            setMicEnabled(false);
            updateSpeaking(localPeerId, false);
            showToast(t('mutedByAdmin'));
            addLog(`${t('mutedByAdmin')}: ${fromPeerId}`, 'info');
          },
          onAdminUnmuteAll: () => {
            const restore = preForcedLocalMicEnabledRef.current;
            preForcedLocalMicEnabledRef.current = null;
            setForcedMutedByAdmin(false);
            forcedMutedByAdminRef.current = false;
            if (restore !== null && voiceActiveRef.current) {
              room.setMicEnabled(restore);
              setMicEnabled(restore);
            }
            showToast(t('unmuteAllMembers'));
            addLog('Admin cleared forced mute and restored previous local mute state', 'info');
          },
          onAdminPeerMuteState: (peerId, muted) => {
            if (!peerId) return;
            setAdminMutedPeers((current) => {
              const next = { ...current };
              if (muted) next[peerId] = true;
              else delete next[peerId];
              return next;
            });
            setPeerMedia((current) => ({ ...current, [peerId]: { ...(current[peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: !muted } }));
            addLog(`${muted ? 'Public admin mute' : 'Public admin unmute'}: ${peerId}`, 'info');
          },
          onRequestToSpeak: (request) => {
            if (!canModerate) return;
            setSpeakRequests((current) => ({ ...current, [request.peerId]: request }));
            setJoinRequestsOpen(true);
            playTone('join');
            showToast(`${t('requestToSpeak')}: ${request.displayName}`);
            addLog(`Member requested to speak: ${request.displayName}`, 'info');
          },
          onSpeakPermission: (allowed) => {
            if (allowed) {
              setForcedMutedByAdmin(false);
              showToast(t('adminAllowedSpeak'));
            } else {
              showToast(t('adminRejectedSpeak'));
            }
          },
          onVoiceProfile: (profileName) => {
            setVoiceProfile(profileName);
            addLog(`${t('voiceProfileChanged')}: ${profileName}`, 'info');
          },
          onVoicePressure: (level) => {
            setVoicePressure(level);
            if (level !== 'normal') addLog(`Voice priority protection active: ${level}`, 'info');
          },
          onBans: (members) => setBannedMembers(members)
        }
      });

      roomRef.current = room;
      (window as typeof window & { __MHTALK_RTC_DIAGNOSTICS__?: () => unknown }).__MHTALK_RTC_DIAGNOSTICS__ = () => room.getRtcDiagnosticsHistory();
      setLocalPeerId(room.getLocalPeerId());
      setMessages((current) => [...current, systemMessage(cleanId, t('roomOpened'))]);
      await room.connect();
      window.setTimeout(() => flushMessageOutbox(cleanId), 500);
    } catch (error) {
      roomRef.current?.close();
      roomRef.current = null;
      activeRoomIdRef.current = '';
      setRoomId('');
      setConnection('failed');
      setConnectionLabel('state_failed');
      showError(String((error as Error)?.message || error || 'Could not open the room'));
    } finally {
      commandGateRef.current.leave('open-room');
      setBusy(false);
    }
  }

  async function createRoom() { await openRoom(generateRoomId()); }

  async function joinRoom() {
    const clean = normalizeRoomId(joinCode);
    if (!clean.startsWith('MHLKO-') || clean.length < 12) {
      showToast(t('invalidRoom'));
      return;
    }
    await openRoom(clean);
  }

  async function leaveRoomCommand(ask = true) {
    if (ask && !window.confirm(t('confirmEndCall'))) return;
    await stopScreenRecording(true);
    await roomRef.current?.cleanDisconnect();
    roomRef.current = null;
    activeRoomIdRef.current = '';
    setRoomId('');
    setConnection('idle');
    setConnectionLabel('state_idle');
    setPeers({});
    setPeerMedia({});
    setScreenStreams({});
    setMessages([]);
    setVoiceActive(false);
    setMicEnabled(false);
    setScreenSharing(false);
    setActivePeerId('');
    setPrivateTarget('');
    setReplyTo(null);
    setEditingMessage(null);
    setLocalPeerId('');
    setMicJoinPromptOpen(false);
    setIsRoomOwner(false);
    setOwnerPeerId('');
    setTypingUsers({});
    setHighlightedMessageId('');
    setPendingAttachments([]);
    pendingAttachmentKeysRef.current.clear();
    setBannedMembers([]);
    setBanModalOpen(false);
    setJoinRequests({});
    setJoinRequestsOpen(false);
    setRoomRoles({});
    setPendingVoice(null);
    try { await chatOverlayWindowRef.current?.close(); } catch { /* ignore */ }
    chatOverlayWindowRef.current = null;
    setChatOverlayExternal(false);
    setChatOverlayOpen(false);
    setAdminMutedPeers({});
    setGlobalMuteActive(false);
    globalMuteActiveRef.current = false;
    globalMuteSnapshotRef.current = null;
    forcedMutedByAdminRef.current = false;
    preForcedLocalMicEnabledRef.current = null;
    setHotkeysOpen(false);
    setErrorLogOpen(false);
    previousPeerIdsRef.current = new Set();
    autoOpenedJoinRequestIdsRef.current = new Set();
    seenReceiptSentRef.current = new Set();
  }

  async function leaveRoom(ask = true) {
    await runGuardedCommand('leave-room', () => leaveRoomCommand(ask));
  }

  async function sendChatCommand() {
    if (editingMessage) {
      const result = roomRef.current?.editMessage(editingMessage.id, draft, editingMessage.privateTo || undefined);
      if (!result) {
        showToast(t('chatDisconnected'));
        return;
      }
      setMessages((current) => {
        const next = current.map((message) => message.id === result.id ? { ...message, body: result.body, editedAt: result.editedAt } : message);
        const updated = next.find((message) => message.id === result.id);
        if (updated && settings?.saveChat) saveMessage(updated).catch(() => undefined);
        return next;
      });
      setDraft('');
      setEditingMessage(null);
      setShowEmoji(false);
      messageInputRef.current?.focus();
      return;
    }

    const hasText = Boolean(draft.trim());
    const hasFiles = pendingAttachments.length > 0;
    const hasVoice = Boolean(pendingVoice);
    if (!hasText && !hasFiles && !hasVoice) return;

    if (hasText) {
      const sent = roomRef.current?.sendChat(draft, privateTarget || undefined, replyTo ? makeReplyPreview(replyTo) : undefined);
      if (!sent) {
        showToast(t('chatDisconnected'));
        return;
      }
      roomRef.current?.sendTyping(false, privateTarget || undefined);
      setDraft('');
      setShowEmoji(false);
      setReplyTo(null);
      const pendingSent = { ...sent, deliveryStatus: 'sending' as const };
      setMessages((current) => [...current, pendingSent]);
      await enqueueMessageOutbox(pendingSent);
      if (settings?.saveChat) await saveMessage(pendingSent);
      markOutgoingSentSoon(sent.id);
      window.setTimeout(() => flushMessageOutbox(sent.roomId), 1_100);
    }

    if (hasFiles) {
      if (!sendingAttachmentsRef.current) await sendPendingAttachments();
    }
    if (pendingVoice) {
      const voice = pendingVoice;
      setPendingVoice(null);
      await sendVoiceBlob(voice.blob, voice.waveform);
    }
    messageInputRef.current?.focus();
  }

  async function sendChat() {
    await runGuardedCommand('send-chat', sendChatCommand);
  }

  async function queueAttachment(file: File) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      addLog(`Oversized file rejected before reading: ${file.name} (${Math.round(file.size / 1024 / 1024)}MB)`, 'info');
      showToast(t('attachmentRejected') || t('fileTooLarge'));
      return;
    }
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (pendingAttachmentKeysRef.current.has(key)) {
      showToast(t('attachmentAlreadyQueued') || 'Attachment already queued');
      return;
    }
    pendingAttachmentKeysRef.current.add(key);
    let preview: string | undefined;
    if (file.size <= INLINE_PREVIEW_MAX_BYTES && (file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/'))) {
      preview = await readFileAsDataUrl(file);
    }
    setPendingAttachments((current) => [...current, { id: nowId(), file, preview }]);
    showToast(t('attachmentQueued') || t('attachmentReady'));
    window.setTimeout(() => messageInputRef.current?.focus(), 20);
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files || []) as File[];
    const allowedFiles = files;
    if (!allowedFiles.length) return;
    event.preventDefault();
    for (const file of allowedFiles) await queueAttachment(file);
  }

  function containsDraggedFiles(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    if (Array.from(dataTransfer.types || []).includes('Files')) return true;
    return Array.from(dataTransfer.items || []).some((item) => item.kind === 'file');
  }

  function handleChatDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!containsDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDraggingAttachments(true);
  }

  function handleChatDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDraggingAttachments(false);
    }
  }

  async function handleChatDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!containsDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDraggingAttachments(false);
    const files = Array.from(event.dataTransfer?.files || []) as File[];
    if (!files.length) return;
    for (const file of files) await queueAttachment(file);
  }

  function cancelPendingAttachment(id: string) {
    setPendingAttachments((current) => {
      const removed = current.find((entry) => entry.id === id);
      if (removed) pendingAttachmentKeysRef.current.delete(`${removed.file.name}|${removed.file.size}|${removed.file.lastModified}`);
      return current.filter((entry) => entry.id !== id);
    });
    addLog('File transfer cancel requested', 'info');
  }

  async function sendPendingAttachments() {
    if (!roomRef.current || !pendingAttachments.length || sendingAttachmentsRef.current) return;
    const room = roomRef.current;
    const queued = [...pendingAttachments];
    const queuedIds = new Set(queued.map((item) => item.id));
    const targetPeerId = privateTarget || undefined;
    const replyPreview = replyTo ? makeReplyPreview(replyTo) : undefined;
    const startedAt = Date.now();

    sendingAttachmentsRef.current = true;
    setPendingAttachments((current) => current.filter((item) => !queuedIds.has(item.id)));
    setReplyTo(null);
    setMessages((current) => {
      const existingIds = new Set(current.map((message) => message.id));
      const optimistic = queued
        .filter((item) => !existingIds.has(item.id))
        .map((item, index): ChatMessage => {
          const mimeType = item.file.type || 'application/octet-stream';
          return {
            id: item.id,
            roomId,
            sender: 'me',
            senderName: profile?.display_name || t('me'),
            body: item.file.name,
            createdAt: startedAt + index,
            kind: messageKindFromMime(mimeType),
            fileName: item.file.name,
            mimeType,
            fileSize: item.file.size,
            transferredBytes: 0,
            uploadProgress: 0,
            fileStatus: 'sending',
            privateTo: targetPeerId,
            replyToId: replyPreview?.id,
            replyToBody: replyPreview?.body,
            replyToSender: replyPreview?.senderName,
            deliveryStatus: 'sending',
            deliveredTo: [],
            seenBy: []
          };
        });
      return optimistic.length ? [...current, ...optimistic] : current;
    });

    try {
      for (let index = 0; index < queued.length; index += 1) {
        const item = queued[index];
        const key = `${item.file.name}|${item.file.size}|${item.file.lastModified}`;
        outgoingAttachmentSourcesRef.current.set(item.id, { file: item.file, targetPeerId, replyTo: replyPreview });
        try {
          const sent = await room.sendFile(item.file.name, item.file.type || 'application/octet-stream', item.file, targetPeerId, {
            messageId: item.id,
            createdAt: startedAt + index,
            fileSize: item.file.size,
            replyTo: replyPreview,
            isCanceled: () => canceledAttachmentIdsRef.current.has(item.id),
            onProgress: (progress) => {
              if (roomRef.current !== room || canceledAttachmentIdsRef.current.has(item.id)) return;
              setMessages((current) => current.map((message) => message.id === item.id ? {
                ...message,
                fileStatus: 'sending',
                uploadProgress: progress,
                transferredBytes: Math.min(item.file.size, Math.round((item.file.size * progress) / 100))
              } : message));
            }
          });
          if (roomRef.current !== room) continue;
          if (canceledAttachmentIdsRef.current.has(item.id) || sent?.fileStatus === 'canceled') {
            setMessages((current) => current.map((message) => message.id === item.id
              ? { ...message, fileStatus: 'canceled', fileError: t('transferCanceled'), retryable: false }
              : message));
            continue;
          }
          if (!sent) {
            setMessages((current) => current.map((message) => message.id === item.id ? { ...message, fileStatus: 'failed', fileError: 'The attachment could not be sent.', retryable: true, deliveryStatus: 'sent' } : message));
            showToast(t('fileFailed'));
            continue;
          }
          const localPreviewUrl = (item.file.type.startsWith('image/') || item.file.type.startsWith('video/') || item.file.type.startsWith('audio/')) && !sent.dataUrl && !sent.localPath && sent.fileStatus !== 'failed'
            ? URL.createObjectURL(item.file)
            : undefined;
          const completed = { ...sent, dataUrl: sent.dataUrl || localPreviewUrl, deliveryStatus: 'sending' as const };
          setMessages((current) => {
            const exists = current.some((message) => message.id === item.id);
            return exists
              ? current.map((message) => message.id === item.id ? { ...message, ...completed, createdAt: message.createdAt } : message)
              : [...current, completed];
          });
          if (sent.fileStatus === 'failed') {
            if (settings?.saveChat) await saveMessage(sent);
            showToast(t('fileFailed'));
          } else {
            if (settings?.saveChat) await saveMessage(completed);
            markOutgoingSentSoon(sent.id);
            if (sent.fileStatus === 'awaiting-delivery') scheduleAttachmentReceiptTimeout(sent.id);
          }
        } catch (error) {
          addLog(`File upload failed: ${item.file.name}: ${String((error as Error)?.message || error)}`, 'error');
          if (roomRef.current === room) {
            setMessages((current) => current.map((message) => message.id === item.id ? { ...message, fileStatus: 'failed', fileError: String((error as Error)?.message || error), retryable: true, deliveryStatus: 'sent' } : message));
            showToast(t('fileFailed'));
          }
        } finally {
          pendingAttachmentKeysRef.current.delete(key);
          canceledAttachmentIdsRef.current.delete(item.id);
        }
      }
    } finally {
      sendingAttachmentsRef.current = false;
    }
  }

  async function cancelAttachmentTransfer(message: ChatMessage, persist = true) {
    if (!message.id) return;
    canceledAttachmentIdsRef.current.add(message.id);
    clearAttachmentReceiptTimer(message.id);
    await roomRef.current?.cancelFileTransfer(message.id).catch((error) => {
      addLog(`File cancellation failed: ${String((error as Error)?.message || error)}`, 'error');
    });
    let canceled: ChatMessage | undefined;
    setMessages((current) => current.map((item) => {
      if (item.id !== message.id) return item;
      canceled = {
        ...item,
        fileStatus: 'canceled',
        fileError: t('transferCanceled'),
        retryable: false,
        deliveryStatus: item.deliveryStatus || 'sent'
      };
      return canceled;
    }));
    if (persist && settings?.saveChat) {
      const saved = canceled || { ...message, fileStatus: 'canceled' as const, fileError: t('transferCanceled'), retryable: false };
      await saveMessage(saved).catch(() => undefined);
    }
    showToast(t('transferCanceled'));
  }

  async function retryAttachment(message: ChatMessage) {
    const source = outgoingAttachmentSourcesRef.current.get(message.id);
    if (!source || !roomRef.current) {
      showToast(t('retryAttachmentUnavailable'));
      return;
    }
    canceledAttachmentIdsRef.current.delete(message.id);
    try {
      await runGuardedCommand(`retry-attachment:${message.id}`, async () => {
      const room = roomRef.current;
      if (!room) throw new Error(t('chatDisconnected'));
      clearAttachmentReceiptTimer(message.id);
      setMessages((current) => current.map((item) => item.id === message.id
        ? { ...item, fileStatus: 'retrying', fileError: undefined, uploadProgress: 0, transferredBytes: 0 }
        : item));
      const sent = await room.sendFile(
        source.file.name,
        source.file.type || message.mimeType || 'application/octet-stream',
        source.file,
        source.targetPeerId,
        {
          messageId: message.id,
          createdAt: message.createdAt,
          fileSize: source.file.size,
          replyTo: source.replyTo,
          isCanceled: () => canceledAttachmentIdsRef.current.has(message.id),
          onProgress: (progress) => setMessages((current) => current.map((item) => item.id === message.id
            ? canceledAttachmentIdsRef.current.has(message.id) ? item : {
                ...item,
                fileStatus: 'sending',
                uploadProgress: progress,
                transferredBytes: Math.min(source.file.size, Math.round((source.file.size * progress) / 100))
              }
            : item))
        }
      );
      if (sent?.fileStatus === 'canceled' || canceledAttachmentIdsRef.current.has(message.id)) {
        setMessages((current) => current.map((item) => item.id === message.id
          ? { ...item, fileStatus: 'canceled', fileError: t('transferCanceled'), retryable: false }
          : item));
        return;
      }
      if (!sent || sent.fileStatus === 'failed') {
        const reason = sent?.fileError || 'The attachment retry failed.';
        setMessages((current) => current.map((item) => item.id === message.id
          ? { ...item, fileStatus: 'failed', fileError: reason, retryable: true }
          : item));
        throw new Error(reason);
      }
      setMessages((current) => current.map((item) => item.id === message.id
        ? { ...item, ...sent, dataUrl: item.dataUrl || sent.dataUrl, createdAt: item.createdAt, deliveryStatus: 'sending' }
        : item));
      if (settings?.saveChat) await saveMessage({ ...message, ...sent, deliveryStatus: 'sending' });
      scheduleAttachmentReceiptTimeout(message.id);
      });
    } finally {
      canceledAttachmentIdsRef.current.delete(message.id);
    }
  }

  async function sendVoiceBlob(blob: Blob, prebuiltWaveform?: number[]) {
    if (!roomRef.current) return;
    const voiceMimeType = blob.type.startsWith('audio/') ? blob.type : 'audio/webm';
    const voiceBlob = blob.type === voiceMimeType ? blob : new Blob([blob], { type: voiceMimeType });
    const dataUrl = await readFileAsDataUrl(voiceBlob);
    const waveform = prebuiltWaveform || await makeWaveform(voiceBlob);
    const sent = await roomRef.current.sendFile(`voice-${Date.now()}.webm`, voiceMimeType, dataUrl, privateTarget || undefined, { replyTo: replyTo ? makeReplyPreview(replyTo) : undefined, waveform });
    if (!sent) {
      showToast(t('voiceFailed'));
      return;
    }
    const pendingSent = { ...sent, deliveryStatus: 'sending' as const };
    setMessages((current) => [...current, pendingSent]);
    setReplyTo(null);
    if (settings?.saveChat) await saveMessage(pendingSent);
    markOutgoingSentSoon(sent.id);
  }

  async function finalizeCompanionVoiceRecording(recordingId: string) {
    if (!roomRef.current || !recordingId || voiceRecordStopInFlightRef.current) return;
    voiceRecordStopInFlightRef.current = true;
    try {
      const blob = await roomRef.current.stopVoiceMessageRecording(recordingId);
      companionVoiceRecordingIdRef.current = '';
      setRecording(false);
      if (blob.size < 256) {
        showToast(t('voiceFailed'));
        return;
      }
      const waveform = await makeWaveform(blob);
      const dataUrl = await readFileAsDataUrl(blob);
      setPendingVoice({ blob, dataUrl, waveform });
      window.setTimeout(() => messageInputRef.current?.focus(), 20);
    } catch (error) {
      companionVoiceRecordingIdRef.current = '';
      setRecording(false);
      const message = String((error as Error)?.message || error || t('recordingProblem'));
      addLog(`Voice message finalization failed: ${message}`, 'error');
      showError(message);
    } finally {
      voiceRecordStopInFlightRef.current = false;
    }
  }

  async function startVoiceRecording() {
    if (recording || companionVoiceRecordingIdRef.current || voiceRecordStartInFlightRef.current) return;
    if (forcedMutedByAdmin && !isRoomOwner) { showToast(t('mutedByAdmin')); return; }
    voiceRecordStopRequestedRef.current = false;
    voiceRecordStartInFlightRef.current = true;

    try {
      if (roomRef.current) {
        const started = await roomRef.current.startVoiceMessageRecording(activeSettings?.audioInputId || undefined);
        companionVoiceRecordingIdRef.current = started.recordingId;
        setRecording(true);
        addLog('Voice message is recording through the isolated MHTalkVoice microphone source', 'info');
        if (voiceRecordStopRequestedRef.current) await finalizeCompanionVoiceRecording(started.recordingId);
        return;
      }

      // This fallback is only used outside an active room. During calls, MHTalkVoice owns
      // the microphone so a second WebView capture cannot reset or mute the call track.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildRecorderMicConstraints(activeSettings?.audioInputId || undefined),
        video: false
      });
      recorderReleaseRef.current = () => stream.getTracks().forEach((track) => track.stop());
      recordedChunksRef.current = [];
      const mimeType = pickVoiceRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) recordedChunksRef.current.push(event.data); };
      recorder.onerror = () => {
        showError(t('recordingProblem'));
        try { recorderReleaseRef.current?.(); } catch { /* ignore */ }
        recorderReleaseRef.current = null;
        setRecording(false);
      };
      recorder.onstop = async () => {
        try { recorderReleaseRef.current?.(); } catch { /* ignore */ }
        recorderReleaseRef.current = null;
        setRecording(false);
        const blobType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(recordedChunksRef.current, { type: blobType });
        recordedChunksRef.current = [];
        if (blob.size < 256) { showToast(t('voiceFailed')); return; }
        const waveform = await makeWaveform(blob);
        const dataUrl = await readFileAsDataUrl(blob);
        setPendingVoice({ blob, dataUrl, waveform });
        window.setTimeout(() => messageInputRef.current?.focus(), 20);
      };
      recorder.start(250);
      setRecording(true);
      if (voiceRecordStopRequestedRef.current && recorder.state !== 'inactive') recorder.stop();
    } catch (error) {
      try { recorderReleaseRef.current?.(); } catch { /* ignore */ }
      recorderReleaseRef.current = null;
      companionVoiceRecordingIdRef.current = '';
      setRecording(false);
      const message = String((error as Error)?.message || error || t('recordingDenied'));
      addLog(`Voice message could not start: ${message}`, 'error');
      showError(message);
    } finally {
      voiceRecordStartInFlightRef.current = false;
    }
  }

  function stopVoiceRecordingPreview() {
    voiceRecordStopRequestedRef.current = true;
    const companionRecordingId = companionVoiceRecordingIdRef.current;
    if (companionRecordingId) {
      finalizeCompanionVoiceRecording(companionRecordingId).catch(() => undefined);
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function copyRoomId() {
    if (!roomId) return;
    await navigator.clipboard.writeText(roomId).catch(() => undefined);
    setRoomCopied(true);
    window.setTimeout(() => setRoomCopied(false), 1400);
    showToast(t('copied'));
  }

  async function toggleVoice() {
    if (!roomRef.current || !activeSettings) return;
    try {
      if (voiceActive) {
        await roomRef.current.stopVoice();
        setVoiceActive(false);
        setMicEnabled(false);
      } else {
        await startRoomVoice(roomRef.current);
        rememberMicAutoStartSuccess();
          setVoiceActive(true);
        setMicEnabled(true);
      }
    } catch {
      showToast(t('micPermission'));
    }
  }

  async function toggleMicMute() {
    if (!roomRef.current || !activeSettings) return;
    if (forcedMutedByAdmin && !isRoomOwner) { showToast(t('mutedByAdmin')); return; }
    if (!voiceActive) {
      try {
        await startRoomVoice(roomRef.current);
        rememberMicAutoStartSuccess();
          setVoiceActive(true);
        setMicEnabled(true);
      } catch { showToast(t('micPermission')); }
      return;
    }
    const next = !micEnabled;
    roomRef.current.setMicEnabled(next);
    setMicEnabled(next);
    if (!next) updateSpeaking(localPeerId, false);
  }

  async function startScreenShareOnly(): Promise<MediaStream | null> {
    if (!roomRef.current || !activeSettings) return null;
    if (screenSharing) return localScreenStream || roomRef.current.getLocalScreenStream() || null;
    if (activeSettings.screenQuality === 'audio-only') {
      showToast(t('audioOnlyHint'));
      return null;
    }
    await roomRef.current.startScreen(activeSettings.screenQuality, activeSettings.screenFps);
    if (cameraWithStreamArmedRef.current) await ensureCameraWithStreamOverlay();
    const stream = roomRef.current.getLocalScreenStream() || null;
    setLocalScreenStream(stream);
    setScreenSharing(true);
    playTone('screen-on');
    return stream;
  }

  async function stopScreenShareOnly() {
    if (!roomRef.current) return;
    // stop() closes MediaRecorder immediately; MP4 conversion continues while the broadcast is being closed.
    const finalizeRecording = stopScreenRecording(true);
    await roomRef.current.stopScreen();
    setScreenSharing(false);
    setLocalScreenStream(null);
    playTone('screen-off');
    await finalizeRecording;
  }

  async function toggleScreen() {
    if (!roomRef.current || !activeSettings) return;
    try {
      if (screenSharing) await stopScreenShareOnly();
      else await startScreenShareOnly();
    } catch {
      showToast(t('screenPermission'));
    }
  }

  async function refreshDevices() { setDevices(await listMediaDevices()); }

  async function clearCurrentChatCommand() {
    if (!roomId) return;
    await clearRoomMessages(roomId);
    setMessages([systemMessage(roomId, t('chatCleared'))]);
  }

  async function clearCurrentChat() {
    await runGuardedCommand('clear-chat', clearCurrentChatCommand);
  }

  async function wipeDataCommand() {
    if (!window.confirm(t('confirmWipe'))) return;
    await roomRef.current?.cleanDisconnect();
    await clearAllLocalData();
    clearDiagnostics();
    setErrorLog([]);
    const [loadedProfile, loadedSettings] = await Promise.all([loadProfile(), loadSettings()]);
    setProfile(loadedProfile);
    setSettingsState(loadedSettings);
    await leaveRoom(false);
    showToast(t('dataWiped'));
  }

  async function wipeData() {
    await runGuardedCommand('wipe-data', wipeDataCommand);
  }

  function handleSettingsTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, tab: SettingsTab) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = SETTINGS_TAB_ORDER.indexOf(tab);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? SETTINGS_TAB_ORDER.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + SETTINGS_TAB_ORDER.length) % SETTINGS_TAB_ORDER.length;
    const next = SETTINGS_TAB_ORDER[nextIndex];
    setSettingsTab(next);
    window.requestAnimationFrame(() => document.getElementById(`settings-tab-${next}`)?.focus());
  }

  async function toggleFullscreen() {
    const target = mediaBoxRef.current;
    if (!target) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await target.requestFullscreen();
  }

  async function openPictureInPicture() {
    if (document.pictureInPictureElement && document.exitPictureInPicture) {
      try { await document.exitPictureInPicture(); } catch { /* already closing */ }
      try {
        const appWindow = getCurrentWindow();
        await appWindow.show();
        await appWindow.unminimize();
        await appWindow.setFocus();
      } catch { /* window is already visible */ }
      setPipPeerId('');
      return;
    }
    const video = activeVideoRef.current as HTMLVideoElement & { requestPictureInPicture?: () => Promise<PictureInPictureWindow> };
    if (!video || !video.requestPictureInPicture) {
      showToast(t('pipUnsupported'));
      return;
    }
    try {
      await video.requestPictureInPicture();
      setPipPeerId(activePeer?.peerId || '');
      video.onleavepictureinpicture = () => {
        setPipPeerId('');
        const appWindow = getCurrentWindow();
        appWindow.show()
          .then(() => appWindow.unminimize())
          .then(() => appWindow.setFocus())
          .catch(() => undefined);
      };
    }
    catch { showToast(t('pipStartFirst')); }
  }

  async function openInstagram() {
    try { await openUrl(INSTAGRAM_URL); }
    catch { window.open(INSTAGRAM_URL, '_blank', 'noopener,noreferrer'); }
  }

  async function minimizeWindow() { await getCurrentWindow().minimize(); }
  async function toggleMaximizeWindow() { await getCurrentWindow().toggleMaximize(); }
  async function hideToTray() { await getCurrentWindow().hide(); }
  async function closeWindow(ask = true) {
    if (shutdownInProgressRef.current) {
      addLog('Graceful shutdown skipped duplicate request');
      allowWindowCloseRef.current = true;
      try { await getCurrentWindow().close(); } catch { /* ignore */ }
      window.setTimeout(() => { exit(0).catch(() => undefined); }, 80);
      return;
    }
    if (ask && roomId && !window.confirm(t('confirmCloseApp'))) return;
    shutdownInProgressRef.current = true;
    addLog('Graceful shutdown started');
    try {
      stopMicTest();
      try { await stopScreenRecording(false); } catch { /* ignore */ }
      try { await roomRef.current?.stopScreen(false); } catch { /* ignore */ }
      try { await roomRef.current?.stopVoice(); } catch { /* ignore */ }
      try { await invoke('stop_native_system_audio_excluding_self'); } catch { /* ignore */ }
      try { await roomRef.current?.cleanDisconnect(); } catch { /* ignore */ }
    } finally {
      addLog('Graceful shutdown completed');
      allowWindowCloseRef.current = true;
      try { await getCurrentWindow().close(); } catch { /* fall through to process exit */ }
      window.setTimeout(() => { exit(0).catch(() => undefined); }, 120);
    }
  }

  function setVolume(peerId: string, key: keyof PeerVolume, value: number | boolean) {
    setPeerVolumes((current) => ({
      ...current,
      [peerId]: { ...(current[peerId] || defaultVolume()), [key]: value }
    }));
  }

  function privateTargetName() {
    return privateTarget ? peers[privateTarget]?.displayName || t('friendFallback') : '';
  }


  function memberIsMuted(peerId: string) {
    return peerId === localPeerId ? Boolean(forcedMutedByAdmin || (voiceActive ? !micEnabled : false)) : Boolean(adminMutedPeers[peerId] || peerMedia[peerId]?.micEnabled === false);
  }

  function renderAvatar(peer: PeerProfile | { peerId: string; displayName: string; avatar?: string | null }) {
    const muted = memberIsMuted(peer.peerId);
    const speaking = speakingPeers[peer.peerId];
    return <span className={`profile-avatar-mini ${muted ? 'muted-avatar' : ''} ${speaking ? 'speaking-avatar' : ''}`} style={{ '--speak-color': speakingColor(peer.peerId) } as CSSProperties}>
      {peer.avatar ? <img src={peer.avatar} alt="avatar" /> : peer.displayName.slice(0, 1).toUpperCase()}
      {muted && <i className="mute-badge">🎙</i>}
    </span>;
  }


  async function deleteChatMessage(message: ChatMessage) {
    if (message.sender !== 'me' || message.deletedAt) return;
    if (!window.confirm(t('confirmDeleteMessage'))) return;
    if (message.fileStatus && ['queued', 'preparing', 'sending', 'receiving', 'retrying'].includes(message.fileStatus)) {
      await cancelAttachmentTransfer(message, false);
    }
    const result = roomRef.current?.deleteMessage(message.id, message.privateTo || undefined);
    if (!result) {
      showToast(t('chatDisconnected'));
      return;
    }
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, body: '', dataUrl: undefined, deletedAt: result.deletedAt } : item));
    if (settings?.saveChat) await markMessageDeleted(message.id, result.deletedAt);
  }

  function openBannedMembers() {
    roomRef.current?.requestBans();
    setBanModalOpen(true);
  }

  function unbanMember(peerId: string) {
    roomRef.current?.unbanPeer(peerId);
    setBannedMembers((current) => current.filter((member) => member.peerId !== peerId));
  }

  function kickPeer(peerId: string) {
    if (!canModerate) {
      showToast(t('ownerOnly'));
      return;
    }
    if (!window.confirm(t('kickConfirm'))) return;
    roomRef.current?.kickPeer(peerId);
    showToast(t('kickedMember'));
  }

  function approveJoin(peerId: string) {
    roomRef.current?.approveJoin(peerId);
    setJoinRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
  }

  function rejectJoin(peerId: string) {
    roomRef.current?.rejectJoin(peerId);
    setJoinRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
  }

  function promotePeer(peerId: string) {
    if (!isRoomOwner) { showToast(t('ownerOnly')); return; }
    roomRef.current?.promotePeer(peerId);
    showToast(t('promotedMember'));
  }

  function togglePublicMutePeer(peerId: string) {
    if (!canModerate) { showToast(t('ownerOnly')); return; }
    if (!peerId || peerId === localPeerId) return;
    const currentlyMuted = Boolean(adminMutedPeers[peerId]);
    if (currentlyMuted) {
      roomRef.current?.unmutePeerForRoom(peerId);
      setAdminMutedPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
      setPeerMedia((current) => ({ ...current, [peerId]: { ...(current[peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: true } }));
      addLog(`Admin/moderator public unmute: ${peerId}`, 'info');
      return;
    }
    roomRef.current?.mutePeerForRoom(peerId);
    setAdminMutedPeers((current) => ({ ...current, [peerId]: true }));
    setPeerMedia((current) => ({ ...current, [peerId]: { ...(current[peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: false } }));
    addLog(`Admin/moderator public mute: ${peerId}`, 'info');
  }

  function muteAllMembers() {
    if (!isRoomOwner) { showToast(t('ownerOnly')); return; }
    if (globalMuteActive) {
      const snapshot = globalMuteSnapshotRef.current || {};
      roomRef.current?.unmuteAllMembers();
      for (const peer of peerList) {
        if (snapshot[peer.peerId]) roomRef.current?.mutePeerForRoom(peer.peerId);
      }
      setAdminMutedPeers(snapshot);
      setPeerMedia((current) => {
        const next = { ...current };
        for (const peer of peerList) {
          const restoredMuted = Boolean(snapshot[peer.peerId]);
          next[peer.peerId] = { ...(next[peer.peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: !restoredMuted };
        }
        return next;
      });
      setGlobalMuteActive(false);
      globalMuteActiveRef.current = false;
      globalMuteSnapshotRef.current = null;
      setForcedMutedByAdmin(false);
      showToast(t('unmuteAllMembers'));
      addLog('Admin unmuted all members and restored original public mute states', 'info');
      return;
    }
    globalMuteSnapshotRef.current = { ...adminMutedPeers };
    setGlobalMuteActive(true);
    globalMuteActiveRef.current = true;
    roomRef.current?.muteAllMembers();
    const muted: Record<string, boolean> = {};
    for (const peer of peerList) if (peer.peerId !== localPeerId) muted[peer.peerId] = true;
    setForcedMutedByAdmin(false);
    setAdminMutedPeers(muted);
    setPeerMedia((current) => {
      const next = { ...current };
      for (const peer of peerList) next[peer.peerId] = { ...(next[peer.peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: false };
      return next;
    });
    showToast(t('adminMutedAll'));
    addLog('Admin muted all members and saved original mute states', 'info');
  }

  function requestToSpeak() {
    const now = Date.now();
    if (now - raiseHandLastAt < 15_000) { showToast(t('speakRequestCooldown')); addLog('Request to speak cooldown active', 'info'); return; }
    setRaiseHandLastAt(now);
    roomRef.current?.requestToSpeak();
    showToast(t('requestedPermissionToSpeak'));
  }

  function allowToSpeak(peerId: string) {
    roomRef.current?.allowMemberToSpeak(peerId);
    setAdminMutedPeers((current) => { const next = { ...current }; delete next[peerId]; return next; });
    setPeerMedia((current) => ({ ...current, [peerId]: { ...(current[peerId] || { screenSharing: false, micEnabled: true, cameraSharing: false }), micEnabled: true } }));
    setSpeakRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
    addLog(`Admin allowed member to speak: ${peerId}`, 'info');
  }

  function rejectSpeak(peerId: string) {
    roomRef.current?.rejectSpeakRequest(peerId);
    setSpeakRequests((current) => { const next = { ...current }; delete next[peerId]; return next; });
    addLog(`Admin rejected speak request: ${peerId}`, 'info');
  }

  async function setDesktopOverlayInteractive(interactive: boolean) {
    overlayInteractiveRef.current = interactive;
    const current = settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay;
    const next = clampOverlaySettings({ ...current, interactive });
    setOverlayDraft((draft) => draft ? { ...draft, interactive } : draft);
    if (settings) await updateSettings({ ...settings, chatOverlay: next });
    if (chatOverlayOpen && chatOverlayExternal && chatOverlayWindowRef.current) {
      const geometry = await desktopChatOverlayGeometry(next);
      await hardenDesktopChatOverlayWindow(chatOverlayWindowRef.current, geometry, interactive);
      await emit('mhlko://chat-overlay-settings', next).catch(() => undefined);
      if (interactive) {
        try { await (chatOverlayWindowRef.current as any).setFocus?.(); } catch { /* native focus may be blocked by a protected fullscreen app */ }
      }
    }
    showToast(`${t('overlayModeChanged')}: ${interactive ? t('overlayInteractive') : t('overlayClickThrough')}`);
  }

  async function toggleChatOverlay() {
    if (chatOverlayOpen) {
      try { await hardenDesktopChatOverlayWindow(chatOverlayWindowRef.current as WebviewWindow, await desktopChatOverlayGeometry(settings?.chatOverlay), Boolean(settings?.chatOverlay?.interactive)); } catch { /* ignore before close */ }
      try { await chatOverlayWindowRef.current?.close(); } catch { /* overlay may already be closed */ }
      chatOverlayWindowRef.current = null;
      setChatOverlayExternal(false);
      setChatOverlayOpen(false);
      addLog(t('chatOverlayHidden'), 'info');
      return;
    }

    // 0.7.7: restore the 0.7.4 desktop-only chat overlay path exactly.
    // The overlay must be a true external Tauri WebviewWindow and must not fall
    // back into the main app UI, so screen overlays stay outside the app.
    setChatOverlayOpen(true);
    setChatOverlayExternal(true);
    try {
      const geometry = await desktopChatOverlayGeometry(settings?.chatOverlay);
      const overlay = new WebviewWindow('mhlko-chat-overlay', {
        url: '/?overlay=chat',
        title: 'MHTalk Chat Overlay',
        width: geometry.width,
        height: geometry.height,
        x: geometry.x,
        y: geometry.y,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: Boolean(settings?.chatOverlay?.interactive),
        focus: Boolean(settings?.chatOverlay?.interactive),
        visible: true,
        shadow: false
      } as any);
      chatOverlayWindowRef.current = overlay;
      const publish = async () => {
        await hardenDesktopChatOverlayWindow(overlay, geometry, Boolean(settings?.chatOverlay?.interactive));
        await emit('mhlko://chat-overlay-settings', settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay).catch(() => undefined);
        await emit('mhlko://chat-overlay-update', overlayMessages).catch(() => undefined);
      };
      try {
        overlay.once('tauri://created', () => {
          publish().catch(() => undefined);
          addLog(`${t('chatOverlayShown')} desktop-always-on-top`, 'info');
        }).catch(() => undefined);
        overlay.once('tauri://error', () => {
          chatOverlayWindowRef.current = null;
          setChatOverlayExternal(false);
          setChatOverlayOpen(false);
          addLog('Chat overlay desktop window failed; in-app overlay is disabled to keep overlay outside the app only.', 'error');
          showToast(t('chatOverlayHidden'));
        }).catch(() => undefined);
      } catch {
        publish().catch(() => undefined);
      }
      window.setTimeout(() => publish().catch(() => undefined), 450);
    } catch {
      chatOverlayWindowRef.current = null;
      setChatOverlayExternal(false);
      setChatOverlayOpen(false);
      addLog('Chat overlay desktop window unavailable; in-app overlay is disabled to keep overlay outside the app only.', 'error');
      showToast(t('chatOverlayHidden'));
    }
  }


  function updateOverlayDraft(partial: Partial<ChatOverlaySettings>) {
    setOverlayDraft((current) => clampOverlaySettings({ ...(current || settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay), ...partial }));
  }

  async function saveOverlayDraft() {
    const next = clampOverlaySettings(overlayDraft || settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay);
    updateDraftSettings({ chatOverlay: next });
    if (settings) await updateSettings({ ...settings, chatOverlay: next });
    setOverlayEditorOpen(false);
    if (chatOverlayOpen && chatOverlayExternal && chatOverlayWindowRef.current) {
      const geometry = await desktopChatOverlayGeometry(next);
      await hardenDesktopChatOverlayWindow(chatOverlayWindowRef.current, geometry, next.interactive);
      await emit('mhlko://chat-overlay-settings', next).catch(() => undefined);
    }
    showToast(t('overlayPersisted'));
  }

  function updateCameraDraft(partial: Partial<CameraOverlaySettings>) {
    setCameraDraft((current) => {
      const next = clampCameraSettings({ ...(current || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY), ...partial });
      if (cameraOpen && cameraMode === 'camera-with-stream') roomRef.current?.updateCameraOverlay(next);
      return next;
    });
  }

  function cameraPreviewStyle(draft: CameraOverlaySettings): CSSProperties {
    const visibleWidth = Math.max(20, 100 - draft.cropLeftPercent - draft.cropRightPercent);
    const visibleHeight = Math.max(20, 100 - draft.cropTopPercent - draft.cropBottomPercent);
    return {
      objectFit: draft.fitMode,
      position: 'absolute',
      width: `${10000 / visibleWidth}%`,
      height: `${10000 / visibleHeight}%`,
      left: `${-draft.cropLeftPercent * 100 / visibleWidth}%`,
      top: `${-draft.cropTopPercent * 100 / visibleHeight}%`
    };
  }

  function cameraEdgePointer(
    event: ReactPointerEvent<HTMLButtonElement>,
    edge: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
  ) {
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget.parentElement;
    const mock = box?.parentElement;
    if (!box || !mock) return;
    const rect = mock.getBoundingClientRect();
    const start = clampCameraSettings(cameraDraft || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY);
    const startX = event.clientX;
    const startY = event.clientY;
    const includes = (direction: string) => edge.includes(direction);
    const onMove = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * 100;
      const dy = ((moveEvent.clientY - startY) / Math.max(1, rect.height)) * 100;
      if (cameraCustomizationMode === 'crop') {
        const cropFromVisualLeft = includes('w') ? dx : 0;
        const cropFromVisualRight = includes('e') ? -dx : 0;
        updateCameraDraft({
          cropTopPercent: includes('n') ? start.cropTopPercent + dy : start.cropTopPercent,
          cropRightPercent: start.cropRightPercent + (start.mirror ? cropFromVisualLeft : cropFromVisualRight),
          cropBottomPercent: includes('s') ? start.cropBottomPercent - dy : start.cropBottomPercent,
          cropLeftPercent: start.cropLeftPercent + (start.mirror ? cropFromVisualRight : cropFromVisualLeft)
        });
        return;
      }

      const isCorner = edge.length === 2;
      if (isCorner) {
        const ratio = start.widthPercent / Math.max(1, start.heightPercent);
        const horizontalWidth = includes('w') ? start.widthPercent - dx : start.widthPercent + dx;
        const verticalWidth = (includes('n') ? start.heightPercent - dy : start.heightPercent + dy) * ratio;
        const requestedWidth = Math.abs(horizontalWidth - start.widthPercent) >= Math.abs(verticalWidth - start.widthPercent)
          ? horizontalWidth
          : verticalWidth;
        const horizontalSpace = includes('w') ? start.xPercent + start.widthPercent : 100 - start.xPercent;
        const verticalSpace = includes('n') ? start.yPercent + start.heightPercent : 100 - start.yPercent;
        const maximumWidth = Math.min(70, horizontalSpace, verticalSpace * ratio);
        const width = Math.min(maximumWidth, Math.max(10, requestedWidth));
        const height = Math.min(70, Math.max(10, width / ratio));
        updateCameraDraft({
          widthPercent: width,
          heightPercent: height,
          xPercent: includes('w') ? start.xPercent + start.widthPercent - width : start.xPercent,
          yPercent: includes('n') ? start.yPercent + start.heightPercent - height : start.yPercent
        });
        return;
      }

      if (edge === 'w') {
        const x = Math.min(start.xPercent + start.widthPercent - 10, Math.max(0, start.xPercent + dx));
        updateCameraDraft({ xPercent: x, widthPercent: start.xPercent + start.widthPercent - x });
      } else if (edge === 'e') {
        updateCameraDraft({ widthPercent: Math.min(70, 100 - start.xPercent, Math.max(10, start.widthPercent + dx)) });
      } else if (edge === 'n') {
        const y = Math.min(start.yPercent + start.heightPercent - 10, Math.max(0, start.yPercent + dy));
        updateCameraDraft({ yPercent: y, heightPercent: start.yPercent + start.heightPercent - y });
      } else {
        updateCameraDraft({ heightPercent: Math.min(70, 100 - start.yPercent, Math.max(10, start.heightPercent + dy)) });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function resetCameraCustomization() {
    setCameraCustomizationMode('resize');
    setCameraDraft({ ...DEFAULT_CAMERA_OVERLAY });
  }

  function nudgeOverlayDraft(dx: number, dy: number) {
    const draft = clampOverlaySettings(overlayDraft || settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay);
    updateOverlayDraft({ xPercent: draft.xPercent + dx, yPercent: draft.yPercent + dy });
  }

  function growOverlayDraft() {
    const draft = clampOverlaySettings(overlayDraft || settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay);
    const ratio = draft.widthPercent / Math.max(1, draft.heightPercent);
    const nextWidth = Math.min(90, draft.widthPercent + 4);
    const nextHeight = Math.min(60, nextWidth / ratio);
    updateOverlayDraft({
      widthPercent: nextWidth,
      heightPercent: nextHeight,
      yPercent: Math.max(0, draft.yPercent - (nextHeight - draft.heightPercent))
    });
  }

  async function saveCameraDraft() {
    const next = clampCameraSettings(cameraDraft || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY);
    updateDraftSettings({ cameraOverlay: next });
    if (settings) await updateSettings({ ...settings, cameraOverlay: next });
    setCameraBox({ x: next.xPercent, y: next.yPercent, width: next.widthPercent, height: next.heightPercent });
    if (cameraOpen && cameraMode === 'camera-with-stream') roomRef.current?.updateCameraOverlay(next);
    setCameraSettingsOpen(false);
    showToast(t('overlayPersisted'));
  }

  function cameraMockPointer(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    event.preventDefault();
    const target = event.currentTarget.parentElement as HTMLDivElement | null;
    if (!target) return;
    const draft = clampCameraSettings(cameraDraft || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY);
    const rect = target.getBoundingClientRect();
    const start = { x: draft.xPercent, y: draft.yPercent, width: draft.widthPercent, height: draft.heightPercent };
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * 100;
      const dy = ((moveEvent.clientY - startY) / Math.max(1, rect.height)) * 100;
      if (mode === 'move') {
        const snap = (value: number, size: number) => {
          const clamped = Math.min(100 - size, Math.max(0, value));
          const edges = [0, 50 - size / 2, 100 - size];
          const nearest = edges.reduce((best, item) => Math.abs(item - clamped) < Math.abs(best - clamped) ? item : best, clamped);
          return Math.abs(nearest - clamped) <= 2.2 ? nearest : clamped;
        };
        updateCameraDraft({ xPercent: snap(start.x + dx, start.width), yPercent: snap(start.y + dy, start.height) });
      } else {
        const ratio = Math.max(0.25, start.width / Math.max(1, start.height));
        const requestedWidth = start.width + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * ratio);
        const widthPercent = Math.min(70, Math.max(10, requestedWidth));
        updateCameraDraft({ widthPercent, heightPercent: widthPercent / ratio });
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function overlayMockPointer(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    event.preventDefault();
    const target = event.currentTarget.parentElement as HTMLDivElement | null;
    if (!target) return;
    const draft = clampOverlaySettings(overlayDraft || settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay);
    const rect = target.getBoundingClientRect();
    const start = { x: draft.xPercent, y: draft.yPercent, width: draft.widthPercent, height: draft.heightPercent };
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / Math.max(1, rect.width)) * 100;
      const dy = ((moveEvent.clientY - startY) / Math.max(1, rect.height)) * 100;
      if (mode === 'move') updateOverlayDraft({ xPercent: start.x + dx, yPercent: start.y + dy });
      else updateOverlayDraft({ widthPercent: start.width + dx, heightPercent: start.height + dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }


  async function ensureCameraWithStreamOverlay(): Promise<MediaStream | null> {
    const room = roomRef.current;
    if (!room) return null;
    if (room.isCameraOverlayActive()) {
      const activeCamera = room.getLocalCameraStream() || null;
      if (activeCamera) {
        setCameraStream(activeCamera);
        setCameraOpen(true);
      }
      return activeCamera;
    }
    if (cameraOverlayStartPromiseRef.current) return cameraOverlayStartPromiseRef.current;
    const promise = (async () => {
      cameraSetupPreviewStream?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
      setCameraSetupPreviewStream(null);
      const deviceId = settingsForm.cameraInputId || settings?.cameraInputId || undefined;
      const stream = await room.startCameraOverlay(
        deviceId,
        clampCameraSettings(cameraDraft || settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY)
      );
      setCameraMode('camera-with-stream');
      cameraWithStreamArmedRef.current = true;
      setCameraWithStreamArmed(true);
      setCameraStream(stream);
      setCameraOpen(true);
      setCameraSettingsOpen(false);
      setLocalScreenStream(room.getLocalScreenStream() || null);
      return stream;
    })();
    cameraOverlayStartPromiseRef.current = promise;
    try { return await promise; }
    finally { if (cameraOverlayStartPromiseRef.current === promise) cameraOverlayStartPromiseRef.current = null; }
  }

  async function toggleCameraOverlay(nextMode: 'camera-only' | 'camera-with-stream' = cameraMode) {
    if (cameraOpen) {
      try { await roomRef.current?.stopCameraShare(true); } catch { /* ignore */ }
      try { cameraStream?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
      setCameraStream(null);
      setCameraOpen(false);
      if (nextMode === 'camera-with-stream') { cameraWithStreamArmedRef.current = false; setCameraWithStreamArmed(false); }
      return;
    }
    if (nextMode === 'camera-with-stream' && !screenSharing) {
      setCameraMode('camera-with-stream');
      cameraWithStreamArmedRef.current = true;
      setCameraWithStreamArmed(true);
      setCameraSettingsOpen(false);
      showToast(t('cameraWillStartWithStream'));
      addLog('Camera with stream armed; waiting for screen share', 'info');
      return;
    }
    try {
      if (nextMode === 'camera-with-stream') {
        await ensureCameraWithStreamOverlay();
        return;
      }
      cameraSetupPreviewStream?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
      setCameraSetupPreviewStream(null);
      const deviceId = settingsForm.cameraInputId || settings?.cameraInputId || undefined;
      setCameraMode(nextMode);
      const stream = roomRef.current
        ? await roomRef.current.startCameraShare(deviceId)
        : await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { ideal: deviceId } } : true, audio: false });
      setCameraStream(stream);
      setCameraOpen(true);
      setCameraSettingsOpen(false);
    } catch {
      showToast(t('cameraUnavailable'));
    }
  }

  function startCameraDrag(event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    event.preventDefault();
    const start = cameraBox;
    const startX = event.clientX;
    const startY = event.clientY;
    const parent = mediaBoxRef.current?.getBoundingClientRect();
    const width = parent?.width || 800;
    const height = parent?.height || 450;
    const move = (moveEvent: PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / width) * 100;
      const dy = ((moveEvent.clientY - startY) / height) * 100;
      let next: CameraBox;
      if (mode === 'move') {
        next = { ...start, x: Math.min(100 - start.width, Math.max(0, start.x + dx)), y: Math.min(100 - start.height, Math.max(0, start.y + dy)) };
      } else {
        const ratio = Math.max(0.25, start.width / Math.max(1, start.height));
        const nextWidth = Math.min(70, Math.max(12, start.width + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * ratio)));
        next = { ...start, width: nextWidth, height: nextWidth / ratio };
      }
      setCameraBox(next);
      if (cameraMode === 'camera-with-stream') {
        roomRef.current?.updateCameraOverlay(clampCameraSettings({
          ...(settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY),
          xPercent: next.x,
          yPercent: next.y,
          widthPercent: next.width,
          heightPercent: next.height
        }));
      }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }


  function troubleshootConnection() {
    if (!roomRef.current) return;
    roomRef.current.restartConnection();
    setConnection('reconnecting');
    setConnectionLabel('state_reconnecting');
    showToast(t('restartConnectionStarted'));
  }

  function showPeerStream(peerId: string) {
    if (!peerId) return;
    if (!peerMedia[peerId]?.screenSharing) {
      setPeerMenuId(peerMenuId === peerId ? '' : peerId);
      return;
    }
    const switching = Boolean(activePeerId && activePeerId !== peerId);
    setActiveMediaMode('screen');
    setActivePeerId(peerId);
    setPeerMenuId('');
    closedStreamPeersRef.current.delete(peerId);
    setStreamVolumeOpen(false);
    addLog(switching ? `Stream switched: ${peers[peerId]?.displayName || peerId}` : `${t('streamViewerOpened')}: ${peers[peerId]?.displayName || peerId}`, 'info');
  }

  function showPeerCamera(peerId: string) {
    if (!peerId) return;
    if (!peerMedia[peerId]?.cameraSharing) {
      setPeerMenuId(peerMenuId === peerId ? '' : peerId);
      return;
    }
    const switching = Boolean(activePeerId && (activePeerId !== peerId || activeMediaMode !== 'camera'));
    setActiveMediaMode('camera');
    setActivePeerId(peerId);
    setPeerMenuId('');
    closedStreamPeersRef.current.delete(peerId);
    setStreamVolumeOpen(false);
    addLog(switching ? `Camera view switched: ${peers[peerId]?.displayName || peerId}` : `${t('viewCamera')}: ${peers[peerId]?.displayName || peerId}`, 'info');
  }

  function closeCurrentStream() {
    if (activePeerId) {
      closedStreamPeersRef.current.add(activePeerId);
      addLog(`${t('streamViewerClosed')}: ${peers[activePeerId]?.displayName || activePeerId}`, 'info');
    }
    if (document.pictureInPictureElement && document.exitPictureInPicture) {
      document.exitPictureInPicture().catch(() => undefined);
    }
    setActivePeerId('');
    setPipPeerId('');
    setStreamVolumeOpen(false);
  }

  function streamActionLabel(peerId: string) {
    const isStreaming = Boolean(peerMedia[peerId]?.screenSharing || peerMedia[peerId]?.cameraSharing);
    if (!isStreaming) return '';
    if (activePeerId === peerId && streamViewerOpen) return activeMediaMode === 'camera' ? t('viewCamera') : t('watchingStream');
    if (activePeerId && activePeerId !== peerId && streamViewerOpen) return t('switchStream');
    return peerMedia[peerId]?.screenSharing ? t('openStream') : t('viewCamera');
  }

  function restartWatchedStream() {
    if (!roomRef.current || !activePeer?.peerId) return;
    const peerId = activePeer.peerId;
    setStreamRefreshTokens((current) => ({ ...current, [peerId]: (current[peerId] || 0) + 1 }));
    setScreenStreams((current) => ({ ...current }));
    roomRef.current.restartRemoteStream(peerId);
    showToast(t('watchedStreamRestarted'));
  }

  function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button,input,select,textarea,a,label')) return;
    getCurrentWindow().startDragging().catch(() => undefined);
  }

  function typingLabel() {
    if (!typingNames.length) return '';
    if (typingNames.length === 1) return `${typingNames[0]} ${t('typingOne')}`;
    const names = typingNames.slice(0, 2).join(t('typingSeparator'));
    return `${names} ${t('typingMany')}`;
  }

  if (!ready || !profile || !settings || !activeSettings) {
    return <main className="boot" dir="ltr"><div className="loader" /> <span>{t('boot')}</span></main>;
  }

  if (!updateGateChecked || requiredUpdate) {
    return <main className="boot forced-update-page" dir="ltr">
      <div className="profile-modal forced-update-modal startup-update-modal">
        <div className="forced-update-icon">↻</div>
        <h2>{requiredUpdate ? t('updateRequiredTitle') : t('checkingUpdates')}</h2>
        <p>{requiredUpdate ? t('updateAutoInstalling') : t('updateBootChecking')}</p>
        {requiredUpdate && <p className="mini">{t('updateAvailable')}: {requiredUpdate.version}</p>}
        {requiredUpdate?.notes && <pre className="update-notes">{requiredUpdate.notes}</pre>}
        {updateProgress && <p className="mini update-progress">{updateProgress}</p>}
        {updateBusy ? <div className="loader" /> : requiredUpdate ? <div className="update-gate-actions"><button className="primary-update-btn" onClick={() => installRequiredUpdate()}>{t('updateInstall')}</button><button onClick={() => checkForUpdates(true)}>{t('updateRetry')}</button></div> : <div className="update-gate-actions"><button onClick={() => checkForUpdates(true)}>{t('updateRetry')}</button><button onClick={continueOfflineFromUpdateGate}>{t('continueOffline')}</button></div>}
      </div>
    </main>;
  }

  return (
    <main className="app lang-en ltr-app" dir="ltr">
      <header className="titlebar" data-tauri-drag-region onMouseDown={startWindowDrag}>
        <div className={`pill state-${connection}`}>{displayConnectionLabel}</div>
        {roomId && connectionLabel !== 'state_waiting_approval' && ['connecting', 'reconnecting', 'disconnected', 'failed'].includes(connection) && <button className="troubleshoot-btn" onClick={troubleshootConnection}>{t('troubleshootConnection')}</button>}
        <div className="title-actions" data-tauri-drag-region>
          {roomId && canModerate && <button ref={joinBellRef} className="join-bell" onClick={() => setJoinRequestsOpen((open) => !open)} title={t('joinRequests')}>🔔{Object.keys(joinRequests).length > 0 && <b>{Object.keys(joinRequests).length}</b>}</button>}
          {roomId && !waitingForApproval && <button className="top-call-btn" onClick={toggleScreen} title={screenSharing ? t('stopShare') : t('shareScreen')}>{screenSharing ? '■' : '🖥️'}</button>}
          {roomId && !waitingForApproval && <button
            className={`top-call-btn screen-record-toggle ${screenRecorderState === 'recording' || screenRecorderState === 'paused' ? 'active recording' : ''} ${screenRecorderArmed ? 'armed' : ''} ${screenRecorderState === 'stopping' ? 'finalizing' : ''}`}
            onClick={() => toggleScreenRecorderToolbar().catch(() => undefined)}
            disabled={screenRecorderState === 'stopping'}
            title={screenRecorderState === 'recording' || screenRecorderState === 'paused' ? t('screenRecorderToolbarStop') : screenRecorderArmed ? t('screenRecorderArmed') : t('screenRecorderToolbarStart')}
          >
            {screenRecorderState === 'stopping' ? '…' : screenRecorderState === 'recording' || screenRecorderState === 'paused' ? '■' : '●'}
            {(screenRecorderState === 'recording' || screenRecorderState === 'paused') && <small>{formatRecorderDuration(screenRecorderElapsed)}</small>}
          </button>}
          {roomId && !waitingForApproval && <button className="top-call-btn" onClick={toggleMicMute} title={micEnabled ? t('muteMic') : t('unmuteMic')}>{micEnabled ? '🎙️' : '🔇'}</button>}
          {roomId && !waitingForApproval && <button className={`top-call-btn ${cameraOpen ? 'active' : ''}`} onClick={() => { if (cameraOpen) toggleCameraOverlay(cameraMode).catch(() => undefined); else setCameraModeChoiceOpen(true); }} title={t('cameraSettings')}>📷</button>}
          <button className="settings-icon-btn" onClick={() => setSettingsOpen(true)} title={t('settingsPanel')}>⚙</button>
          <button className="profile-chip" onClick={() => setProfileModalOpen(true)} title={t('profileSettings')}>
            <span className="profile-avatar-mini">{profile.avatar_data_url ? <img src={profile.avatar_data_url} alt="avatar" /> : profile.display_name.slice(0, 1).toUpperCase()}</span>
            <span>{profile.display_name}</span>
          </button>
          <div className="brand-mini" data-tauri-drag-region><strong>MHTalk</strong><span>{t('privateP2PRoom')}</span></div>
          <button className="win-btn" onClick={minimizeWindow} title={t('minimizeTitle')}>—</button>
          <button className="win-btn" onClick={toggleMaximizeWindow} title={t('maximizeTitle')}>□</button>
          <button className="win-btn" onClick={hideToTray} title={t('trayTitle')}>▾</button>
          <button className="win-btn close" onClick={() => closeWindow()} title={t('closeTitle')}>×</button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}

      <section className={`layout ${roomId ? '' : 'home-layout'}`}>
        <section className="panel main-panel">
          {!roomId ? (
            <div className="home">
              <h2>{t('startRoom')}</h2>
              <p>{t('startRoomDesc')}</p>
              <button className="primary big" disabled={busy} onClick={createRoom}>{t('createRoom')}</button>
              <div className="join-box">
                <input data-allow-context="true" placeholder="MHLKO-7K9A-X2QF" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && joinRoom()} />
                <button disabled={busy} onClick={joinRoom}>{t('joinRoom')}</button>
              </div>
            </div>
          ) : (
            <div className="room">
              <div className="room-head compact">
                <div>
                  <span className="mini">{t('roomId')}{isRoomOwner ? ` • ${t('adminBadge')}` : ownerPeerId ? '' : ''}</span>
                  <h2 className="room-code-line" data-allow-context="true"><span>{roomId}</span><button className="copy-room-icon" onClick={copyRoomId} title={roomCopied ? t('copied') : t('copyCode')} aria-label={roomCopied ? t('copied') : t('copyCode')}>{roomCopied ? '✓' : '📋'}</button></h2>
                </div>
                <div className="actions">
                  {isRoomOwner && peerList.length > 0 && <button onClick={muteAllMembers}>{globalMuteActive ? t('unmuteAllMembers') : t('muteAllMembers')}</button>}
                  {forcedMutedByAdmin && !isRoomOwner && <button onClick={requestToSpeak}>✋ {t('raiseHand')}</button>}
                  {roomId && !waitingForApproval && <button onClick={toggleChatOverlay}>{chatOverlayOpen ? t('hideChatOverlay') : t('showChatOverlay')}</button>}
                  <button className="danger" onClick={() => leaveRoom(true)}>{t('endCall')}</button>
                </div>
              </div>

              {waitingForApproval ? (
                <div className="approval-wait-screen">
                  <div className="m-loader"><span>M</span><i /><i /><i /></div>
                  <h3>{t('waitingApprovalTitle')}</h3>
                  <p>{t('waitingApprovalDesc')}</p>
                </div>
              ) : <>
              <div className={`top-stage ${mediaPanelOpen ? 'viewer-open' : 'viewer-hidden'}`}>
                {mediaPanelOpen && <div className="media-box" ref={mediaBoxRef}>
                  <MediaVideo stream={streamViewerOpen ? activeStream : undefined} active={streamViewerOpen && activeHasMedia} videoRef={activeVideoRef} audioEnabled={Boolean(activePeer?.peerId && pipPeerId === activePeer.peerId)} muted={activePeerVolume.screenMuted} volume={activePeerVolume.screen} outputId={settings.audioOutputId} refreshToken={activePeer?.peerId ? streamRefreshTokens[activePeer.peerId] || 0 : 0} />
                  {streamViewerOpen && <div className="screen-overlay"><button onClick={toggleFullscreen}>{isFullscreen ? t('exitFullscreen') : t('fullscreen')}</button><button className={pipPeerId ? 'pip-active' : ''} onClick={openPictureInPicture}>{pipPeerId ? t('pipBackToApp') : t('pip')}</button><button onClick={restartWatchedStream}>{t('restartWatchedStream')}</button><button onClick={closeCurrentStream}>{t('closeStream')}</button>{activePeer?.peerId && (() => { const volume = peerVolumes[activePeer.peerId] || defaultVolume(); return <div className={`stream-volume-control ${streamVolumeOpen ? 'open' : ''}`}><button onClick={() => setStreamVolumeOpen((open) => !open)} title={t('streamVolume')}>{volume.screenMuted ? '🔇' : '🔊'}</button><div className="stream-volume-pop"><button className="tiny-mute" onClick={() => setVolume(activePeer.peerId, 'screenMuted', !volume.screenMuted)}>{volume.screenMuted ? t('unmuteScreen') : t('muteScreen')}</button><input type="range" min="0" max="2" step="0.05" value={volume.screen} onChange={(e) => setVolume(activePeer.peerId, 'screen', Number(e.target.value))} /><small>{Math.round(volume.screen * 100)}%</small></div></div>; })()}</div>}
                  {!streamViewerOpen && localCameraPanelOpen && <div className="camera-only-stage"><span>{t('cameraOnly')}</span></div>}
                  {cameraOpen && cameraStream && cameraMode === 'camera-only' && <div className="camera-overlay-box" style={{ left: `${cameraBox.x}%`, top: `${cameraBox.y}%`, width: `${cameraBox.width}%`, height: `${cameraBox.height}%`, borderRadius: `${settings.cameraOverlay.borderRadius}px` }} onPointerDown={(event) => startCameraDrag(event, 'move')}>
                    <video ref={cameraVideoRef} autoPlay playsInline muted className={settings.cameraOverlay.mirror ? 'mirrored-camera' : ''} style={cameraPreviewStyle(clampCameraSettings(settings.cameraOverlay))} />
                    <button className="camera-close" onPointerDown={(e) => e.stopPropagation()} onClick={() => toggleCameraOverlay(cameraMode)}>×</button>
                    <span className="camera-resize" onPointerDown={(event) => startCameraDrag(event, 'resize')} />
                  </div>}
                </div>}

                <div className="member-circles">
                  <div className={`member-circle self local-member ${screenSharing || cameraOpen ? 'streaming-member' : ''} ${screenSharing && cameraOpen ? 'media-both' : cameraOpen ? 'media-camera' : screenSharing ? 'media-screen' : ''} ${memberIsMuted(localPeerId) ? 'muted-member' : ''}`} title={profile.display_name} onContextMenu={(event) => { if (!(screenSharing || cameraOpen)) return; event.preventDefault(); event.stopPropagation(); setSelfMediaMenu({ x: event.clientX, y: event.clientY }); }}>
                    {renderAvatar({ peerId: localPeerId, displayName: profile.display_name, avatar: profile.avatar_data_url })}
                    <small>{t('me')}</small>
                    {(screenSharing || cameraOpen) && <b>{cameraOpen && !screenSharing ? t('cameraOnly') : t('liveBadge')}</b>}{isRoomOwner ? <b>{t('adminBadge')}</b> : roomRoles[localPeerId] === 'moderator' ? <b>{t('moderatorBadge')}</b> : null}
                  </div>
                  {peerList.length === 0 ? <span className="mini waiting-member">{t('waitingForMembers')}</span> : peerList.map((peer) => {
                    const isStreaming = Boolean(peerMedia[peer.peerId]?.screenSharing || peerMedia[peer.peerId]?.cameraSharing);
                    const hasScreen = Boolean(peerMedia[peer.peerId]?.screenSharing);
                    const hasCamera = Boolean(peerMedia[peer.peerId]?.cameraSharing);
                    const action = streamActionLabel(peer.peerId);
                    const mediaClass = hasScreen && hasCamera ? 'media-both' : hasCamera ? 'media-camera' : hasScreen ? 'media-screen' : '';
                    return <div key={peer.peerId} role="button" tabIndex={0} className={`member-circle ${activePeerId === peer.peerId && streamViewerOpen ? 'active' : ''} ${isStreaming ? `streaming-member ${mediaClass}` : ''} ${memberIsMuted(peer.peerId) ? 'muted-member' : ''}`} onClick={() => { if (hasScreen && hasCamera) setPeerMenuId(peer.peerId); else if (hasScreen) showPeerStream(peer.peerId); else if (hasCamera) showPeerCamera(peer.peerId); }} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && isStreaming) { if (hasScreen && hasCamera) setPeerMenuId(peer.peerId); else if (hasScreen) showPeerStream(peer.peerId); else if (hasCamera) showPeerCamera(peer.peerId); } }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setPeerMenuId(peer.peerId); }} title={peer.displayName}>
                      {renderAvatar(peer)}
                      <small>{peer.displayName}</small>
                      {isStreaming && <b>{hasCamera && !hasScreen ? t('cameraOnly') : hasScreen && hasCamera ? t('cameraWithStream') : t('liveBadge')}</b>}{adminMutedPeers[peer.peerId] && <em className="admin-muted-badge">{t('memberMutedByAdmin')}</em>}{roomRoles[peer.peerId] === 'moderator' && <b>{t('moderatorBadge')}</b>}
                      {action && <button className="stream-card-action" onClick={(event) => { event.stopPropagation(); activePeerId === peer.peerId && streamViewerOpen ? closeCurrentStream() : hasScreen ? showPeerStream(peer.peerId) : showPeerCamera(peer.peerId); }}>{activePeerId === peer.peerId && streamViewerOpen ? t('closeStream') : action}</button>}
                    </div>;
                  })}
                </div>
                {peerMenuId && peers[peerMenuId] && (() => { const peer = peers[peerMenuId]; const volume = peerVolumes[peer.peerId] || defaultVolume(); const action = streamActionLabel(peer.peerId); return <div className="member-popover"><div className="member-popover-head">{renderAvatar(peer)}<strong>{peer.displayName}</strong><button onClick={() => setPeerMenuId('')}>×</button></div><button onClick={() => { setSelectedProfilePeerId(peer.peerId); setPeerMenuId(''); }}>{t('showProfile')}</button>{peerMedia[peer.peerId]?.screenSharing && <button onClick={() => showPeerStream(peer.peerId)}>{t('viewStream')}</button>}{peerMedia[peer.peerId]?.cameraSharing && <button onClick={() => showPeerCamera(peer.peerId)}>{t('viewCamera')}</button>}{action && activePeerId === peer.peerId && streamViewerOpen && <button onClick={closeCurrentStream}>{t('closeStream')}</button>}<button onClick={() => { setPrivateTarget(peer.peerId); setPeerMenuId(''); }}>{t('privateMessage')}</button>{canModerate && peer.peerId !== localPeerId && <button onClick={() => togglePublicMutePeer(peer.peerId)}>{adminMutedPeers[peer.peerId] ? t('unmuteForEveryone') : t('muteForEveryone')}</button>}{canModerate && peer.peerId !== localPeerId && <button className="danger" onClick={() => kickPeer(peer.peerId)}>{t('kickMember')}</button>}{isRoomOwner && roomRoles[peer.peerId] !== 'moderator' && <button onClick={() => promotePeer(peer.peerId)}>{t('promoteModerator')}</button>}<label>{t('callVolume')} {Math.round(volume.voice * 100)}%</label><input type="range" min="0" max="2" step="0.05" value={volume.voice} onChange={(e) => setVolume(peer.peerId, 'voice', Number(e.target.value))} /><button onClick={() => setVolume(peer.peerId, 'voiceMuted', !volume.voiceMuted)}>{volume.voiceMuted ? t('unmuteCall') : t('muteCall')}</button><label>{t('screenVolume')} {Math.round(volume.screen * 100)}%</label><input type="range" min="0" max="2" step="0.05" value={volume.screen} onChange={(e) => setVolume(peer.peerId, 'screen', Number(e.target.value))} /><button onClick={() => setVolume(peer.peerId, 'screenMuted', !volume.screenMuted)}>{volume.screenMuted ? t('unmuteScreen') : t('muteScreen')}</button></div>; })()}
              </div>

              <div className="chat">
                <div className={`messages chat-drop-zone${draggingAttachments ? ' dragging' : ''}`} onDragOver={handleChatDragOver} onDragLeave={handleChatDragLeave} onDrop={handleChatDrop}>
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      ref={(node) => { messageRefs.current[message.id] = node; }}
                      data-message-id={message.id}
                      className={`msg ${message.sender} ${message.kind || 'text'} ${highlightedMessageId === message.id ? 'highlight' : ''}`}
                    >
                      <span>{message.senderName}{message.privateTo || message.privateFrom ? ` • ${t('privateLabel')}` : ''}{message.editedAt ? ` • ${t('edited')}` : ''}</span>
                      {message.replyToId && <button className="reply-preview clickable" onClick={() => scrollToMessage(message.replyToId)}><b>{message.replyToSender}</b><em>{message.replyToBody}</em></button>}
                      {renderMessageContent(message, { onImageOpen: setImagePreview, onMediaContextMenu: openMediaContext, onFileMenu: openFileContext, onRetryFile: retryAttachment, onCancelFile: cancelAttachmentTransfer, t })}
                      {message.sender === 'me' && !message.deletedAt && !['sending', 'failed', 'canceled'].includes(message.fileStatus || '') && <div className={`delivery-status ${message.deliveryStatus === 'seen' ? 'seen' : ''}`}>
                        <span>{message.deliveryStatus === 'sending' ? '…' : message.deliveryStatus === 'sent' ? '✓' : '✓✓'}</span> {messageStatusText(message)}
                      </div>}
                      {message.sender !== 'system' && !message.deletedAt && <div className="msg-actions"><button className="reply-btn" onClick={() => { setEditingMessage(null); setReplyTo(message); }}>{t('reply')}</button>{message.sender === 'me' && message.kind === 'text' && <button className="reply-btn" onClick={() => beginEditMessage(message)}>{t('edit')}</button>}{message.sender === 'me' && <button className="reply-btn danger-mini" onClick={() => deleteChatMessage(message)}>{t('deleteMessage')}</button>}</div>}
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <div className="composer-wrap">
                  {privateTarget && <div className="private-bar">{t('privateTo')} {privateTargetName()} <button onClick={() => setPrivateTarget('')}>{t('cancel')}</button></div>}
                  {editingMessage && <div className="private-bar edit-bar">{t('editingMessage')}: {editingMessage.body} <button onClick={cancelEdit}>{t('cancel')}</button></div>}
                  {replyTo && !editingMessage && <div className="private-bar reply-bar">{t('replyTo')} {replyTo.senderName}: {messagePreviewText(replyTo)} <button onClick={() => setReplyTo(null)}>{t('cancel')}</button></div>}
                  {showEmoji && <div className="emoji-box">{EMOJIS.map((emoji) => <button key={emoji} onClick={() => { setDraft((current) => current + emoji); setShowEmoji(false); window.setTimeout(() => messageInputRef.current?.focus(), 0); }}>{emoji}</button>)}</div>}
                  {typingNames.length > 0 && <div className="typing-indicator">{typingLabel()}</div>}
                  {pendingVoice && <div className="voice-preview-card"><span>{t('voicePreview')}</span><div className="waveform">{pendingVoice.waveform.map((bar, index) => <i key={index} style={{ height: `${Math.max(8, Math.round(bar * 34))}px` }} />)}</div><audio className="hidden-audio voice-message-audio" src={pendingVoice.dataUrl} controls={false} hidden aria-hidden="true" tabIndex={-1} style={{ display: 'none' }} /><button onClick={() => setPendingVoice(null)}>{t('discardVoice')}</button></div>}
                  {pendingAttachments.length > 0 && <div className="pending-attachments">{pendingAttachments.map((item) => <div key={item.id} className="pending-card">{item.preview && item.file.type.startsWith('image/') ? <img src={item.preview} alt={item.file.name} /> : item.preview && item.file.type.startsWith('video/') ? <video src={item.preview} muted playsInline preload="metadata" /> : <span>{item.file.type.startsWith('video/') ? '🎬' : item.file.type.startsWith('audio/') ? '🎙️' : '📄'}</span>}<small>{formatBytes(item.file.size)}</small><button onClick={() => cancelPendingAttachment(item.id)}>×</button></div>)}</div>}
                  <div className="composer">
                    <input ref={attachInputRef} type="file" className="hidden-file" onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.currentTarget.value = '';
                      if (file) await queueAttachment(file);
                    }} />
                    <button title={t('emojiTitle')} onClick={() => setShowEmoji((value) => !value)}>😀</button>
                    <button title={t('attachTitle')} onClick={() => attachInputRef.current?.click()}>📎</button>
                    <button
                      className={recording ? 'danger' : ''}
                      title={t('holdVoiceHint')}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* optional */ }
                        startVoiceRecording().catch(() => undefined);
                      }}
                      onPointerUp={stopVoiceRecordingPreview}
                      onPointerCancel={stopVoiceRecordingPreview}
                      onLostPointerCapture={() => {
                        if (recording || voiceRecordStartInFlightRef.current) stopVoiceRecordingPreview();
                      }}
                    >{recording ? '■' : '🎙️'}</button>
                    <textarea data-allow-context="true" ref={messageInputRef} rows={1} value={draft} placeholder={privateTarget ? `${t('privateTo')} ${privateTargetName()}...` : t('writeMessage')} onPaste={handlePaste} onChange={handleDraftChange} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }} />
                    <button onClick={sendChat}>{editingMessage ? t('saveEdit') : t('send')}</button>
                  </div>
                </div>
              </div>
              </>}
            </div>
          )}
        </section>

        {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="profile-modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>{t('settingsPanel')}</h3><button onClick={() => setSettingsOpen(false)}>×</button></div>
            <div className="settings-top-tabs" role="tablist" aria-label={t('settingsPanel')}>
              {([
                ['voice', t('voiceSettings')],
                ['camera', t('cameraSettings')],
                ['recorder', t('screenRecorder')],
                ['hotkeys', t('hotkeys')],
                ['others', t('otherSettings')]
              ] as Array<[SettingsTab, string]>).map(([tab, label]) => <button key={tab} id={`settings-tab-${tab}`} role="tab" aria-controls={`settings-panel-${tab}`} aria-selected={settingsTab === tab} tabIndex={settingsTab === tab ? 0 : -1} className={settingsTab === tab ? 'active' : ''} onKeyDown={(event) => handleSettingsTabKeyDown(event, tab)} onClick={() => setSettingsTab(tab)}>{label}</button>)}
            </div>
            {settingsTab === 'recorder' && <div id="settings-panel-recorder" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-recorder"><button className="screen-recorder-open-btn" onClick={() => openScreenRecorderPanel().catch(() => undefined)}>
              <span className="screen-recorder-button-icon">●</span>
              <span><strong>{t('screenRecorder')}</strong><small>{t('screenRecorderSettingsOnly')}</small></span>
              {recoverableScreenRecordings.length > 0 && <em>{recoverableScreenRecordings.length}</em>}
            </button><p className="mini">{t('screenRecorderTabHint')}</p><button onClick={openScreenRecorderFolder}>{t('screenRecorderOpenFolder')}</button></div>}
            {settingsTab === 'hotkeys' && <div id="settings-panel-hotkeys" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-hotkeys"><p className="mini">{t('hotkeyTabHint')}</p><button className="primary" onClick={openHotkeysEditor}>{t('configureHotkeys')}</button></div>}
            {settingsTab === 'voice' && <div id="settings-panel-voice" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-voice">
            <button onClick={refreshDevices}>{t('refreshAudio')}</button>
            <label>{t('mic')}</label>
            <select value={settingsForm.audioInputId} onChange={(e) => updateDraftSettings({ audioInputId: e.target.value })}>
              <option value="">{t('defaultDevice')}</option>
              {devices.inputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Mic ${device.deviceId.slice(0, 5)}`}</option>)}
            </select>
            <label>{t('speaker')}</label>
            <select value={settingsForm.audioOutputId} onChange={(e) => updateDraftSettings({ audioOutputId: e.target.value })}>
              <option value="">{t('defaultDevice')}</option>
              {devices.outputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${device.deviceId.slice(0, 5)}`}</option>)}
            </select>
            <div className="mic-test-card">
              <div className="mic-test-head"><strong>{t('micTest')}</strong><button onClick={toggleMicTest}>{micTestActive ? t('micTestStop') : t('micTestStart')}</button></div>
              <p className="mini">{t('micTestHint')}</p>
              <div className="mic-level" title={t('micLevel')}><i style={{ width: `${Math.round(micTestLevel * 100)}%` }} /></div>
            </div>
            {voiceEngineStatus && <div className="mic-test-card native-voice-card hidden-settings-ui">
              <div className="mic-test-head"><strong>{t('nativeVoiceEngine')}</strong><span>{voiceEngineStatus.processName}</span></div>
              <p className="mini">{t('nativeVoiceEngineGroundwork')}</p><p className="mini native-voice-note">{voiceEngineStatus.note}</p>
            </div>}
            <div className={`mic-test-card voice-enhance-card ${settingsForm.voiceEnhanceEnabled ? 'active' : ''}`}>
              <div className="mic-test-head"><strong>{settingsForm.voiceEnhanceEnabled ? t('voiceEnhanceOff') : t('voiceEnhanceOn')}</strong><button onClick={() => updateDraftSettings({ voiceEnhanceEnabled: !settingsForm.voiceEnhanceEnabled })}>{settingsForm.voiceEnhanceEnabled ? t('voiceEnhanceOff') : t('voiceEnhanceOn')}</button></div>
              <p className="mini">{t('voiceEnhanceHint')}</p>
              <span className="voice-enhance-state">{settingsForm.voiceEnhanceEnabled ? t('voiceEnhanceEnabled') : t('voiceEnhanceDisabled')}</span>
            </div>
            {screenSharing && <p className="mini echo-guard-note">{t('echoGuardActive')}</p>}
            </div>}
            {settingsTab === 'camera' && <div id="settings-panel-camera" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-camera">
              <button onClick={refreshDevices}>{t('refreshDevices')}</button>
              <label>{t('cameraSource')}</label>
              <select value={settingsForm.cameraInputId || ''} onChange={(e) => updateDraftSettings({ cameraInputId: e.target.value })}>
                <option value="">{t('defaultDevice')}</option>
                {devices.cameras.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${device.deviceId.slice(0, 5)}`}</option>)}
              </select>
              <button className="overlay-editor-open" onClick={() => { setCameraDraft(clampCameraSettings(settingsForm.cameraOverlay)); setCameraSettingsOpen(true); }}>{t('cameraOverlayCustomize')}</button>
            </div>}
            {settingsTab === 'others' && <div id="settings-panel-others" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-others">
            <div className="toggle-row"><span>{t('notifications')}</span><input type="checkbox" checked={settingsForm.notificationsEnabled} onChange={(e) => updateDraftSettings({ notificationsEnabled: e.target.checked })} /></div>
            <label>{t('screenQuality')}</label>
            <select value={settingsForm.screenQuality} onChange={(e) => updateDraftSettings({ screenQuality: e.target.value as ScreenQuality })}>
              {availableQualityOptions.map((quality) => <option key={quality} value={quality}>{quality === 'auto-max' ? t('autoMaxQuality') : quality === 'audio-only' ? t('audioOnly') : quality.toUpperCase()}</option>)}
            </select>
            <label>{t('screenFps')}</label>
            <select value={settingsForm.screenFps} onChange={(e) => updateDraftSettings({ screenFps: Number(e.target.value) as ScreenFps })}>
              {availableFpsOptions.map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}
            </select>
            <button className="overlay-editor-open" onClick={() => { setOverlayDraft(clampOverlaySettings(settingsForm.chatOverlay)); setOverlayEditorOpen(true); }}>{t('chatOverlayCustomize')}</button>
            <div className="toggle-row"><span>{t('saveChat')}</span><input type="checkbox" checked={settingsForm.saveChat} onChange={(e) => updateDraftSettings({ saveChat: e.target.checked })} /></div>
            <div className="toggle-row"><span>{t('historyForNewMembers')}</span><input type="checkbox" checked={Boolean(settingsForm.showHistoryForNewMembers)} onChange={(e) => updateDraftSettings({ showHistoryForNewMembers: e.target.checked })} /></div>
            <div className="toggle-row"><span>{t('lowInternet')}</span><input type="checkbox" checked={settingsForm.lowInternetMode} onChange={(e) => updateDraftSettings({ lowInternetMode: e.target.checked })} /></div>
            <div className="toggle-row"><span>{t('lowPc')}</span><input type="checkbox" checked={settingsForm.lowPcMode} onChange={(e) => updateDraftSettings({ lowPcMode: e.target.checked })} /></div>
            <div className="settings-modal-actions"><button className={`apply-settings-btn ${settingsDirty ? 'dirty' : 'clean'}`} onClick={applySettingsChanges}>{t('applySettings')}</button><button onClick={() => checkForUpdates(true)} disabled={updateBusy}>{updateBusy ? t('checkingUpdates') : t('checkUpdates')}</button><button onClick={openHotkeysEditor}>{t('hotkeys')}</button><button onClick={() => setErrorLogOpen(true)}>{t('errorLog')}</button>{canModerate && <button onClick={openBannedMembers}>{t('bannedMembers')}</button>}<button onClick={clearCurrentChat} disabled={!roomId}>{t('deleteRoomHistory')}</button><button className="danger" onClick={wipeData}>{t('deleteAllLocalData')}</button></div>
            </div>}
            {updateProgress && <p className="mini update-progress">{updateProgress}</p>}
            <h3 className="side-title hidden-settings-ui">{t('friendsInRoom')}</h3>
            <div className="peer-list settings-peer-list hidden-settings-ui">
              {peerList.length === 0 && <p className="mini">{t('nobody')}</p>}
              {peerList.map((peer) => { const volume = peerVolumes[peer.peerId] || defaultVolume(); const action = streamActionLabel(peer.peerId); return <div key={peer.peerId} className="peer-control"><button className="peer-control-head" onContextMenu={(event) => { event.preventDefault(); setPeerMenuId(peer.peerId); }} onClick={() => setPeerMenuId(peerMenuId === peer.peerId ? '' : peer.peerId)}>{renderAvatar(peer)}<span>{peer.displayName}</span></button>{peerMenuId === peer.peerId && <div className="peer-menu"><button onClick={() => { setSelectedProfilePeerId(peer.peerId); setPeerMenuId(''); }}>{t('showProfile')}</button>{peerMedia[peer.peerId]?.screenSharing && <button onClick={() => showPeerStream(peer.peerId)}>{t('viewStream')}</button>}{peerMedia[peer.peerId]?.cameraSharing && <button onClick={() => showPeerCamera(peer.peerId)}>{t('viewCamera')}</button>}{action && activePeerId === peer.peerId && streamViewerOpen && <button onClick={closeCurrentStream}>{t('closeStream')}</button>}<button onClick={() => { setPrivateTarget(peer.peerId); setPeerMenuId(''); }}>{t('privateMessage')}</button>{canModerate && peer.peerId !== localPeerId && <button onClick={() => togglePublicMutePeer(peer.peerId)}>{adminMutedPeers[peer.peerId] ? t('unmuteForEveryone') : t('muteForEveryone')}</button>}{canModerate && peer.peerId !== localPeerId && <button className="danger" onClick={() => kickPeer(peer.peerId)}>{t('kickMember')}</button>}{isRoomOwner && roomRoles[peer.peerId] !== 'moderator' && <button onClick={() => promotePeer(peer.peerId)}>{t('promoteModerator')}</button>}<label>{t('callVolume')} {Math.round(volume.voice * 100)}%</label><input type="range" min="0" max="2" step="0.05" value={volume.voice} onChange={(e) => setVolume(peer.peerId, 'voice', Number(e.target.value))} /><button onClick={() => setVolume(peer.peerId, 'voiceMuted', !volume.voiceMuted)}>{volume.voiceMuted ? t('unmuteCall') : t('muteCall')}</button><label>{t('screenVolume')} {Math.round(volume.screen * 100)}%</label><input type="range" min="0" max="2" step="0.05" value={volume.screen} onChange={(e) => setVolume(peer.peerId, 'screen', Number(e.target.value))} /><button onClick={() => setVolume(peer.peerId, 'screenMuted', !volume.screenMuted)}>{volume.screenMuted ? t('unmuteScreen') : t('muteScreen')}</button></div>}</div>; })}
            </div>
          </div>
        </div>}


        {micJoinPromptOpen && <div className="modal-backdrop"><div className="profile-modal mic-join-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('micJoinTitle')}</h3></div><p className="mini">{t('micJoinDesc')}</p><div className="settings-modal-actions"><button className="primary" onClick={() => chooseRoomMic(true)}>{t('activateMicNow')}</button><button onClick={() => chooseRoomMic(false)}>{t('stayMuted')}</button></div></div></div>}

        {screenRecorderOpen && <div className="modal-backdrop screen-recorder-backdrop" onClick={() => setScreenRecorderOpen(false)}>
          <div className="profile-modal screen-recorder-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><h3>{t('screenRecorderTitle')}</h3><p className="mini">{t('screenRecorderSettingsOnly')}</p></div>
              <button onClick={() => setScreenRecorderOpen(false)}>×</button>
            </div>

            <div className="screen-recorder-settings-grid">
              <label><span>{t('screenRecorderQuality')}</span><select value={screenRecorderDraft.quality} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, quality: e.target.value as ScreenRecorderSettings['quality'] }))}><option value="adaptive">{t('screenRecorderQualityAdaptive')}</option><option value="high">{t('screenRecorderQualityHigh')}</option><option value="balanced">{t('screenRecorderQualityBalanced')}</option><option value="performance">{t('screenRecorderQualityPerformance')}</option></select></label>
              <label><span>{t('screenRecorderResolution')}</span><select value={screenRecorderDraft.resolution || 'auto'} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, resolution: e.target.value as ScreenRecorderSettings['resolution'] }))}>{availableRecorderResolutions.map((resolution) => <option key={resolution} value={resolution}>{resolution === 'auto' ? t('screenRecorderResolutionAuto') : resolution === '4k' ? '4K' : resolution}</option>)}</select><small>{t('screenRecorderResolutionHint')}</small></label>
              <label><span>{t('screenRecorderFps')}</span><select value={screenRecorderDraft.fps} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, fps: e.target.value === 'match' ? 'match' : Number(e.target.value) as ScreenRecorderSettings['fps'] }))}><option value="match">{t('screenRecorderFpsMatch')}</option><option value="60">60 FPS</option><option value="30">30 FPS</option><option value="15">15 FPS</option></select></label>
              <label><span>{t('screenRecorderCodec')}</span><select value={screenRecorderDraft.codec} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, codec: e.target.value as ScreenRecorderSettings['codec'] }))}><option value="auto">{t('screenRecorderCodecAuto')}</option><option value="h264">H.264 / MP4</option><option value="vp8">VP8</option><option value="vp9">VP9</option></select></label>
              <label><span>{t('recorderMicDevice')}</span><select value={screenRecorderDraft.micDeviceId} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, micDeviceId: e.target.value }))}><option value="">{t('defaultDevice')}</option>{devices.inputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId.slice(0, 8)}</option>)}</select></label>
              <label><span>{t('recorderOutputDevice')}</span><select value={screenRecorderDraft.outputDeviceId} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, outputDeviceId: e.target.value }))}><option value="">{t('defaultDevice')}</option>{devices.outputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId.slice(0, 8)}</option>)}</select></label>
              <div className="screen-recorder-switches">
                <label className="toggle-row"><span>{t('screenRecorderIncludeAudio')}</span><input type="checkbox" checked={screenRecorderDraft.includeAudio} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, includeAudio: e.target.checked }))} /></label>
                <label className="toggle-row"><span>{t('screenRecorderAutoStart')}</span><input type="checkbox" checked={screenRecorderDraft.autoStart} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, autoStart: e.target.checked }))} /></label>
              </div>
            </div>

            {screenRecorderDraft.includeAudio && <div className="recorder-mixer">
              {([
                ['mic', 'includeMic', 'micVolume', t('recorderMyMic')],
                ['members', 'includeMembers', 'membersVolume', t('recorderMembers')],
                ['system', 'includeSystem', 'systemVolume', t('recorderSystem')]
              ] as const).map(([levelKey, enabledKey, volumeKey, label]) => <div className="recorder-mixer-row" key={levelKey}>
                <button className={screenRecorderDraft[enabledKey] ? 'source-enabled' : 'source-muted'} title={t('recorderMuteSource')} onClick={() => setScreenRecorderDraft((current) => ({ ...current, [enabledKey]: !current[enabledKey] }))}>{screenRecorderDraft[enabledKey] ? '🔊' : '🔇'}</button>
                <strong>{label}</strong>
                <input type="range" min="0" max="2" step="0.01" disabled={!screenRecorderDraft[enabledKey]} value={screenRecorderDraft[volumeKey]} onChange={(event) => setScreenRecorderDraft((current) => ({ ...current, [volumeKey]: Number(event.target.value) }))} />
                <span>{Math.round(screenRecorderDraft[volumeKey] * 100)}%</span>
                <div className="recorder-level-meter"><i style={{ width: `${Math.round(screenRecorderLevels[levelKey] * 100)}%` }} /></div>
              </div>)}
              <label className="toggle-row recorder-auto-duck"><span>{t('recorderAutoDuck')}</span><input type="checkbox" checked={screenRecorderDraft.autoDuckSystem} onChange={(e) => setScreenRecorderDraft((current) => ({ ...current, autoDuckSystem: e.target.checked }))} /></label>
              <div className="recorder-master-level"><span>{t('recorderMasterMeter')}</span><div className="recorder-level-meter"><i style={{ width: `${Math.round(screenRecorderLevels.mixed * 100)}%` }} /></div></div>
            </div>}

            <p className="screen-recorder-note">{t('screenRecorderPerformanceNote')}</p>
            <p className="screen-recorder-note mp4-note">{t('screenRecorderMp4Hint')}</p>
            <div className={`screen-recorder-dependency dependency-${screenRecorderDependency.state}`}>
              <span>{screenRecorderDependency.state === 'ready' ? '✓' : screenRecorderDependency.state === 'error' ? '!' : '…'}</span>
              <strong>{screenRecorderDependency.state === 'ready' ? t('screenRecorderDependencyReady') : screenRecorderDependency.state === 'error' ? t('screenRecorderDependencyFailed') : t('screenRecorderDependencyPreparing')}</strong>
              {screenRecorderDependency.state === 'error' && screenRecorderDependency.message && <small>{screenRecorderDependency.message}</small>}
            </div>
            {screenRecorderFinalization && <p className="screen-recorder-note finalization-note">{screenRecorderFinalization}</p>}
            {screenRecorderError && <p className="screen-recorder-error">{screenRecorderError}</p>}
            {screenRecorderSavedPath && <div className="screen-recorder-path"><span>{t('screenRecorderFile')}</span><code>{screenRecorderSavedPath}</code><button className="primary" onClick={() => setScreenRecorderPlayerOpen(true)}>{t('screenRecorderPlay')}</button></div>}

            <div className="screen-recorder-actions">
              <button className="primary" onClick={saveScreenRecorderSettings}>{t('screenRecorderSaveSettings')}</button>
              <button className={recoverableScreenRecordings.length > 0 ? 'recovery-attention' : ''} onClick={() => openScreenRecorderRecoveryPanel().catch(() => undefined)}>{t('screenRecorderRepair')}{recoverableScreenRecordings.length > 0 ? ` (${recoverableScreenRecordings.length})` : ''}</button>
              <button onClick={openScreenRecorderFolder}>{t('screenRecorderOpenFolder')}</button>
              <button onClick={() => setScreenRecorderOpen(false)}>{t('cancel')}</button>
            </div>
          </div>
        </div>}

        {screenRecorderPlayerOpen && screenRecorderSavedPath && <div className="modal-backdrop screen-recorder-backdrop" onClick={() => setScreenRecorderPlayerOpen(false)}>
          <div className="profile-modal recording-player-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><h3>{t('screenRecorderPlaybackTitle')}</h3><p className="mini">{t('screenRecorderPlaybackHint')}</p></div><button onClick={() => setScreenRecorderPlayerOpen(false)}>×</button></div>
            <video key={screenRecorderSavedPath} src={convertFileSrc(screenRecorderSavedPath)} controls preload="metadata" playsInline />
            <div className="screen-recorder-path"><code>{screenRecorderSavedPath}</code></div>
            <div className="settings-modal-actions"><button onClick={openScreenRecorderFolder}>{t('screenRecorderOpenFolder')}</button><button onClick={() => setScreenRecorderPlayerOpen(false)}>{t('close')}</button></div>
          </div>
        </div>}

        {overlayEditorOpen && <aside className="customization-toolbar chat-customization-toolbar" aria-label={t('chatCustomizationControls')}>
          <strong>{t('moveControls')}</strong>
          <div className="direction-pad">
            <button aria-label={t('moveUp')} onClick={() => nudgeOverlayDraft(0, -2)}>↑</button>
            <button aria-label={t('moveLeft')} onClick={() => nudgeOverlayDraft(-2, 0)}>←</button>
            <button aria-label={t('moveDown')} onClick={() => nudgeOverlayDraft(0, 2)}>↓</button>
            <button aria-label={t('moveRight')} onClick={() => nudgeOverlayDraft(2, 0)}>→</button>
            <button aria-label={t('enlargeTopRight')} title={t('enlargeTopRight')} onClick={growOverlayDraft}>↗</button>
          </div>
          <button onClick={() => setOverlayDraft({ ...DEFAULT_SETTINGS.chatOverlay })}>{t('overlayReset')}</button>
        </aside>}

        {screenRecorderRecoveryOpen && <div className="modal-backdrop screen-recorder-backdrop" onClick={() => !screenRecorderRecoveryBusy && setScreenRecorderRecoveryOpen(false)}>
          <div className="profile-modal screen-recorder-recovery-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><h3>{t('screenRecorderRepairTitle')}</h3><p className="mini">{t('screenRecorderRepairHint')}</p></div>
              <button disabled={Boolean(screenRecorderRecoveryBusy)} onClick={() => setScreenRecorderRecoveryOpen(false)}>×</button>
            </div>
            <div className="screen-recorder-recovery-list">
              {recoverableScreenRecordings.length === 0 ? <p className="screen-recorder-empty-recovery">{t('screenRecorderNoRecovery')}</p> : recoverableScreenRecordings.map((item) => {
                const busyItem = screenRecorderRecoveryBusy === item.sessionId;
                const activeRecorder = ['recording', 'paused', 'starting', 'stopping'].includes(screenRecorderState);
                return <article key={item.sessionId} className={busyItem ? 'busy' : ''}>
                  <div className="screen-recorder-recovery-info">
                    <strong>{item.displayName}</strong>
                    <span>{t('screenRecorderRecoveryDate')}: {new Date(item.updatedAtMs || item.createdAtMs).toLocaleString()}</span>
                    <span>{t('screenRecorderRecoverySize')}: {formatBytes(item.size)} · {item.segmentCount} {t('screenRecorderRecoverySegments')}</span>
                  </div>
                  <div className="screen-recorder-recovery-actions">
                    <button className="primary" disabled={Boolean(screenRecorderRecoveryBusy) || activeRecorder} onClick={() => resumeRecoverableRecording(item)}>{busyItem ? t('screenRecorderFinalizingMp4') : t('screenRecorderResumePrevious')}</button>
                    <button className="danger" disabled={Boolean(screenRecorderRecoveryBusy) || activeRecorder} onClick={() => finalizeRecoverableRecording(item)}>{busyItem ? t('screenRecorderFinalizingMp4') : t('screenRecorderStopAndSaveMp4')}</button>
                  </div>
                </article>;
              })}
            </div>
          </div>
        </div>}


        {cameraModeChoiceOpen && <div className="modal-backdrop" onClick={() => setCameraModeChoiceOpen(false)}><div className="profile-modal camera-mode-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('cameraModeTitle')}</h3><button onClick={() => setCameraModeChoiceOpen(false)}>×</button></div><p className="mini">{t('cameraModeHint')}</p><div className="camera-mode-actions"><button className="primary" onClick={() => { setCameraMode('camera-only'); setCameraModeChoiceOpen(false); toggleCameraOverlay('camera-only').catch(() => undefined); }}>{t('cameraOnlyMode')}</button><button onClick={() => { setCameraMode('camera-with-stream'); setCameraDraft(settings?.cameraOverlay || DEFAULT_CAMERA_OVERLAY); setCameraModeChoiceOpen(false); setCameraSettingsOpen(true); }}>{t('cameraWithStream')}</button></div></div></div>}

        {cameraSettingsOpen && (() => {
          const draft = clampCameraSettings(cameraDraft || settingsForm.cameraOverlay || DEFAULT_CAMERA_OVERLAY);
          const previewStream = cameraOpen ? cameraStream : cameraSetupPreviewStream;
          const handles = [
            ['n', '↑'], ['ne', '↗'], ['e', '→'], ['se', '↘'],
            ['s', '↓'], ['sw', '↙'], ['w', '←'], ['nw', '↖']
          ] as const;
          return <div className="modal-backdrop" onClick={() => setCameraSettingsOpen(false)}>
            <div className="profile-modal overlay-editor-modal camera-settings-modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal-head"><h3>{t('cameraEditorTitle')}</h3><button onClick={() => setCameraSettingsOpen(false)}>×</button></div>
              <p className="mini">{cameraCustomizationMode === 'crop' ? t('cameraCropModeHint') : t('cameraResizeModeHint')}</p>
              <label>{t('cameraSource')}</label>
              <select value={draftSettings?.cameraInputId ?? settings?.cameraInputId ?? ''} onChange={(event) => updateDraftSettings({ cameraInputId: event.target.value })}>
                <option value="">{t('defaultDevice')}</option>
                {devices.cameras.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${device.deviceId.slice(0, 5)}`}</option>)}
              </select>
              <div className="camera-edit-mode-bar" role="group" aria-label={t('cameraEditMode')}>
                <button className={cameraCustomizationMode === 'resize' ? 'active' : ''} onClick={() => setCameraCustomizationMode('resize')}>{t('cameraResizeMode')}</button>
                <button className={cameraCustomizationMode === 'crop' ? 'active crop-active' : ''} onClick={() => setCameraCustomizationMode('crop')}>{t('cameraCropMode')}</button>
                <button onClick={resetCameraCustomization}>{t('restoreOriginal')}</button>
              </div>
              <div className={`overlay-screen-mock camera-handle-editor mode-${cameraCustomizationMode}`}>
                <div
                  className={`overlay-edit-box camera-edit-box ${cameraCustomizationMode === 'crop' ? 'crop-mode' : 'resize-mode'}`}
                  style={{ left: `${draft.xPercent}%`, top: `${draft.yPercent}%`, width: `${draft.widthPercent}%`, height: `${draft.heightPercent}%`, borderRadius: `${draft.borderRadius}px`, opacity: draft.opacity }}
                  onPointerDown={(event) => cameraMockPointer(event, 'move')}
                >
                  {previewStream && <div className="camera-preview-viewport">
                    <LocalMediaPreview stream={previewStream} className={`camera-composition-preview ${draft.mirror ? 'mirrored-camera' : ''}`} style={cameraPreviewStyle(draft)} />
                  </div>}
                  <span>{t('camera')}</span>
                  <em>{cameraCustomizationMode === 'crop' ? t('cameraCropping') : t('cameraDragHint')}</em>
                  {handles.map(([edge, arrow]) => <button
                    key={edge}
                    type="button"
                    className={`camera-edge-handle edge-${edge}`}
                    aria-label={`${cameraCustomizationMode === 'crop' ? t('cameraCropMode') : t('cameraResizeMode')} ${edge}`}
                    onPointerDown={(event) => cameraEdgePointer(event, edge)}
                  >{arrow}</button>)}
                </div>
              </div>
              <div className="overlay-controls">
                <label>{t('overlayBorderRadius')} <input type="range" min="0" max="50" step="1" value={draft.borderRadius} onChange={(event) => updateCameraDraft({ borderRadius: Number(event.target.value) })} /></label>
                <label>{t('cameraOpacity')} <input type="range" min="0.1" max="1" step="0.01" value={draft.opacity} onChange={(event) => updateCameraDraft({ opacity: Number(event.target.value) })} /></label>
                <label>{t('cameraFitMode')}<select value={draft.fitMode} onChange={(event) => updateCameraDraft({ fitMode: event.target.value === 'contain' ? 'contain' : 'cover' })}><option value="cover">{t('cameraFitCover')}</option><option value="contain">{t('cameraFitContain')}</option></select></label>
                <label><input type="checkbox" checked={draft.mirror} onChange={(event) => updateCameraDraft({ mirror: event.target.checked })} /> {t('cameraMirror')}</label>
              </div>
              <div className="settings-modal-actions">
                <button className="primary" onClick={() => toggleCameraOverlay(cameraMode)}>{cameraOpen ? t('cameraStop') : t('cameraStart')}</button>
                <button onClick={saveCameraDraft}>{t('applySettings')}</button>
                <button onClick={resetCameraCustomization}>{t('restoreOriginal')}</button>
                <button onClick={() => setCameraSettingsOpen(false)}>{t('cancel')}</button>
              </div>
            </div>
          </div>;
        })()}

        {overlayEditorOpen && (() => { const draft = clampOverlaySettings(overlayDraft || settingsForm.chatOverlay); return <div className="modal-backdrop" onClick={() => setOverlayEditorOpen(false)}><div className="profile-modal overlay-editor-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('overlayEditorTitle')}</h3><button onClick={() => setOverlayEditorOpen(false)}>×</button></div><p className="mini">{t('overlayEditorHint')}</p><div className="overlay-screen-mock"><div className="overlay-edit-box" style={{ left: `${draft.xPercent}%`, top: `${draft.yPercent}%`, width: `${draft.widthPercent}%`, height: `${draft.heightPercent}%`, opacity: draft.opacity, borderRadius: `${draft.borderRadius}px` }} onPointerDown={(event) => overlayMockPointer(event, 'move')}><span>MHTalk</span><em>{t('chatOverlayCustomize')}</em><i onPointerDown={(event) => overlayMockPointer(event, 'resize')} /></div></div><div className="overlay-controls"><label>{t('overlayOpacity')} <input type="range" min="0.15" max="1" step="0.01" value={draft.opacity} onChange={(e) => updateOverlayDraft({ opacity: Number(e.target.value) })} /></label><label>{t('overlayBorderRadius')} <input type="range" min="0" max="40" step="1" value={draft.borderRadius} onChange={(e) => updateOverlayDraft({ borderRadius: Number(e.target.value) })} /></label><label><input type="checkbox" checked={draft.showText} onChange={(e) => updateOverlayDraft({ showText: e.target.checked })} /> {t('overlayShowText')}</label><label><input type="checkbox" checked={draft.showImages} onChange={(e) => updateOverlayDraft({ showImages: e.target.checked })} /> {t('overlayShowImages')}</label><label><input type="checkbox" checked={draft.showAudio} onChange={(e) => updateOverlayDraft({ showAudio: e.target.checked })} /> {t('overlayShowAudio')}</label><label><input type="checkbox" checked={draft.interactive} onChange={(e) => updateOverlayDraft({ interactive: e.target.checked })} /> {draft.interactive ? t('overlayInteractive') : t('overlayClickThrough')}</label><label>{t('overlayMonitor')}<select value={draft.monitorName} onChange={(e) => updateOverlayDraft({ monitorName: e.target.value })}><option value="">{t('defaultDevice')}</option>{overlayMonitors.map((monitor) => <option key={monitor.name} value={monitor.name}>{monitor.label}</option>)}</select></label><p className="mini overlay-limit-note">{t('overlayFullscreenLimit')}</p></div><div className="settings-modal-actions"><button className="primary" onClick={saveOverlayDraft}>{t('applySettings')}</button><button onClick={() => setOverlayDraft(DEFAULT_SETTINGS.chatOverlay)}>{t('overlayReset')}</button><button onClick={() => setOverlayEditorOpen(false)}>{t('cancel')}</button></div></div></div>; })()}


        {hotkeysOpen && <div className="modal-backdrop" onClick={closeHotkeysEditor}><div className="profile-modal hotkey-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('hotkeys')}</h3><button onClick={closeHotkeysEditor}>×</button></div>{(['muteMic','toggleScreen','endCall','toggleFullscreen','toggleSettings','toggleOverlayMode'] as HotkeyAction[]).map((action) => <div className="hotkey-row" key={action}><span>{t(action === 'muteMic' ? 'muteMicHotkey' : action === 'toggleScreen' ? 'shareScreenHotkey' : action === 'endCall' ? 'endCallHotkey' : action === 'toggleFullscreen' ? 'fullscreenHotkey' : action === 'toggleOverlayMode' ? 'overlayModeHotkey' : 'toggleSettingsHotkey')}</span><button onClick={() => setLearningHotkey(action)}>{learningHotkey === action ? t('pressHotkey') : displayHotkey(hotkeyDraft[action] || '')}</button><button className="hotkey-clear" title={t('clearHotkey')} onClick={() => clearHotkey(action)}>×</button></div>)}{hotkeyValidationError && <p className="settings-validation-error" role="alert">{hotkeyValidationError}</p>}<div className="hotkey-actions"><button onClick={() => { setHotkeyDraft({ ...DEFAULT_HOTKEYS }); setHotkeyValidationError(''); }}>{t('resetHotkeys')}</button><button onClick={closeHotkeysEditor}>{t('cancel')}</button>{hotkeysDirty && <button className="primary" disabled={Boolean(hotkeyValidationError)} onClick={saveHotkeys}>{t('save')}</button>}</div></div></div>}

        {errorLogOpen && <div className="modal-backdrop" onClick={() => setErrorLogOpen(false)}><div className="profile-modal error-log-modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{t('errorLog')}</h3><button onClick={() => setErrorLogOpen(false)}>×</button></div><div className="error-log-actions"><button onClick={downloadErrorLog}>{t('downloadLog')}</button><button onClick={() => { clearDiagnostics(); setErrorLog([]); }}>{t('clearLog')}</button></div><div className="error-log-list">{errorLog.length === 0 ? <p className="mini">{t('noErrors')}</p> : errorLog.map((entry) => <pre key={entry.id} className={`log-${entry.level}`}>[{new Date(entry.at).toLocaleString()}] {logLevelText(entry.level)}
{localizeLogMessage(entry.message)}</pre>)}</div></div></div>}
      </section>

      {activeScreenAudioPeerId && (() => {
        const volume = peerVolumes[activeScreenAudioPeerId] || defaultVolume();
        return <BoostedAudioSink
          key={`screen-audio-${activeScreenAudioPeerId}`}
          stream={screenStreams[activeScreenAudioPeerId]}
          muted={volume.screenMuted || pipPeerId === activeScreenAudioPeerId}
          volume={volume.screen}
          outputId={settings.audioOutputId}
          refreshToken={streamRefreshTokens[activeScreenAudioPeerId] || 0}
        />;
      })()}

      {joinRequestsOpen && <div ref={joinPopoverRef} className="join-requests-popover">
        <h3>{t('joinRequests')}</h3>
        {(Object.values(joinRequests) as JoinRequest[]).length === 0 && <p className="mini">{t('noJoinRequests')}</p>}
        {(Object.values(joinRequests) as JoinRequest[]).map((request) => <div className="join-request-row" key={request.peerId}><span>{request.displayName}</span><button onClick={() => approveJoin(request.peerId)}>{t('approve')}</button><button className="danger" onClick={() => rejectJoin(request.peerId)}>{t('reject')}</button></div>)}
        {canModerate && Object.values(speakRequests).length > 0 && <><h3>{t('requestToSpeak')}</h3>{Object.values(speakRequests).map((request) => <div className="join-request-row speak-request-row" key={`speak-${request.peerId}`}><span>✋ {request.displayName}</span><button onClick={() => allowToSpeak(request.peerId)}>{t('allowToSpeak')}</button><button className="danger" onClick={() => rejectSpeak(request.peerId)}>{t('rejectSpeakRequest')}</button></div>)}</>}
      </div>}


      {chatOverlayOpen && !chatOverlayExternal && (() => { const config = settings?.chatOverlay || DEFAULT_SETTINGS.chatOverlay; return <div className="broadcast-chat-overlay" style={{ left: `${config.xPercent}%`, top: `${config.yPercent}%`, right: 'auto', bottom: 'auto', width: `${config.widthPercent}%`, height: `${config.heightPercent}%`, opacity: config.opacity, borderRadius: `${config.borderRadius}px` }}>
        {overlayMessages.length === 0 && <div className="overlay-item text"><b>MHTalk</b><span>{t('chatOverlayEmpty')}</span></div>}
        {overlayMessages.map((message, index) => <div key={`${message.senderName}-${index}`} className={`overlay-item ${message.kind || 'text'}`}><b>{message.senderName}</b>{message.kind === 'image' && message.dataUrl ? <img src={message.dataUrl} alt={message.body || 'media'} /> : message.kind === 'audio' ? <span>🎙️ {message.body}</span> : <span>{message.body}</span>}</div>)}
      </div>; })()}

      {mediaContextMenu && <div className="media-context-menu" style={{ left: mediaContextMenu.x, top: mediaContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <strong>{t('mediaContextTitle')}</strong>
        <button onClick={() => downloadMediaToDesktop(mediaContextMenu)}>{t('mediaDownloadToDesktop')}</button>
      </div>}

      {fileContextMenu && <div className="media-context-menu file-context-menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <strong>{t('fileActions')}</strong>
        <small>{safeDownloadName(fileContextMenu.message)}</small>
        {fileSaveProgress && <div className="file-save-progress"><span>{t('downloadProgress')} {fileSaveProgress.total > 0 ? `${Math.round((fileSaveProgress.written / fileSaveProgress.total) * 100)}%` : ''}</span><i style={{ width: `${fileSaveProgress.total > 0 ? Math.min(100, (fileSaveProgress.written / fileSaveProgress.total) * 100) : 8}%` }} /></div>}
        <button disabled={Boolean(fileSaveProgress)} onClick={() => persistMessageFile(fileContextMenu.message, 'desktop')}>{t('downloadToDesktop')}</button>
        <button disabled={Boolean(fileSaveProgress)} onClick={() => persistMessageFile(fileContextMenu.message, 'save-as')}>{t('saveAs')}</button>
      </div>}

      {selfMediaMenu && <div className="media-context-menu self-context-menu" style={{ left: selfMediaMenu.x, top: selfMediaMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <button onClick={() => { setSelfPreviewOpen(true); setSelfMediaMenu(null); }}>{t('previewMyMedia')}</button>
      </div>}

      {selfPreviewOpen && <div className="modal-backdrop" onClick={() => setSelfPreviewOpen(false)}>
        <div className="profile-modal self-preview-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><h3>{t('myMediaPreview')}</h3><button onClick={() => setSelfPreviewOpen(false)}>×</button></div>
          {!(screenSharing || cameraOpen) && <p className="mini">{t('noSelfMediaPreview')}</p>}
          <div className="self-preview-grid">
            <section>
              <h4>{t('myScreenPreview')}</h4>
              {screenSharing && localScreenStream ? <LocalMediaPreview stream={localScreenStream} className="self-preview-video" /> : <div className="self-preview-empty">{screenSharing ? t('localScreenPreviewHint') : t('stopShare')}</div>}
            </section>
            <section>
              <h4>{t('myCameraPreview')}</h4>
              {cameraOpen && cameraStream ? <LocalMediaPreview stream={cameraStream} className={`self-preview-video ${settings.cameraOverlay.mirror ? 'mirrored-camera' : ''}`} /> : <div className="self-preview-empty">{t('cameraStop')}</div>}
            </section>
            <section className="self-preview-audio">
              <h4>{t('myAudioPreview')}</h4>
              <p className="mini">{micEnabled ? t('unmuteMic') : t('muteMic')}</p>
              <button onClick={toggleMicTest}>{micTestActive ? t('micTestStop') : t('micTestStart')}</button>
              <div className="mic-test-meter"><i style={{ width: `${Math.round(micTestLevel * 100)}%` }} /></div>
            </section>
          </div>
        </div>
      </div>}

      {imagePreview && <div className="modal-backdrop image-modal-backdrop" onClick={() => setImagePreview(null)}>
        <div className="image-modal" onClick={(e) => e.stopPropagation()}>
          <button className="modal-x" onClick={() => setImagePreview(null)}>×</button>
          <img src={imagePreview.src} alt={imagePreview.name || 'image'} />
        </div>
      </div>}

      {banModalOpen && <div className="modal-backdrop" onClick={() => setBanModalOpen(false)}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><h3>{t('bannedMembers')}</h3><button onClick={() => setBanModalOpen(false)}>×</button></div>
          <div className="ban-list">
            {bannedMembers.length === 0 && <p className="mini">{t('noBannedMembers')}</p>}
            {bannedMembers.map((member) => <div className="ban-row" key={member.peerId}><span>{member.displayName}</span><button onClick={() => unbanMember(member.peerId)}>{t('unban')}</button></div>)}
          </div>
        </div>
      </div>}

      {selectedProfilePeerId && <div className="modal-backdrop" onClick={() => setSelectedProfilePeerId('')}>
        <div className="profile-modal public-profile-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-head"><h3>{t('showProfile')}</h3><button onClick={() => setSelectedProfilePeerId('')}>×</button></div>
          {selectedProfilePeer ? <>
            <div className="public-profile-avatar">{renderAvatar(selectedProfilePeer)}</div>
            <h2>{selectedProfilePeer.displayName}</h2>
            <p className="public-profile-status">{selectedProfilePeer.status || t('offline')}</p>
            <p className="public-profile-bio">{selectedProfilePeer.bio || t('profileBioUnavailable')}</p>
            <dl>
              <div><dt>{t('memberRole')}</dt><dd>{roomRoles[selectedProfilePeer.peerId] || selectedProfilePeer.role || 'member'}</dd></div>
              <div><dt>{t('memberId')}</dt><dd>{selectedProfilePeer.peerId.slice(0, 12)}</dd></div>
            </dl>
          </> : <p className="mini">{t('profileUnavailable')}</p>}
        </div>
      </div>}

      {profileModalOpen && <div className="modal-backdrop" onClick={() => setProfileModalOpen(false)}>
        <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><h3>{t('localAccount')}</h3><button onClick={() => setProfileModalOpen(false)}>×</button></div>
          <div className="banner" style={{ backgroundImage: profile.banner_data_url ? `url(${profile.banner_data_url})` : undefined }} />
          <div className="avatar-row modal-avatar">
            <div className="avatar circle">{profile.avatar_data_url ? <img src={profile.avatar_data_url} alt="avatar" /> : profile.display_name.slice(0, 1).toUpperCase()}</div>
            <div><strong>{profile.display_name}</strong><p>{profile.status || 'Online'}</p></div>
          </div>
          <label>{t('name')}</label>
          <input value={profile.display_name} onChange={(e) => updateProfile({ ...profile, display_name: e.target.value })} />
          <label>{t('email')}</label>
          <input value={profile.account_email} placeholder={t('placeholderEmail')} onChange={(e) => updateProfile({ ...profile, account_email: e.target.value })} />
          <label>{t('status')}</label>
          <input value={profile.status} onChange={(e) => updateProfile({ ...profile, status: e.target.value })} />
          <label>{t('bio')}</label>
          <textarea value={profile.bio} rows={3} onChange={(e) => updateProfile({ ...profile, bio: e.target.value })} />
          <div className="file-row">
            <label className="file-btn">{t('avatar')}<input type="file" accept="image/*" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file && file.size <= MAX_PROFILE_SOURCE_IMAGE_BYTES) await updateProfile({ ...profile, avatar_data_url: await readFileAsDataUrl(file) });
              else if (file) showToast(t('profileImageTooLarge'));
            }} /></label>
            <label className="file-btn">{t('banner')}<input type="file" accept="image/*" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file && file.size <= MAX_PROFILE_SOURCE_IMAGE_BYTES) await updateProfile({ ...profile, banner_data_url: await readFileAsDataUrl(file) });
              else if (file) showToast(t('profileImageTooLarge'));
            }} /></label>
          </div>
        </div>
      </div>}

      <div className="app-version-badge">v{APP_VERSION}</div>
      <button className="footer-credit" onClick={openInstagram}>MHTalk By: Mohammed Haliko (@m.ed1t)</button>
    </main>
  );
}
