import { invoke } from "@tauri-apps/api/core";
import { isPaidSubscriptionValue, limitRecordingDimensions } from "../core/subscription";

export type RecordingSettings = {
  quality: "high" | "balanced" | "performance" | "lossless";
  fps: 30 | 60 | 120;
  includeAudio: boolean;
  includeMic: boolean;
  systemVolume: number;
  micVolume: number;
  noiseCancellation: boolean;
};

export type RecorderCapabilities = {
  ready: boolean;
  encoder: string;
  recordingsFolder: string;
  message: string;
};

export type NativeRecordingStatus = {
  active: boolean;
  elapsedMs: number;
  bytes: number;
  path?: string;
  encoder?: string;
};

export type NativeRecordingResult = {
  path: string;
  size: number;
  encoder: string;
};

export type NativeRecordingProcessingStatus = {
  active: boolean;
  progress: number;
  estimatedRemainingMs: number | null;
};

type NativeRecordingAudioStatus = {
  systemLevel: number;
  microphoneLevel: number;
  systemDiscontinuities: number;
  microphoneDiscontinuities: number;
  systemUnderruns: number;
  microphoneUnderruns: number;
  writerErrors: number;
};

export const getNativeRecordingStatus = () =>
  invoke<NativeRecordingStatus>("native_recording_status");

export const getNativeRecordingProcessingStatus = () =>
  invoke<NativeRecordingProcessingStatus>("native_recording_processing_status");

export class NativeScreenRecording {
  private started = false;
  private hasAudio = false;
  private levels = { system: 0, microphone: 0 };
  private readingLevels = false;

  async start(
    settings: RecordingSettings,
    display: MediaStream,
  ) {
    if (this.started) throw new Error("Recording is already active.");
    const hasAudio = settings.includeAudio || settings.includeMic;
    try {
      const status = await invoke<NativeRecordingStatus>(
        "start_native_recording",
        {
          settings: nativeSourceSettings(settings, display, hasAudio),
        },
      );
      this.started = status.active;
      this.hasAudio = hasAudio;
      return status;
    } catch (error) {
      throw error;
    }
  }

  async switchSource(
    settings: RecordingSettings,
    display: MediaStream,
  ) {
    if (!this.started) throw new Error("Recording is not active.");
    return invoke<NativeRecordingStatus>("switch_native_recording_source", {
      settings: nativeSourceSettings(settings, display, this.hasAudio),
    });
  }

  updateMix(settings: RecordingSettings) {
    if (!this.started || !this.hasAudio) return;
    void invoke<void>("update_native_recording_mix", {
      settings: nativeMixSettings(settings),
    }).catch(() => undefined);
  }

  getMixLevels() {
    if (this.started && this.hasAudio && !this.readingLevels) {
      this.readingLevels = true;
      void invoke<NativeRecordingAudioStatus>("native_recording_audio_status")
        .then((status) => {
          this.levels = {
            system: Math.round(status.systemLevel * 100),
            microphone: Math.round(status.microphoneLevel * 100),
          };
        })
        .finally(() => {
          this.readingLevels = false;
        });
    }
    return this.levels;
  }

  status() {
    return getNativeRecordingStatus();
  }

  async stop() {
    if (!this.started) return null;
    const result = await invoke<NativeRecordingResult>("stop_native_recording");
    this.started = false;
    this.hasAudio = false;
    this.levels = { system: 0, microphone: 0 };
    return result;
  }
}

function nativeMixSettings(settings: RecordingSettings) {
  return {
    includeSystemAudio: settings.includeAudio,
    includeMicrophone: settings.includeMic,
    systemVolume: Math.max(0, Math.min(2, settings.systemVolume)),
    microphoneVolume: Math.max(0, Math.min(2, settings.micVolume)),
    noiseCancellation: settings.noiseCancellation,
  };
}

function nativeSourceSettings(
  settings: RecordingSettings,
  display: MediaStream,
  hasAudio: boolean,
) {
  const video = display.getVideoTracks()[0];
  if (!video) throw new Error("Choose a display or window first.");
  const displaySettings = video.getSettings();
  const sourceKind = displaySettings.displaySurface || "monitor";
  const screenMatch = video.label.match(/screen:(\d+):/i);
  const outputWidth = displaySettings.width || window.screen.width || 1920;
  const outputHeight = displaySettings.height || window.screen.height || 1080;
  const [limitedWidth, limitedHeight] = limitRecordingDimensions(
    outputWidth,
    outputHeight,
    isPaidSubscriptionValue(localStorage.getItem("mhtalk.subscription-tier")),
  );
  return {
    fps: isPaidSubscriptionValue(localStorage.getItem("mhtalk.subscription-tier"))
      ? settings.fps
      : Math.min(settings.fps, 60),
    quality: settings.quality,
    hasAudio,
    ...nativeMixSettings(settings),
    sourceKind,
    sourceLabel: video.label,
    outputIndex: screenMatch ? Number(screenMatch[1]) : 0,
    outputWidth: limitedWidth,
    outputHeight: limitedHeight,
  };
}


let capabilitiesRequest: Promise<RecorderCapabilities> | null = null;

export const getRecorderCapabilities = () => {
  if (!capabilitiesRequest)
    capabilitiesRequest = invoke<RecorderCapabilities>("recorder_capabilities");
  const request = capabilitiesRequest;
  const releaseRequest = () => {
    if (capabilitiesRequest === request) capabilitiesRequest = null;
  };
  void request.then(releaseRequest, releaseRequest);
  return request;
};

export const openRecordingsFolder = () =>
  invoke<string>("open_native_recordings_folder");
