import type { ScreenRecorderResolution } from '../types/models';

export const RECORDER_RESOLUTIONS: ReadonlyArray<{ value: Exclude<ScreenRecorderResolution, 'auto'>; longEdge: number }> = [
  { value: '4k', longEdge: 3840 },
  { value: '1440p', longEdge: 2560 },
  { value: '1080p', longEdge: 1920 },
  { value: '720p', longEdge: 1280 },
  { value: '480p', longEdge: 854 }
];

export function supportedRecorderResolutions(sourceWidth: number, sourceHeight: number): ScreenRecorderResolution[] {
  const sourceLongEdge = Math.max(1, Math.round(sourceWidth), Math.round(sourceHeight));
  return ['auto', ...RECORDER_RESOLUTIONS.filter((item) => item.longEdge <= sourceLongEdge).map((item) => item.value)];
}

export function recorderTargetLongEdge(
  requested: ScreenRecorderResolution,
  sourceWidth: number,
  sourceHeight: number,
  hardwareConcurrency: number,
  lowPcMode: boolean
): number {
  const sourceLongEdge = Math.max(1, Math.round(sourceWidth), Math.round(sourceHeight));
  if (requested !== 'auto') {
    return Math.min(sourceLongEdge, RECORDER_RESOLUTIONS.find((item) => item.value === requested)?.longEdge || sourceLongEdge);
  }
  const cores = Math.max(2, Math.round(hardwareConcurrency || 4));
  const automaticLimit = lowPcMode || cores <= 4 ? 1280 : cores <= 8 ? 1920 : cores <= 12 ? 2560 : 3840;
  return Math.min(sourceLongEdge, automaticLimit);
}
