export type RtcPressureLevel = 'normal' | 'pressure' | 'severe';

export interface RtcPressureMetrics {
  rttMs?: number;
  jitterMs?: number;
  packetLossPct?: number;
  availableOutgoingKbps?: number;
  totalPacketSendDelayMs?: number;
  jitterBufferMs?: number;
  eventLoopLagMs?: number;
  fileBufferedBytes?: number;
}

export interface MediaBudget {
  voiceBitrate: number;
  screenBitrate: number;
  screenFps: number;
  screenScaleDown: number;
  cameraBitrate: number;
  cameraFps: number;
  cameraScaleDown: number;
  fileHighWater: number;
  fileChunkDelayMs: number;
}

export function classifyRtcPressure(metrics: RtcPressureMetrics): RtcPressureLevel {
  const rtt = metrics.rttMs ?? 0;
  const jitter = metrics.jitterMs ?? 0;
  const loss = metrics.packetLossPct ?? 0;
  const available = metrics.availableOutgoingKbps ?? Number.POSITIVE_INFINITY;
  const sendDelay = metrics.totalPacketSendDelayMs ?? 0;
  const jitterBuffer = metrics.jitterBufferMs ?? 0;
  const loopLag = metrics.eventLoopLagMs ?? 0;
  const fileBuffered = metrics.fileBufferedBytes ?? 0;

  if (
    rtt >= 400 || loss >= 10 || jitter >= 60 || available < 128 ||
    sendDelay >= 250 || jitterBuffer >= 450 || loopLag >= 180 || fileBuffered >= 8 * 1024 * 1024
  ) return 'severe';

  if (
    rtt >= 250 || loss >= 5 || jitter >= 30 || available < 384 ||
    sendDelay >= 100 || jitterBuffer >= 250 || loopLag >= 80 || fileBuffered >= 2 * 1024 * 1024
  ) return 'pressure';

  return 'normal';
}

export function mediaBudgetFor(level: RtcPressureLevel, requestedScreenBitrate: number, requestedScreenFps: number, activePeerCount = 1): MediaBudget {
  const peers = Math.max(1, Math.floor(activePeerCount || 1));
  const scaleSharedUplink = (bitrate: number, floor: number) => Math.max(floor, Math.floor(bitrate / peers));
  const scaleQueue = (bytes: number) => Math.max(64 * 1024, Math.floor(bytes / peers));
  if (level === 'severe') {
    return {
      voiceBitrate: 18_000,
      screenBitrate: scaleSharedUplink(Math.min(requestedScreenBitrate, 700_000), 160_000),
      screenFps: Math.min(requestedScreenFps, 8),
      screenScaleDown: 2.5,
      cameraBitrate: scaleSharedUplink(140_000, 60_000),
      cameraFps: 8,
      cameraScaleDown: 2.5,
      fileHighWater: scaleQueue(96 * 1024),
      fileChunkDelayMs: 120 + Math.min(120, (peers - 1) * 20)
    };
  }
  if (level === 'pressure') {
    return {
      voiceBitrate: 24_000,
      screenBitrate: scaleSharedUplink(Math.min(requestedScreenBitrate, 1_600_000), 320_000),
      screenFps: Math.min(requestedScreenFps, 15),
      screenScaleDown: 1.5,
      cameraBitrate: scaleSharedUplink(260_000, 90_000),
      cameraFps: 12,
      cameraScaleDown: 1.6,
      fileHighWater: scaleQueue(384 * 1024),
      fileChunkDelayMs: 35 + Math.min(80, (peers - 1) * 12)
    };
  }
  return {
    voiceBitrate: 32_000,
    screenBitrate: scaleSharedUplink(requestedScreenBitrate, 700_000),
    screenFps: requestedScreenFps,
    screenScaleDown: 1,
    cameraBitrate: scaleSharedUplink(600_000, 160_000),
    cameraFps: 24,
    cameraScaleDown: 1,
    fileHighWater: scaleQueue(1 * 1024 * 1024),
    fileChunkDelayMs: peers > 1 ? Math.min(40, (peers - 1) * 6) : 0
  };
}
