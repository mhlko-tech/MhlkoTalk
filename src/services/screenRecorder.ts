import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ScreenRecorderSettings } from '../types/models';
import { recorderTargetLongEdge } from '../core/recordingQuality';

export type ScreenRecorderRuntimeState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'error';
export type RecorderDependencyState = 'missing' | 'downloading' | 'ready' | 'error';

export interface ScreenRecorderSourceInfo {
  width: number;
  height: number;
  sourceFps: number;
  recordingFps: number;
  videoBitrate: number;
  audioBitrate: number;
  mimeType: string;
  codecLabel: string;
}

export interface ScreenRecorderResult {
  path: string;
  size: number;
  finalizingMp4?: boolean;
  mp4Path?: string;
}

export interface ScreenRecorderAudioLevels {
  mic: number;
  members: number;
  system: number;
  mixed: number;
}

export interface RecoverableScreenRecording {
  sessionId: string;
  displayName: string;
  createdAtMs: number;
  updatedAtMs: number;
  size: number;
  segmentCount: number;
  outputPath: string;
}

export interface RecorderDependencyStatus {
  state: RecorderDependencyState;
  message: string;
}

export interface ScreenRecorderCallbacks {
  onState?: (state: ScreenRecorderRuntimeState) => void;
  onBytes?: (bytes: number) => void;
  onInfo?: (info: ScreenRecorderSourceInfo) => void;
  onSaved?: (result: ScreenRecorderResult) => void;
  onAudioLevels?: (levels: ScreenRecorderAudioLevels) => void;
  onFinalizationStage?: (stage: string, message?: string) => void;
  onError?: (message: string) => void;
}

export interface ScreenRecorderAudioOptions {
  inputDeviceId?: string;
  outputDeviceId?: string;
  voiceEnhanceEnabled?: boolean;
}

type NativeAudioChunk = {
  sequence: number;
  sample_rate: number;
  channels: number;
  format: string;
  data: string;
};

type BeginResult = {
  sessionId: string;
  finalPath: string;
  resumed: boolean;
};

type FinishResult = {
  path: string;
  size: number;
  finalizingMp4?: boolean;
  mp4Path?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function chooseMimeType(codec: ScreenRecorderSettings['codec'], hasAudio: boolean): { mimeType: string; label: string; container: 'mp4' | 'webm' } {
  const candidates: Array<{ mimeType: string; label: string; container: 'mp4' | 'webm' }> = [];
  if (codec === 'auto' || codec === 'h264') {
    if (hasAudio) {
      candidates.push({ mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'H.264/AAC', container: 'mp4' });
      candidates.push({ mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', label: 'H.264/AAC', container: 'mp4' });
    } else {
      candidates.push({ mimeType: 'video/mp4;codecs=avc1.42E01E', label: 'H.264', container: 'mp4' });
    }
    candidates.push({ mimeType: 'video/mp4', label: 'MP4', container: 'mp4' });
  }
  const codecs = codec === 'vp9' ? ['vp9'] : codec === 'vp8' ? ['vp8'] : ['vp8', 'vp9'];
  for (const name of codecs) {
    if (hasAudio) candidates.push({ mimeType: `video/webm;codecs=${name},opus`, label: `${name.toUpperCase()}/Opus`, container: 'webm' });
    candidates.push({ mimeType: `video/webm;codecs=${name}`, label: name.toUpperCase(), container: 'webm' });
  }
  candidates.push({ mimeType: 'video/webm', label: 'WebM', container: 'webm' });
  for (const candidate of candidates) {
    if (typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(candidate.mimeType)) return candidate;
  }
  return { mimeType: '', label: 'WebM', container: 'webm' };
}

function resolveRecordingFps(sourceFps: number, settings: ScreenRecorderSettings, lowPcMode: boolean): number {
  const safeSource = clamp(Math.round(sourceFps || 30), 8, 144);
  if (settings.fps !== 'match') return Math.min(safeSource, settings.fps);
  if (lowPcMode) return Math.min(safeSource, 15);
  const cores = Math.max(2, Number(navigator.hardwareConcurrency || 4));
  if (cores <= 4) return Math.min(safeSource, 30);
  return Math.min(safeSource, 60);
}

function resolveRecordingDimensions(sourceWidth: number, sourceHeight: number, settings: ScreenRecorderSettings, lowPcMode: boolean): { width: number; height: number } {
  const width = Math.max(1, Math.round(sourceWidth));
  const height = Math.max(1, Math.round(sourceHeight));
  const longEdge = Math.max(width, height);
  const cores = Math.max(2, Number(navigator.hardwareConcurrency || 4));
  let maxLongEdge = recorderTargetLongEdge(settings.resolution || 'auto', width, height, cores, lowPcMode);
  if (settings.resolution === 'auto' || !settings.resolution) {
    if (settings.quality === 'performance') maxLongEdge = Math.min(maxLongEdge, 1280);
    else if (settings.quality === 'balanced') maxLongEdge = Math.min(maxLongEdge, 1920);
  }
  if (longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

function resolveVideoBitrate(width: number, height: number, fps: number, settings: ScreenRecorderSettings, lowPcMode: boolean): number {
  const pixels = Math.max(640 * 360, width * height);
  const base = pixels * Math.max(15, fps) * 0.085;
  const qualityMultiplier = settings.quality === 'high' ? 1.35 : settings.quality === 'balanced' ? 0.9 : settings.quality === 'performance' ? 0.58 : 1;
  const cores = Math.max(2, Number(navigator.hardwareConcurrency || 4));
  const deviceFactor = settings.quality === 'adaptive'
    ? (lowPcMode ? 0.55 : cores <= 4 ? 0.65 : cores <= 8 ? 0.85 : 1)
    : (lowPcMode ? 0.72 : 1);
  const maximum = settings.quality === 'high' ? 40_000_000 : settings.quality === 'performance' ? 12_000_000 : 28_000_000;
  return Math.round(clamp(base * qualityMultiplier * deviceFactor, 1_500_000, maximum));
}

function makeFileName(): string {
  const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace('Z', '');
  return `MHTalk_Recording_${stamp}.mp4`;
}

export class ScreenRecorderController {
  private callbacks: ScreenRecorderCallbacks;
  private recorder: MediaRecorder | null = null;
  private recordingStream: MediaStream | null = null;
  private sessionId = '';
  private writeChain: Promise<void> = Promise.resolve();
  private bytesWritten = 0;
  private stopPromise: Promise<ScreenRecorderResult | null> | null = null;
  private stopResolve: ((value: ScreenRecorderResult | null) => void) | null = null;
  private state: ScreenRecorderRuntimeState = 'idle';
  private failed = false;
  private recordingAudioContext: AudioContext | null = null;
  private recordingAudioDestination: MediaStreamAudioDestinationNode | null = null;
  private recordingSystemGain: GainNode | null = null;
  private recordingMembersGain: GainNode | null = null;
  private recordingMicGain: GainNode | null = null;
  private recordingLimiter: DynamicsCompressorNode | null = null;
  private recordingAudioNextTime = { system: 0, members: 0 };
  private recordingSystemUnlisten: (() => void) | null = null;
  private recordingSystemErrorUnlisten: (() => void) | null = null;
  private recordingMembersUnlisten: (() => void) | null = null;
  private recordingMembersErrorUnlisten: (() => void) | null = null;
  private recordingMicStream: MediaStream | null = null;
  private recordingMicSource: MediaStreamAudioSourceNode | null = null;
  private recordingMicAnalyser: AnalyserNode | null = null;
  private recordingMembersAnalyser: AnalyserNode | null = null;
  private recordingSystemAnalyser: AnalyserNode | null = null;
  private recordingMixedAnalyser: AnalyserNode | null = null;
  private recordingMeterTimer = 0;
  private recordingNativeSystemStarted = false;
  private recordingNativeMembersStarted = false;
  private recordingSourceStream: MediaStream | null = null;
  private recordingMixerSettings: ScreenRecorderSettings | null = null;
  private recordingVideoElement: HTMLVideoElement | null = null;
  private recordingVideoCanvas: HTMLCanvasElement | null = null;
  private recordingVideoOutput: MediaStream | null = null;
  private recordingVideoFrameTimer = 0;
  private recordingVideoRefreshHandler: (() => void) | null = null;

  constructor(callbacks: ScreenRecorderCallbacks = {}) {
    this.callbacks = callbacks;
  }

  getState(): ScreenRecorderRuntimeState {
    return this.state;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setCallbacks(callbacks: ScreenRecorderCallbacks) {
    this.callbacks = callbacks;
  }

  private setState(state: ScreenRecorderRuntimeState) {
    this.state = state;
    this.callbacks.onState?.(state);
  }

  async start(source: MediaStream, settings: ScreenRecorderSettings, lowPcMode: boolean, resumeSessionId = '', audioOptions: ScreenRecorderAudioOptions = {}): Promise<ScreenRecorderSourceInfo> {
    if (this.state !== 'idle' && this.state !== 'error') throw new Error('screen recorder is already active');
    if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable');
    const sourceVideo = source.getVideoTracks().find((track) => track.readyState === 'live');
    if (!sourceVideo) throw new Error('screen stream has no active video track');

    this.failed = false;
    this.bytesWritten = 0;
    this.writeChain = Promise.resolve();
    this.setState('starting');

    const sourceSettings = sourceVideo.getSettings();
    const sourceWidth = Math.max(1, Number(sourceSettings.width || window.screen.width || 1920));
    const sourceHeight = Math.max(1, Number(sourceSettings.height || window.screen.height || 1080));
    const sourceFps = Math.max(1, Number(sourceSettings.frameRate || 30));
    const recordingFps = resolveRecordingFps(sourceFps, settings, lowPcMode);
    const target = resolveRecordingDimensions(sourceWidth, sourceHeight, settings, lowPcMode);
    const width = Math.max(2, target.width);
    const height = Math.max(2, target.height);
    // A stable canvas-backed recording track follows video-track replacements on
    // the shared MediaStream. This keeps camera-over-screen changes identical in
    // the file without restarting MediaRecorder or breaking A/V timestamps.
    const videoTrack = await this.createStableRecordingVideoTrack(source, width, height, recordingFps);

    const tracks: MediaStreamTrack[] = [videoTrack];
    if (settings.includeAudio) {
      const recordingAudioTrack = await this.createRecordingAudioTrack(source, audioOptions, settings);
      if (recordingAudioTrack) tracks.push(recordingAudioTrack);
    }
    this.recordingStream = new MediaStream(tracks);
    const hasAudio = this.recordingStream.getAudioTracks().length > 0;
    const codec = chooseMimeType(settings.codec, hasAudio);
    const videoBitrate = resolveVideoBitrate(width, height, recordingFps, settings, lowPcMode);
    const audioBitrate = hasAudio ? 192_000 : 0;

    let begin: BeginResult;
    try {
      begin = await invoke<BeginResult>('begin_screen_recording', {
        fileName: makeFileName(),
        mimeType: codec.mimeType || 'video/webm',
        resumeSessionId: resumeSessionId || null,
        width: Math.round(width),
        height: Math.round(height),
        fps: Math.round(recordingFps)
      });
      this.sessionId = begin.sessionId;
    } catch (error) {
      this.cleanupTracks();
      this.setState('error');
      throw error;
    }

    try {
      const options: MediaRecorderOptions = {
        videoBitsPerSecond: videoBitrate,
        audioBitsPerSecond: audioBitrate || undefined
      };
      if (codec.mimeType) options.mimeType = codec.mimeType;
      this.recorder = new MediaRecorder(this.recordingStream, options);
    } catch (error) {
      await invoke('cancel_screen_recording', { sessionId: this.sessionId }).catch(() => undefined);
      this.cleanupTracks();
      this.sessionId = '';
      this.setState('error');
      throw error;
    }

    const info: ScreenRecorderSourceInfo = {
      width,
      height,
      sourceFps,
      recordingFps,
      videoBitrate: this.recorder.videoBitsPerSecond || videoBitrate,
      audioBitrate: this.recorder.audioBitsPerSecond || audioBitrate,
      mimeType: this.recorder.mimeType || codec.mimeType || 'video/webm',
      codecLabel: codec.label
    };
    this.callbacks.onInfo?.(info);

    this.recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size <= 0 || !this.sessionId) return;
      const blob = event.data;
      const sessionId = this.sessionId;
      this.writeChain = this.writeChain.then(async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const written = await invoke<number>('append_screen_recording_chunk', bytes, {
          headers: { 'x-mhtalk-recording-id': sessionId }
        });
        this.bytesWritten = Number(written || this.bytesWritten + bytes.byteLength);
        this.callbacks.onBytes?.(this.bytesWritten);
      }).catch((error) => {
        this.failed = true;
        this.callbacks.onError?.(String((error as Error)?.message || error || 'recording write failed'));
      });
    };

    this.recorder.onerror = (event) => {
      this.failed = true;
      const error = (event as Event & { error?: DOMException }).error;
      this.callbacks.onError?.(error?.message || 'screen recording failed');
    };

    this.recorder.onstop = () => {
      this.finalize().catch((error) => {
        this.callbacks.onError?.(String((error as Error)?.message || error || 'recording finalize failed'));
        this.setState('error');
        this.resolveStop(null);
      });
    };

    try {
      // Two-second chunks are a good durability/performance balance. Rust flushes each chunk to disk.
      this.recorder.start(2000);
    } catch (error) {
      await invoke('cancel_screen_recording', { sessionId: this.sessionId }).catch(() => undefined);
      this.cleanup();
      this.setState('error');
      throw error;
    }
    this.setState('recording');
    return info;
  }

  pause() {
    if (this.recorder?.state !== 'recording') return;
    this.recorder.pause();
    this.setState('paused');
  }

  resume() {
    if (this.recorder?.state !== 'paused') return;
    this.recorder.resume();
    this.setState('recording');
  }

  async stop(): Promise<ScreenRecorderResult | null> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.recorder || this.recorder.state === 'inactive') return null;
    this.setState('stopping');
    this.stopPromise = new Promise<ScreenRecorderResult | null>((resolve) => { this.stopResolve = resolve; });
    try {
      this.recorder.requestData();
    } catch { /* final data will still be emitted by stop */ }
    this.recorder.stop();
    return this.stopPromise;
  }

  async preserve(): Promise<void> {
    const sessionId = this.sessionId;
    const recorder = this.recorder;
    if (recorder) {
      recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        // Keep ondataavailable alive until the stop event so the final browser
        // chunk reaches Rust before the session is sealed for recovery.
        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
          try { recorder.requestData(); } catch { /* stop still emits the final data */ }
          try { recorder.stop(); } catch { resolve(); }
        });
      }
    }
    await this.writeChain.catch(() => undefined);
    if (sessionId) await invoke('preserve_screen_recording', { sessionId }).catch(() => undefined);
    this.cleanup();
    this.setState('idle');
    this.resolveStop(null);
  }

  async cancel(): Promise<void> {
    const sessionId = this.sessionId;
    this.failed = true;
    if (this.recorder) {
      this.recorder.onstop = null;
      this.recorder.ondataavailable = null;
      this.recorder.onerror = null;
      try {
        if (this.recorder.state !== 'inactive') this.recorder.stop();
      } catch { /* ignore */ }
    }
    await this.writeChain.catch(() => undefined);
    if (sessionId) await invoke('cancel_screen_recording', { sessionId }).catch(() => undefined);
    this.cleanup();
    this.setState('idle');
    this.resolveStop(null);
  }

  private async finalize(): Promise<void> {
    const sessionId = this.sessionId;
    await this.writeChain;
    if (!sessionId) {
      this.cleanup();
      this.setState('idle');
      this.resolveStop(null);
      return;
    }
    if (this.failed) {
      await invoke('preserve_screen_recording', { sessionId }).catch(() => undefined);
      this.cleanup();
      this.setState('error');
      this.resolveStop(null);
      return;
    }
    const result = await invoke<FinishResult>('finish_screen_recording', { sessionId });
    this.callbacks.onSaved?.(result);
    this.cleanup();
    this.setState('idle');
    this.resolveStop(result);
  }

  private resolveStop(result: ScreenRecorderResult | null) {
    const resolve = this.stopResolve;
    this.stopResolve = null;
    this.stopPromise = null;
    resolve?.(result);
  }

  private async createStableRecordingVideoTrack(source: MediaStream, width: number, height: number, fps: number): Promise<MediaStreamTrack> {
    this.cleanupRecordingVideo();
    this.recordingSourceStream = source;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(width / 2) * 2);
    canvas.height = Math.max(2, Math.round(height / 2) * 2);
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context || typeof canvas.captureStream !== 'function') {
      const fallback = source.getVideoTracks().find((track) => track.readyState === 'live')?.clone();
      if (!fallback) throw new Error('screen recording video source is unavailable');
      try { fallback.contentHint = 'detail'; } catch { /* optional */ }
      return fallback;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    const bindSource = async () => {
      video.srcObject = null;
      video.srcObject = source;
      await video.play().catch(() => undefined);
    };
    await bindSource();
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => { cleanup(); reject(new Error('screen recording video preview timed out')); }, 8_000);
        const ready = () => { window.clearTimeout(timer); cleanup(); resolve(); };
        const failed = () => { window.clearTimeout(timer); cleanup(); reject(new Error('screen recording video preview failed')); };
        const cleanup = () => {
          video.removeEventListener('loadeddata', ready);
          video.removeEventListener('canplay', ready);
          video.removeEventListener('error', failed);
        };
        video.addEventListener('loadeddata', ready, { once: true });
        video.addEventListener('canplay', ready, { once: true });
        video.addEventListener('error', failed, { once: true });
      });
    }

    const output = canvas.captureStream(clamp(Math.round(fps), 8, 60));
    const outputTrack = output.getVideoTracks()[0];
    if (!outputTrack) throw new Error('screen recording compositor did not create a video track');
    try { outputTrack.contentHint = 'detail'; } catch { /* optional */ }

    const refresh = () => { bindSource().catch(() => undefined); };
    source.addEventListener('addtrack', refresh);
    source.addEventListener('removetrack', refresh);
    this.recordingVideoRefreshHandler = refresh;
    this.recordingVideoElement = video;
    this.recordingVideoCanvas = canvas;
    this.recordingVideoOutput = output;

    const frameInterval = 1000 / clamp(Math.round(fps), 8, 60);
    let lastFrameAt = 0;
    const render = (now: number) => {
      if (this.recordingVideoElement !== video) return;
      if (now - lastFrameAt >= frameInterval - 1 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        lastFrameAt = now;
        try {
          context.fillStyle = '#000';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch { /* keep the previous safe frame while the source switches */ }
      }
      this.recordingVideoFrameTimer = window.requestAnimationFrame(render);
    };
    this.recordingVideoFrameTimer = window.requestAnimationFrame(render);
    return outputTrack;
  }

  private cleanupRecordingVideo() {
    window.cancelAnimationFrame(this.recordingVideoFrameTimer);
    this.recordingVideoFrameTimer = 0;
    const source = this.recordingSourceStream;
    const refresh = this.recordingVideoRefreshHandler;
    if (source && refresh) {
      source.removeEventListener('addtrack', refresh);
      source.removeEventListener('removetrack', refresh);
    }
    this.recordingVideoRefreshHandler = null;
    try { this.recordingVideoElement?.pause(); } catch { /* ignore */ }
    if (this.recordingVideoElement) this.recordingVideoElement.srcObject = null;
    this.recordingVideoElement = null;
    this.recordingVideoOutput?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
    this.recordingVideoOutput = null;
    this.recordingVideoCanvas = null;
  }

  updateAudioMix(settings: ScreenRecorderSettings) {
    this.recordingMixerSettings = settings;
    const now = this.recordingAudioContext?.currentTime || 0;
    const apply = (node: GainNode | null, enabled: boolean, volume: number) => {
      if (!node) return;
      node.gain.cancelScheduledValues(now);
      node.gain.setTargetAtTime(enabled ? clamp(volume, 0, 2) : 0, now, 0.025);
    };
    apply(this.recordingMicGain, settings.includeMic, settings.micVolume);
    apply(this.recordingMembersGain, settings.includeMembers, settings.membersVolume);
    apply(this.recordingSystemGain, settings.includeSystem, settings.systemVolume);
  }

  private async createRecordingAudioTrack(source: MediaStream, options: ScreenRecorderAudioOptions, settings: ScreenRecorderSettings): Promise<MediaStreamTrack | undefined> {
    this.cleanupRecordingAudio();
    this.recordingSourceStream = source;
    this.recordingMixerSettings = settings;

    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return undefined;
      const context = new AudioContextClass({ sampleRate: 48_000 });
      await context.resume().catch(() => undefined);
      const destination = context.createMediaStreamDestination();
      const systemGain = context.createGain();
      const membersGain = context.createGain();
      const micGain = context.createGain();
      const limiter = context.createDynamicsCompressor();
      const systemAnalyser = context.createAnalyser();
      const membersAnalyser = context.createAnalyser();
      const micAnalyser = context.createAnalyser();
      const mixedAnalyser = context.createAnalyser();
      for (const analyser of [systemAnalyser, membersAnalyser, micAnalyser, mixedAnalyser]) {
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.72;
      }

      limiter.threshold.value = -4;
      limiter.knee.value = 8;
      limiter.ratio.value = 14;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.22;
      systemGain.connect(systemAnalyser).connect(limiter);
      membersGain.connect(membersAnalyser).connect(limiter);
      micGain.connect(micAnalyser).connect(limiter);
      limiter.connect(mixedAnalyser).connect(destination);

      this.recordingAudioContext = context;
      this.recordingAudioDestination = destination;
      this.recordingSystemGain = systemGain;
      this.recordingMembersGain = membersGain;
      this.recordingMicGain = micGain;
      this.recordingLimiter = limiter;
      this.recordingSystemAnalyser = systemAnalyser;
      this.recordingMembersAnalyser = membersAnalyser;
      this.recordingMicAnalyser = micAnalyser;
      this.recordingMixedAnalyser = mixedAnalyser;
      this.recordingAudioNextTime = { system: context.currentTime + 0.08, members: context.currentTime + 0.08 };
      this.updateAudioMix(settings);

      let sourceCount = 0;
      this.recordingSystemUnlisten = await listen<NativeAudioChunk>('mhlko://recording-system-audio-chunk', (event) => {
        this.feedRecordingAudioChunk('system', event.payload);
      });
      this.recordingMembersUnlisten = await listen<NativeAudioChunk>('mhlko://recording-members-audio-chunk', (event) => {
        this.feedRecordingAudioChunk('members', event.payload);
      });
      this.recordingSystemErrorUnlisten = await listen<string>('mhlko://recording-system-audio-error', (event) => {
        this.callbacks.onError?.(String(event.payload || 'isolated system recording audio unavailable'));
      });
      this.recordingMembersErrorUnlisten = await listen<string>('mhlko://recording-members-audio-error', (event) => {
        this.callbacks.onError?.(String(event.payload || 'member voice recording audio unavailable'));
      });

      if (settings.includeSystem) {
        try {
          await invoke('start_native_recording_system_audio');
          this.recordingNativeSystemStarted = true;
          sourceCount += 1;
        } catch (error) {
          this.callbacks.onError?.(`System/game recording bus unavailable: ${String(error)}`);
        }
      }
      if (settings.includeMembers) {
        try {
          await invoke('start_native_recording_members_audio');
          this.recordingNativeMembersStarted = true;
          sourceCount += 1;
        } catch (error) {
          this.callbacks.onError?.(`Member voice recording bus unavailable: ${String(error)}`);
        }
      }

      if (settings.includeMic) {
        try {
          const enhance = options.voiceEnhanceEnabled !== false;
          const micConstraints: MediaTrackConstraints = {
            echoCancellation: enhance,
            noiseSuppression: enhance,
            autoGainControl: enhance,
            sampleRate: { ideal: 48_000 },
            channelCount: { ideal: 1 }
          };
          const deviceId = options.inputDeviceId || settings.micDeviceId;
          if (deviceId) micConstraints.deviceId = { ideal: deviceId };
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints, video: false });
          const liveMic = micStream.getAudioTracks().find((track) => track.readyState === 'live');
          if (liveMic) {
            this.recordingMicStream = micStream;
            this.recordingMicSource = context.createMediaStreamSource(new MediaStream([liveMic]));
            this.recordingMicSource.connect(micGain);
            sourceCount += 1;
          } else {
            micStream.getTracks().forEach((track) => track.stop());
          }
        } catch (error) {
          this.callbacks.onError?.(`Recording microphone unavailable: ${String(error)}`);
        }
      }

      this.startRecordingMeters();
      const track = destination.stream.getAudioTracks()[0];
      if (!track || sourceCount === 0) {
        this.cleanupRecordingAudio();
        return undefined;
      }
      try { track.contentHint = 'music'; } catch { /* optional */ }
      return track;
    } catch {
      this.cleanupRecordingAudio();
      return undefined;
    }
  }

  private feedRecordingAudioChunk(bus: 'system' | 'members', chunk: NativeAudioChunk) {
    const context = this.recordingAudioContext;
    const gain = bus === 'system' ? this.recordingSystemGain : this.recordingMembersGain;
    if (!context || !gain || !chunk?.data) return;
    try {
      const binary = atob(chunk.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
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
      let nextTime = this.recordingAudioNextTime[bus];
      if (!nextTime || nextTime < now - 0.1 || nextTime > now + 1.0) nextTime = now + 0.06;
      const bufferSource = context.createBufferSource();
      bufferSource.buffer = buffer;
      bufferSource.connect(gain);
      bufferSource.onended = () => { try { bufferSource.disconnect(); } catch { /* ignore */ } };
      bufferSource.start(nextTime);
      this.recordingAudioNextTime[bus] = nextTime + buffer.duration;
    } catch { /* malformed native packet: drop only this packet */ }
  }

  private analyserLevel(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    return clamp(Math.sqrt(sum / Math.max(1, data.length)) * 3.5, 0, 1);
  }

  private startRecordingMeters() {
    window.clearInterval(this.recordingMeterTimer);
    this.recordingMeterTimer = window.setInterval(() => {
      const mic = this.analyserLevel(this.recordingMicAnalyser);
      const members = this.analyserLevel(this.recordingMembersAnalyser);
      const system = this.analyserLevel(this.recordingSystemAnalyser);
      const mixed = this.analyserLevel(this.recordingMixedAnalyser);
      const settings = this.recordingMixerSettings;
      if (settings?.autoDuckSystem && this.recordingSystemGain) {
        const voice = Math.max(mic, members);
        const base = settings.includeSystem ? clamp(settings.systemVolume, 0, 2) : 0;
        const target = voice > 0.09 ? base * 0.46 : base;
        this.recordingSystemGain.gain.setTargetAtTime(target, this.recordingAudioContext?.currentTime || 0, voice > 0.09 ? 0.06 : 0.24);
      }
      this.callbacks.onAudioLevels?.({ mic, members, system, mixed });
    }, 100);
  }

  private cleanupRecordingAudio() {
    if (this.recordingNativeSystemStarted) invoke('stop_native_recording_system_audio').catch(() => undefined);
    if (this.recordingNativeMembersStarted) invoke('stop_native_recording_members_audio').catch(() => undefined);
    this.recordingNativeSystemStarted = false;
    this.recordingNativeMembersStarted = false;
    for (const unlisten of [this.recordingSystemUnlisten, this.recordingSystemErrorUnlisten, this.recordingMembersUnlisten, this.recordingMembersErrorUnlisten]) {
      try { unlisten?.(); } catch { /* ignore */ }
    }
    this.recordingSystemUnlisten = null;
    this.recordingSystemErrorUnlisten = null;
    this.recordingMembersUnlisten = null;
    this.recordingMembersErrorUnlisten = null;
    window.clearInterval(this.recordingMeterTimer);
    this.recordingMeterTimer = 0;

    for (const node of [this.recordingMicSource, this.recordingSystemGain, this.recordingMembersGain, this.recordingMicGain, this.recordingLimiter, this.recordingSystemAnalyser, this.recordingMembersAnalyser, this.recordingMicAnalyser, this.recordingMixedAnalyser]) {
      try { node?.disconnect(); } catch { /* ignore */ }
    }
    this.recordingMicStream?.getTracks().forEach((track) => { try { track.stop(); } catch { /* ignore */ } });
    this.recordingMicStream = null;
    this.recordingMicSource = null;
    this.recordingSystemGain = null;
    this.recordingMembersGain = null;
    this.recordingMicGain = null;
    this.recordingLimiter = null;
    this.recordingSystemAnalyser = null;
    this.recordingMembersAnalyser = null;
    this.recordingMicAnalyser = null;
    this.recordingMixedAnalyser = null;

    const context = this.recordingAudioContext;
    this.recordingAudioContext = null;
    this.recordingAudioDestination = null;
    this.recordingAudioNextTime = { system: 0, members: 0 };
    this.recordingSourceStream = null;
    this.recordingMixerSettings = null;
    context?.close().catch(() => undefined);
    this.callbacks.onAudioLevels?.({ mic: 0, members: 0, system: 0, mixed: 0 });
  }

  private cleanupTracks() {
    this.cleanupRecordingVideo();
    this.cleanupRecordingAudio();
    this.recordingStream?.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* ignore */ }
    });
    this.recordingStream = null;
  }

  private cleanup() {
    this.cleanupTracks();
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onerror = null;
      this.recorder.onstop = null;
    }
    this.recorder = null;
    this.sessionId = '';
    this.writeChain = Promise.resolve();
    this.bytesWritten = 0;
    this.failed = false;
  }
}

export async function openScreenRecordingsFolder(): Promise<string> {
  return invoke<string>('open_screen_recordings_folder');
}

export async function listRecoverableScreenRecordings(): Promise<RecoverableScreenRecording[]> {
  return invoke<RecoverableScreenRecording[]>('list_recoverable_screen_recordings');
}

export async function finalizeRecoverableScreenRecording(sessionId: string): Promise<ScreenRecorderResult> {
  return invoke<ScreenRecorderResult>('finalize_recovered_screen_recording', { sessionId });
}

export async function prepareScreenRecorderDependencies(): Promise<RecorderDependencyStatus> {
  return invoke<RecorderDependencyStatus>('prepare_screen_recorder_dependencies');
}

export async function getScreenRecorderDependencyStatus(): Promise<RecorderDependencyStatus> {
  return invoke<RecorderDependencyStatus>('screen_recorder_dependency_status');
}
