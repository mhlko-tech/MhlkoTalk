import type { MediaQuality } from "./types";

export const mediaQualityLabels: Record<MediaQuality, string> = {
  low: "Low · 360p",
  medium: "Medium · 720p",
  high: "High · 1080p",
};

export const mediaQualityOrder: MediaQuality[] = ["low", "medium", "high"];

export function availableQualities(maximum: MediaQuality) {
  const maximumIndex = mediaQualityOrder.indexOf(maximum);
  return mediaQualityOrder.slice(0, maximumIndex + 1);
}
