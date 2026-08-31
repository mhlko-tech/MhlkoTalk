import type { RtcProviderId } from "./rtcProviderCatalog";

export function monthlyUsageCycle(value: Date) {
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
  const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export function usageAmount(provider: RtcProviderId, seconds: number) {
  const billedMinutes = Math.max(1, Math.ceil(seconds / 60));
  // Stream's app is capped at 1080p. Charging the internal guard at the
  // published 4K ceiling ($12/1,000 participant minutes) keeps a wide buffer.
  if (provider === "stream") return billedMinutes * 12_000;
  if (["agora", "tencent", "whereby", "livekit"].includes(provider)) return billedMinutes;
  // Cloudflare egress is metered by its Durable Object. Daily has no managed
  // quota policy yet, so neither provider accepts client-estimated usage here.
  return null;
}
