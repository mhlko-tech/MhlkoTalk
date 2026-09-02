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
export type RtcProviderId = TargetRtcProviderId | "daily";

export const knownRtcProviders: readonly RtcProviderId[] = [
  ...targetRtcProviders,
  "daily",
];

export function isRtcProvider(value: unknown): value is RtcProviderId {
  return knownRtcProviders.includes(
    String(value).trim().toLowerCase() as RtcProviderId,
  );
}
