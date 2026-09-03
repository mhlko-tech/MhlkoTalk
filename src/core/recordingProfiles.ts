export type RecordingFrameRate = 30 | 60 | 120;

export type RecordingResolutionOption = {
  targetHeight: number;
  width: number;
  height: number;
  requiresPlus: boolean;
};

export type RecordingPowerSupport = {
  maxHeight: 480 | 720 | 1080 | 1440 | 2160;
  maxFps: RecordingFrameRate;
};

const standardHeights = [480, 720, 1080, 1440, 2160] as const;
const standardWidths: Record<number, number> = {
  480: 854,
  720: 1280,
  1080: 1920,
  1440: 2560,
  2160: 3840,
};
const hardwareEncoders = new Set(["h264_nvenc", "h264_qsv", "h264_amf"]);

const evenDimension = (value: number) => {
  const rounded = Math.max(2, Math.floor(value));
  return rounded - (rounded % 2);
};

export function recordingPowerSupport(
  encoder: string,
  logicalCores: number,
): RecordingPowerSupport {
  const cores = Math.max(1, Math.floor(logicalCores || 1));
  if (hardwareEncoders.has(encoder)) {
    if (cores >= 8) return { maxHeight: 2160, maxFps: 120 };
    if (cores >= 4) return { maxHeight: 1440, maxFps: 60 };
    return { maxHeight: 1080, maxFps: 30 };
  }
  if (cores >= 12) return { maxHeight: 1440, maxFps: 60 };
  if (cores >= 8) return { maxHeight: 1080, maxFps: 60 };
  if (cores >= 4) return { maxHeight: 720, maxFps: 30 };
  return { maxHeight: 480, maxFps: 30 };
}

export function recordingDimensions(
  sourceWidth: number,
  sourceHeight: number,
  targetHeight: number,
): [number, number] {
  const width = Math.max(2, sourceWidth || 1920);
  const height = Math.max(2, sourceHeight || 1080);
  if (targetHeight >= Math.min(width, height)) {
    return [evenDimension(width), evenDimension(height)];
  }
  const landscape = width >= height;
  const maximumShortEdge = Math.max(2, targetHeight);
  const maximumLongEdge =
    standardWidths[targetHeight] || Math.round(maximumShortEdge * (16 / 9));
  const maximumWidth = landscape ? maximumLongEdge : maximumShortEdge;
  const maximumHeight = landscape ? maximumShortEdge : maximumLongEdge;
  if (width >= maximumWidth && height >= maximumHeight) {
    return [evenDimension(maximumWidth), evenDimension(maximumHeight)];
  }
  const scale = Math.min(1, maximumWidth / width, maximumHeight / height);
  return [evenDimension(width * scale), evenDimension(height * scale)];
}

export function availableRecordingResolutions(
  sourceWidth: number,
  sourceHeight: number,
  maximumHeight: RecordingPowerSupport["maxHeight"],
): RecordingResolutionOption[] {
  const sourceShortEdge = Math.max(
    2,
    Math.round(Math.min(sourceWidth || 1920, sourceHeight || 1080)),
  );
  const targets = standardHeights.filter(
    (height) => height <= maximumHeight && height <= sourceShortEdge,
  ) as number[];
  const sourceTarget = Math.min(sourceShortEdge, maximumHeight);
  if (!targets.includes(sourceTarget)) targets.push(sourceTarget);
  targets.sort((left, right) => left - right);

  const seen = new Set<string>();
  return targets.flatMap((targetHeight) => {
    const [width, height] = recordingDimensions(
      sourceWidth,
      sourceHeight,
      targetHeight,
    );
    const key = `${width}x${height}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      targetHeight,
      width,
      height,
      requiresPlus: targetHeight > 720,
    }];
  });
}

export function availableRecordingFrameRates(
  maximumFps: RecordingFrameRate,
): RecordingFrameRate[] {
  return ([30, 60, 120] as const).filter((fps) => fps <= maximumFps);
}
