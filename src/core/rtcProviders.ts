export const targetRtcProviders = [
  "stream",
  "agora",
  "tencent",
  "cloudflare-realtime",
  "livekit",
  "100ms",
  "cometchat",
  "whereby",
  "jaas",
  "vonage",
  "videosdk",
] as const;

export type TargetRtcProviderId = (typeof targetRtcProviders)[number];
export type LegacyRtcProviderId = "daily";
export type RtcProviderId = TargetRtcProviderId | LegacyRtcProviderId;

const knownRtcProviders = new Set<string>([
  ...targetRtcProviders,
  "daily",
]);

export function isRtcProvider(value: unknown): value is RtcProviderId {
  return typeof value === "string" && knownRtcProviders.has(value);
}
