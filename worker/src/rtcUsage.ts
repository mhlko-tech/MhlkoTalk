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
  // MiroTalk is self-hosted on an Always Free Oracle instance, so it has no
  // metered vendor allowance or paid overage to debit here.
  if (provider === "mirotalk") return null;
  // Cloudflare egress is metered by its Durable Object. JaaS is guarded by
  // unique MAU, so client seconds are not converted to those units. Legacy
  // Daily has no managed quota policy.
  return null;
}
