import { invoke } from "@tauri-apps/api/core";

export type RecordingSettings = {
  quality: "high" | "balanced" | "performance" | "lossless";
  fps: 30 | 60 | 120;
  includeAudio: boolean;
  includeMic: boolean;
  systemVolume: number;
  micVolume: number;
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

export const getNativeRecordingStatus = () =>
  invoke<NativeRecordingStatus>("native_recording_status");

export const getNativeRecordingProcessingStatus = () =>
  invoke<NativeRecordingProcessingStatus>("native_recording_processing_status");

export class NativeScreenRecording {
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentOutput: GainNode | null = null;
  private systemGain: GainNode | null = null;
  private microphoneGain: GainNode | null = null;
  private microphoneStream: MediaStream | null = null;
  private writes = Promise.resolve();
  private started = false;

  async start(
    settings: RecordingSettings,
    display: MediaStream,
  ) {
    if (this.started) throw new Error("Recording is already active.");
    const hasAudio =
      (settings.includeAudio && display.getAudioTracks().length > 0) ||
      settings.includeMic;
    if (hasAudio) await this.prepareAudio(settings, display);
    try {
      const status = await invoke<NativeRecordingStatus>(
        "start_native_recording",
        {
          settings: nativeSourceSettings(settings, display, hasAudio),
        },
      );
      this.started = status.active;
      return status;
    } catch (error) {
      this.cleanupAudio();
      throw error;
    }
  }

  async switchSource(
    settings: RecordingSettings,
    display: MediaStream,
  ) {
    if (!this.started) throw new Error("Recording is not active.");
    const hasAudio = Boolean(this.processor);
    return invoke<NativeRecordingStatus>("switch_native_recording_source", {
      settings: nativeSourceSettings(settings, display, hasAudio),
    });
  }

  updateMix(settings: RecordingSettings) {
    if (this.systemGain)
      this.systemGain.gain.value = settings.includeAudio
        ? Math.max(0, Math.min(2, settings.systemVolume))
        : 0;
    if (this.microphoneGain)
      this.microphoneGain.gain.value = settings.includeMic
        ? Math.max(0, Math.min(2, settings.micVolume))
        : 0;
  }

  status() {
    return getNativeRecordingStatus();
  }

  async stop() {
    if (!this.started) return null;
    this.processor?.disconnect();
    this.processor = null;
    await this.writes.catch(() => undefined);
    const result = await invoke<NativeRecordingResult>("stop_native_recording");
    this.started = false;
    this.cleanupAudio();
    return result;
  }

  private async prepareAudio(
    settings: RecordingSettings,
    display: MediaStream,
  ) {
    const context = new AudioContext({ sampleRate: 48_000 });
    const processor = context.createScriptProcessor(4096, 2, 2);
    if (settings.includeAudio && display.getAudioTracks().length) {
      const gain = context.createGain();
      gain.gain.value = Math.max(0, Math.min(2, settings.systemVolume));
      context.createMediaStreamSource(display).connect(gain).connect(processor);
      this.systemGain = gain;
    }
    if (settings.includeMic) {
      this.microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48_000,
        },
      });
      const gain = context.createGain();
      gain.gain.value = Math.max(0, Math.min(2, settings.micVolume));
      context
        .createMediaStreamSource(this.microphoneStream)
        .connect(gain)
        .connect(processor);
      this.microphoneGain = gain;
    }
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    processor.connect(silentOutput).connect(context.destination);
    processor.onaudioprocess = (event) => {
      const left = event.inputBuffer.getChannelData(0);
      const right =
        event.inputBuffer.numberOfChannels > 1
          ? event.inputBuffer.getChannelData(1)
          : left;
      const samples = new Array<number>(left.length * 2);
      for (let index = 0; index < left.length; index += 1) {
        samples[index * 2] = floatToInt16(left[index]);
        samples[index * 2 + 1] = floatToInt16(right[index]);
      }
      this.writes = this.writes.then(() =>
        invoke("append_native_recording_audio", { samples }),
      );
    };
    this.context = context;
    this.processor = processor;
    this.silentOutput = silentOutput;
  }

  private cleanupAudio() {
    this.processor?.disconnect();
    this.silentOutput?.disconnect();
    this.systemGain?.disconnect();
    this.microphoneGain?.disconnect();
    this.microphoneStream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.context = null;
    this.processor = null;
    this.silentOutput = null;
    this.systemGain = null;
    this.microphoneGain = null;
    this.microphoneStream = null;
    this.writes = Promise.resolve();
  }
}

function floatToInt16(value: number) {
  const limited = Math.max(-1, Math.min(1, value));
  return Math.round(limited < 0 ? limited * 32768 : limited * 32767);
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
  return {
    fps: settings.fps,
    quality: settings.quality,
    hasAudio,
    sourceKind,
    sourceLabel: video.label,
    outputIndex: screenMatch ? Number(screenMatch[1]) : 0,
    outputWidth,
    outputHeight,
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
