export const targetRtcProviders = [
  "stream",
  "agora",
  "tencent",
  "cloudflare-realtime",
  "livekit",
  "whereby",
  "jaas",
  "mirotalk",
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

const embeddedRtcProviders = new Set<RtcProviderId>([
  "whereby",
  "jaas",
  "mirotalk",
  "daily",
]);

export function isEmbeddedRtcProvider(value: unknown): value is RtcProviderId {
  return isRtcProvider(value) && embeddedRtcProviders.has(value);
}
